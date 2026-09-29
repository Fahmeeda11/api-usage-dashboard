# API Usage Dashboard

Track what your LLM calls actually cost. An ingest endpoint your projects POST events to,
and a dashboard showing spend, latency and errors — with a live tail.

Built as a MERN learning project, so the interesting parts are the ones tutorials skip:
**API-key auth as a second auth surface**, a **sliding-window rate limiter in Lua**,
**pre-aggregated rollups** that keep reads fast, **Redis caching with explicit invalidation**,
and a **Server-Sent Events** live tail.

```
apps/api        Express 5 — ingest, metrics, keys, SSE
apps/worker     BullMQ consumer — rollup aggregations
apps/web        React 19 + Vite + TanStack Query — the dashboard
packages/shared zod schemas + domain constants, used by client AND server
packages/db     Mongoose models + the rollup aggregation
examples/       drop-in TypeScript and Python ingest clients
```

It shares its foundation — workspaces layout, zod-validated env, session auth with refresh
rotation — with [job-tracker](https://github.com/Fahmeeda11/job-tracker), built from the same core.

---

## Running it

Needs Node 20+ and Docker.

```bash
git clone https://github.com/Fahmeeda11/api-usage-dashboard.git
cd api-usage-dashboard
npm install

cp .env.example .env
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
# Paste both into .env

npm run db:up                 # Mongo + Redis
npm run seed -- --rollup      # a week of realistic traffic, rollups computed inline
npm run dev                   # api :4001, web :5174, worker
```

Open http://localhost:5174. The seed prints demo credentials and an ingest key.

```bash
npm test         # 79 tests (+2 that need Redis)
npm run typecheck
npm run lint
npm run build
```

---

## Sending events

```bash
curl -X POST http://localhost:4001/v1/events \
  -H "Authorization: Bearer usg_your_key" \
  -H "Content-Type: application/json" \
  -d '{"events":[{
    "project":"production-rag-system",
    "provider":"anthropic",
    "model":"claude-opus-5",
    "promptTokens":1500,
    "completionTokens":300,
    "costUsd":0.0234,
    "latencyMs":1850,
    "status":"ok"
  }]}'
```

`examples/client.ts` and `examples/client.py` are drop-in buffered clients. Both follow the
two rules that matter for telemetry: **buffer** (one request per LLM call doubles your request
count and adds the tracker's latency to every call) and **never throw** (telemetry that breaks
the thing it measures is worse than no telemetry).

---

## The five ideas worth reading

### 1. API keys as a separate auth surface — `middleware/apiKey.ts`

Most tutorials have one kind of credential. This has two, because they have genuinely different
requirements:

| User session | API key |
|---|---|
| Short-lived, rotating | Long-lived, static |
| Belongs to a browser | Belongs to a script |
| Interactive re-auth | No human to re-authenticate |
| Cookie + JWT | Bearer secret in a header |

Serving a background job with a 15-minute rotating token means the job needs a login flow, which
it cannot have. So keys get their own storage, middleware and revocation — and an API key
**cannot mint another key**, which would turn one leaked credential into permanent self-renewing
access.

Keys are stored as **SHA-256**. That's right here even though it's wrong for passwords: the
secret is 256 bits of CSPRNG output, so there's no dictionary to attack, and it's verified on
every ingest request where a deliberately-slow KDF would be a self-inflicted rate limit. The
plaintext is returned exactly once — there is no endpoint that can show it again, which is the
point: a system that can show you your key is one where a database dump hands over every key.

### 2. Sliding-window rate limiting — `middleware/rateLimit.ts`

The naive limiter is `INCR` on a key named for the current minute. One command, and wrong at the
boundary: a caller limited to 600/min can send 600 at 10:00:59 and another 600 at 10:01:00 —
1200 requests in two seconds, limit nominally enforced, server on fire.

A sliding window counts requests in the trailing N milliseconds regardless of clock boundaries,
using a Redis sorted set: each request is a member scored by timestamp, old entries are trimmed,
the remaining cardinality is the count.

**It has to be a Lua script.** Trim, count, add and expire must be atomic — issued as four
commands, two callers interleave between the count and the add and both conclude they're under
the limit, which is the exact race the limiter exists to prevent. A `MULTI` pipeline won't do
either: it batches commands but can't branch on an intermediate result.

It **fails open**. If Redis is down, dropping customers' telemetry is worse than briefly serving
traffic unthrottled. A limiter in front of something destructive should fail closed — the right
answer depends on what's behind it.

### 3. Rollups — `packages/db/src/rollups.ts`

The dashboard's default view is "last 7 days, by hour, broken down by model". Computing that from
raw events scans every event in the range on every page load — fine at a thousand events an hour,
a multi-second query at a million, and it gets slower exactly as the product succeeds.

So the read path **never touches raw events**. A background job folds them into buckets, and the
dashboard reads buckets: query cost scales with *time range*, not with traffic volume.

The job uses **`$set`, never `$inc`**:

```
$inc  → "add these 40 requests to the bucket"  → rerun doubles it
$set  → "this bucket contains 40 requests"     → rerun writes 40 again
```

It re-runs constantly — scheduled, on ingest, on retry — so it must converge, not accumulate.
Same principle as the reminder handler in job-tracker: make the operation safe to repeat rather
than trying to guarantee it happens once.

**Percentiles get an honest caveat.** Sums aggregate; percentiles don't. The p95 of a day is not
any function of the p95s of its hours. Each granularity computes its own from raw events, and
where the dashboard must combine buckets it takes the max — an upper bound, labelled approximate,
which at least never *under*-reports tail latency.

### 4. Caching with explicit invalidation — `lib/redis.ts`

Metrics responses are cached in Redis for 60s, keyed by the exact query **and namespaced by
user** — a cache key that forgets the tenant is a data leak with a very long tail.

The TTL is only the backstop. When the worker rebuilds rollups it **explicitly invalidates** the
affected users' keys, so someone who just sent events and opens the dashboard sees them rather
than a 50-second-old response.

Invalidation uses **SCAN, never KEYS**. `KEYS` blocks the entire Redis server while it walks the
keyspace — a multi-second stall for every client on a large instance.

### 5. Server-Sent Events, and the ticket — `features/events/routes.ts`

SSE rather than WebSockets: the traffic is one-directional, and SSE gives that over plain HTTP
with browser reconnection built in. A WebSocket would mean a second protocol, its own auth
handshake, and hand-rolled reconnect logic for a bidirectional channel nothing needs.

But **`EventSource` cannot set request headers**, so it can't carry the bearer token. Both usual
workarounds are bad: the access token in a query string leaks a live credential into proxy logs
and `Referer` headers; the refresh cookie would rotate the session on every reconnect.

So the client exchanges its token — over a normal authenticated request, where headers work — for
a **single-use ticket** that expires in 60 seconds and grants nothing but the right to open one
stream. Redeeming it uses `GETDEL`, so a ticket captured from a log can't be replayed.

Each stream gets its **own** Redis connection: a client in subscriber mode accepts only
subscribe/unsubscribe, so it can't be shared with the one serving cache reads. Every stream is
cleaned up on disconnect — otherwise each closed tab leaks a connection and an interval, and the
process runs out of file descriptors after a few hundred page loads.

---

## Notable details

- **Cost is stored as an integer** (micro-dollars), never a float. Beyond rounding drift, Mongo's
  `$sum` over doubles isn't associative — a rollup computed in a different shard order produces a
  slightly different total, and a dashboard that disagrees with itself on refresh is
  undebuggable.
- **A TTL index expires raw events at 30 days.** It works because rollups are computed before the
  raw rows expire; the dashboard never needs a 90-day-old raw event, only the bucket it was folded
  into.
- **Cursor pagination, not offset.** `skip(10000)` walks and discards ten thousand documents per
  page, and on a live feed new events shift the offsets so rows get duplicated or skipped
  mid-scroll.
- **The event table is virtualized.** Only on-screen rows exist in the DOM; it asks for the next
  page as the viewport nears the end of what's loaded.
- **Charts follow a validated palette.** Colours aren't picked by eye — the eight categorical hues
  were checked for colour-blind separation (worst adjacent pair ΔE 9.1, target ≥8) and
  normal-vision separation. Three light-mode hues fall below 3:1 contrast, which obligates visible
  direct labels; the breakdown bars carry their values in text for exactly that reason. **No
  dual-axis charts** — spend and latency are separate plots, because a second y-scale lets you
  draw any two lines crossing anywhere.
- **`/v1` is versioned and gets its own CORS.** It's the one surface other people's deployed code
  depends on, and server-to-server clients send no `Origin` at all, so pinning them to the
  dashboard's origin would reject every one of them.

## Testing

79 tests, against a real MongoDB via `mongodb-memory-server` rather than mocks — the guarantee
under test *is* the atomicity of a conditional update and the behaviour of unique and TTL indexes,
which a mock can't tell you anything about.

The rate-limit tests need real Lua semantics, so they **skip locally** when Redis is absent and
**always run in CI**, which has a Redis service. A skipped test that announces itself is honest;
one that silently passes against a mock is not.

CI typechecks, lints, tests, builds, and fails if a credential ever appears in git history.

## License

MIT
