/**
 * Structured logger using Pino for production JSON logging.
 * Falls back to pretty-printed output in development.
 */
import { pino, type Logger } from 'pino';
import { CONFIG } from '../config/index.js';

const logger: Logger = pino({
  level: CONFIG.LOG_LEVEL || (CONFIG.NODE_ENV === 'production' ? 'info' : 'debug'),
  ...(CONFIG.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  }),
});

export { logger };
