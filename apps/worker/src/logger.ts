import { pino } from 'pino';
import { env, isProduction, isTest } from './env.js';

/** Same logging posture as the API: JSON in production, readable locally. */
export const logger = pino({
  level: isTest ? 'silent' : isProduction ? 'info' : 'debug',
  redact: {
    paths: ['*.password', 'SMTP_PASS', 'RESEND_API_KEY', '*.pass'],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
  base: { env: env.NODE_ENV, service: 'worker' },
});

export function childLogger(component: string) {
  return logger.child({ component });
}
