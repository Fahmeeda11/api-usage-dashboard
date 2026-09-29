/**
 * Express app factory.
 *
 * Exported separately from the server so tests can mount it with supertest
 * without binding a port. `createApp()` has no side effects - no database
 * connection, no queue - which is what lets the integration tests point it at an
 * in-memory Mongo instead.
 */

import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { connectionState, isConnected } from '@usage/db';
import { env, isTest } from './lib/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './features/auth/routes.js';
import { keysRouter } from './features/keys/routes.js';
import { ingestRouter, eventsRouter, liveTailRouter } from './features/events/routes.js';
import { metricsRouter } from './features/metrics/routes.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());

  /**
   * CORS.
   *
   * The dashboard origin is pinned and allowed to send credentials (required for
   * the refresh cookie). Note that `/v1` below gets its OWN cors() with
   * origin: '*' - server-to-server ingest clients have no origin at all, and
   * pinning them to the dashboard's origin would reject every one of them.
   */
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
    }),
  );

  /**
   * A larger body limit than the dashboard needs, because a 500-event batch with
   * metadata is legitimately big. Still bounded - an unbounded limit is a
   * memory-exhaustion vector.
   */
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: {
          ignore: (req) => req.url === '/health' || req.url?.startsWith('/events/live') === true,
        },
      }),
    );
  }

  app.get('/health', (_req, res) => {
    const healthy = isConnected();
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      db: connectionState(),
      uptime: Math.floor(process.uptime()),
    });
  });

  /**
   * The public ingest API, versioned.
   *
   * Versioned because this is the one surface other people's code depends on:
   * the dashboard ships with the API and can change freely, but a customer's
   * deployed client cannot be updated on our schedule. /v1 is the promise that
   * their integration keeps working.
   *
   * Credentials are disabled here - ingest authenticates with a bearer key, not
   * a cookie, so there is nothing for a browser to attach and no CSRF surface.
   */
  app.use('/v1', cors({ origin: '*', credentials: false }), ingestRouter);

  app.use('/auth', authRouter);
  app.use('/keys', keysRouter);
  // Ticket-authenticated, so it must be mounted before the bearer-authenticated
  // events router that would otherwise reject it.
  app.use('/events', liveTailRouter);
  app.use('/events', eventsRouter);
  app.use('/metrics', metricsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
