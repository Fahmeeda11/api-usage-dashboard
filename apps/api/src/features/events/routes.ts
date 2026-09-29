/**
 * Ingest, the raw-event feed, and the SSE live tail.
 *
 * Three endpoints with three different auth postures, which is the point:
 *
 *   POST /v1/events   API key, scope "ingest"   - machines, high volume
 *   GET  /events      user session              - the dashboard table
 *   GET  /events/live user session              - the dashboard live tail
 */

import { Router } from 'express';
import { Types } from 'mongoose';
import {
  eventsQuerySchema,
  ingestBatchSchema,
  liveTailChannel,
  usdToMicros,
  type EventsQuery,
  type UsageEvent as UsageEventDTO,
} from '@usage/shared';
import { UsageEvent, type UsageEventDoc } from '@usage/db';
import { validateBody, validateQuery, parsedQuery } from '../../middleware/validate.js';
import { requireAuth, currentUserId } from '../../middleware/auth.js';
import { unauthorized } from '../../lib/errors.js';
import { requireApiKey, apiKeyId, apiKeyUserId } from '../../middleware/apiKey.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import crypto from 'node:crypto';
import { getRedis, createSubscriber } from '../../lib/redis.js';
import { requestRollupsFor } from '../../lib/queue.js';
import { childLogger } from '../../lib/logger.js';
import { badRequest } from '../../lib/errors.js';

const log = childLogger('events');

function toDTO(doc: UsageEventDoc): UsageEventDTO {
  return {
    id: String(doc._id),
    project: doc.project,
    provider: doc.provider,
    model: doc.model,
    promptTokens: doc.promptTokens,
    completionTokens: doc.completionTokens,
    costMicros: doc.costMicros,
    latencyMs: doc.latencyMs,
    status: doc.status as UsageEventDTO['status'],
    metadata: (doc.metadata as Record<string, unknown> | undefined) ?? undefined,
    occurredAt: doc.occurredAt,
  };
}

/* ========================================================================== */
/* Ingest                                                                     */
/* ========================================================================== */

export const ingestRouter = Router();

/**
 * Order matters: authenticate first, THEN rate limit.
 *
 * The limiter buckets by API key, so it needs the key resolved to know whose
 * budget to spend. Limiting before auth would bucket by IP and let one
 * misbehaving customer behind a shared NAT throttle everyone else on it.
 */
ingestRouter.post(
  '/events',
  requireApiKey('ingest'),
  rateLimit(),
  validateBody(ingestBatchSchema),
  async (req, res) => {
    const { events } = req.body as typeof ingestBatchSchema._output;
    const userId = apiKeyUserId(req);
    const keyId = apiKeyId(req);
    const receivedAt = new Date();

    /**
     * Reject events dated too far in the future.
     *
     * A client with a badly-skewed clock can otherwise write events into buckets
     * that will not be rolled up until that time actually arrives - producing a
     * dashboard that shows spend which has not happened yet, and a chart that
     * silently rewrites itself later. Small clock skew is normal; a day is a bug.
     */
    const maxFuture = receivedAt.getTime() + 60 * 60_000;
    const docs = events.map((event) => {
      const occurredAt = event.occurredAt ?? receivedAt;
      if (occurredAt.getTime() > maxFuture) {
        throw badRequest('An event is dated more than an hour in the future - check your clock');
      }

      return {
        userId,
        keyId,
        project: event.project,
        provider: event.provider,
        model: event.model,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        // Decimal in, integer out. See domain.ts for why storage is integer.
        costMicros: usdToMicros(event.costUsd),
        latencyMs: event.latencyMs,
        status: event.status,
        metadata: event.metadata,
        occurredAt,
      };
    });

    /**
     * One insertMany rather than N inserts. `ordered: false` lets the driver
     * keep going past a single bad document instead of abandoning the rest of
     * the batch - for telemetry, salvaging 499 of 500 events beats rejecting
     * all of them because one had a problem.
     */
    const inserted = await UsageEvent.insertMany(docs, { ordered: false });

    // Respond before the bookkeeping. The client is waiting, and neither the
    // rollup request nor the live-tail publish affects whether the write
    // succeeded - it has already happened.
    res.status(202).json({ accepted: inserted.length });

    /* -------------------------------------------------------------------- */

    // Queue a rollup for each distinct bucket the batch touched. Deduplicated
    // by the queue's deterministic job id, so a burst enqueues one job.
    const buckets = new Set(docs.map((d) => d.occurredAt.toISOString().slice(0, 13)));
    for (const bucket of buckets) {
      void requestRollupsFor(new Date(`${bucket}:00:00.000Z`));
    }

    // Fan out to any open live tails. Fire-and-forget: a dashboard nobody has
    // open must not slow down ingest.
    void publishToLiveTail(String(userId), inserted.map(toDTO)).catch((err) =>
      log.warn({ err }, 'live tail publish failed'),
    );
  },
);

async function publishToLiveTail(userId: string, events: UsageEventDTO[]): Promise<void> {
  if (events.length === 0) return;
  // Cap the payload: a 500-event batch does not need to arrive as one enormous
  // message, and the tail is a sample of recent activity, not a complete log.
  const sample = events.slice(0, 20);
  await getRedis().publish(liveTailChannel(userId), JSON.stringify(sample));
}

