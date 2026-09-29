/**
 * Structured logging.
 *
 * JSON in production so a log aggregator can index the fields; pretty-printed
 * and colourised in development so it is readable in a terminal. Same call sites
 * either way.
 *
 * The redact list is the important part: request logging captures whole headers
 * and bodies, and without this the refresh-token cookie and Authorization header
 * end up in plaintext in the logs - which is exactly the kind of leak that makes
 * a log store as sensitive as the database.
 */

import { pino } from 'pino';
import { env, isProduction, isTest } from './env.js';

export const logger = pino({
  level: isTest ? 'silent' : isProduction ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.accessToken',
      '*.refreshToken',
      'password',
      'accessToken',
      'refreshToken',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
  base: { env: env.NODE_ENV },
});

/** Child logger for a named subsystem, so lines can be filtered by component. */
export function childLogger(component: string) {
  return logger.child({ component });
}
