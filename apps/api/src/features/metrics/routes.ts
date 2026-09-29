import { Router } from 'express';
import { Types } from 'mongoose';
import { metricsQuerySchema, type MetricsQuery } from '@usage/shared';
import { UsageEvent } from '@usage/db';
import { validateQuery, parsedQuery } from '../../middleware/validate.js';
import { requireAuth, currentUserId } from '../../middleware/auth.js';
import { badRequest } from '../../lib/errors.js';
import { getMetrics } from './service.js';

export const metricsRouter = Router();

metricsRouter.use(requireAuth);

/** Cap the range so one request cannot ask for a million buckets. */
const MAX_RANGE_MS = 400 * 86_400_000;

metricsRouter.get('/', validateQuery(metricsQuerySchema), async (req, res) => {
  const query = parsedQuery<MetricsQuery>(res);

  if (query.to.getTime() < query.from.getTime()) {
    throw badRequest('"to" must be after "from"');
  }
  if (query.to.getTime() - query.from.getTime() > MAX_RANGE_MS) {
    throw badRequest('Range is too long - narrow it or use a coarser granularity');
  }

  const metrics = await getMetrics(currentUserId(req), query);

  // Let a browser reuse the response briefly, matching the server-side cache.
  // private, because this payload is one user's spend and must never be held by
  // a shared proxy.
  res.setHeader('Cache-Control', 'private, max-age=30');
  res.json(metrics);
});

/**
 * The distinct projects and models this account has sent, for the filter
 * dropdowns.
 *
 * Reads from raw events rather than rollups so a brand-new project shows up in
 * the filter immediately, before its first rollup has been built - otherwise a
 * user sends their first event and cannot find it in the UI for a minute.
 */
metricsRouter.get('/dimensions', async (req, res) => {
  const userId = new Types.ObjectId(currentUserId(req));

  const [projects, models] = await Promise.all([
    UsageEvent.distinct('project', { userId }),
    UsageEvent.distinct('model', { userId }),
  ]);

  res.json({ projects: projects.sort(), models: models.sort() });
});