/* ========================================================================== */
/* Dashboard reads                                                            */
/* ========================================================================== */

export const eventsRouter = Router();

eventsRouter.use(requireAuth);

/**
 * The raw-event table, cursor-paginated.
 *
 * Cursor rather than offset. `skip(10000)` makes Mongo walk and discard ten
 * thousand documents on every page, so pagination gets slower the deeper you
 * go - and if new events arrive mid-scroll (which, on a live feed, they
 * constantly do) offsets shift and rows are duplicated or skipped. A cursor
 * anchored to the last id is stable and O(1) regardless of depth.
 */
eventsRouter.get('/', validateQuery(eventsQuerySchema), async (req, res) => {
  const query = parsedQuery<EventsQuery>(res);
  const userId = new Types.ObjectId(currentUserId(req));

  const filter: Record<string, unknown> = { userId };
  if (query.project) filter['project'] = query.project;
  if (query.model) filter['model'] = query.model;
  if (query.status) filter['status'] = query.status;

  if (query.cursor) {
    if (!Types.ObjectId.isValid(query.cursor)) {
      throw badRequest('Invalid cursor');
    }
    // ObjectIds are monotonically increasing by creation time, so "_id less
    // than the last one seen" is a correct and index-friendly "next page".
    filter['_id'] = { $lt: new Types.ObjectId(query.cursor) };
  }

  // Fetch one extra to discover whether another page exists, without a count().
  const docs = await UsageEvent.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);

  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;

  res.json({
    events: page.map(toDTO),
    nextCursor: hasMore ? String(page[page.length - 1]?._id) : null,
  });
});

/* -------------------------------------------------------------------------- */

/**
 * A single-use, 60-second ticket that authorises one live-tail connection.
 *
 * EventSource cannot set request headers, so it cannot carry the bearer access
 * token the rest of the API uses. The usual workarounds are both bad: putting
 * the access token in the query string leaks a live credential into proxy logs
 * and Referer headers, and falling back to the refresh cookie would rotate the
 * session on every reconnect.
 *
 * So the client exchanges its bearer token - over a normal authenticated
 * request, where headers work fine - for a ticket that is random, single-use,
 * expires in a minute, and grants nothing except the right to open one stream.
 * Leaking it costs almost nothing.
 */
const TICKET_TTL_SECONDS = 60;

eventsRouter.post('/live-ticket', async (req, res) => {
  const userId = currentUserId(req);
  const ticket = crypto.randomBytes(24).toString('base64url');

  await getRedis().set(`sse-ticket:${ticket}`, userId, 'EX', TICKET_TTL_SECONDS);

  res.json({ ticket, expiresIn: TICKET_TTL_SECONDS });
});

/**
 * Live tail over Server-Sent Events.
 *
 * SSE rather than WebSockets, deliberately. The traffic here is one-directional
 * - the server pushes, the client only listens - and SSE gives that over plain
 * HTTP with automatic browser reconnection built in. A WebSocket would mean a
 * second protocol, its own auth handshake, and hand-rolled reconnect logic, in
 * exchange for a bidirectional channel nothing here needs.
 */
/**
 * Mounted BEFORE the router-level requireAuth would apply, because this route
 * authenticates with a ticket rather than a bearer token. GETDEL makes the
 * ticket single-use: redeeming it atomically removes it, so a ticket captured
 * from a log cannot be replayed.
 */
export const liveTailRouter = Router();

liveTailRouter.get('/live', async (req, res, next) => {
  const ticket = typeof req.query['ticket'] === 'string' ? req.query['ticket'] : null;

  if (!ticket) {
    next(unauthorized('A stream ticket is required'));
    return;
  }

  const userId = await getRedis().getdel(`sse-ticket:${ticket}`);

  if (!userId) {
    next(unauthorized('Stream ticket is invalid or expired'));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx not to buffer the stream. Without it a reverse proxy happily
    // holds events until its buffer fills, and the "live" tail arrives in
    // clumps minutes late.
    'X-Accel-Buffering': 'no',
  });

  res.write('retry: 3000\n\n');
  res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  // Each stream gets its OWN connection: a Redis client in subscriber mode
  // accepts nothing but subscribe/unsubscribe, so it cannot be shared with the
  // one serving cache reads.
  const subscriber = createSubscriber();
  const channel = liveTailChannel(userId);

  await subscriber.subscribe(channel);

  subscriber.on('message', (_channel, payload) => {
    // Writable check guards the window between the client vanishing and the
    // close handler firing - writing to a dead socket throws.
    if (!res.writableEnded) {
      res.write(`event: events\ndata: ${payload}\n\n`);
    }
  });

  /**
   * Heartbeat. Idle connections get reaped by proxies and load balancers after
   * 30-60s, and a comment line is the cheapest possible keep-alive - the
   * EventSource spec requires clients to ignore it, so it costs the client
   * nothing.
   */
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 20_000);

  // Clean up on disconnect. Without this, every closed tab leaks a Redis
  // connection and an interval, and the process runs out of file descriptors
  // after a few hundred page loads.
  req.on('close', () => {
    clearInterval(heartbeat);
    void subscriber.unsubscribe(channel).catch(() => {});
    subscriber.disconnect();
    res.end();
    log.debug({ userId }, 'live tail disconnected');
  });
});
