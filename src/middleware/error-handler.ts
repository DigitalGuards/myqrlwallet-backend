import type { NextFunction, Request, Response } from 'express';
import { CONFIG } from '../config/index.js';
import { isRecord } from '../utils/guards.js';
import { logger } from '../utils/logger.js';

/** Extract an HTTP status from an arbitrary thrown value, defaulting to 500. */
function statusOf(err: unknown): number {
  if (isRecord(err) && typeof err.status === 'number' && err.status >= 400 && err.status <= 599) {
    return err.status;
  }
  return 500;
}

export const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  const message = err instanceof Error && err.message ? err.message : 'Internal Server Error';
  res.status(statusOf(err)).json({
    error: {
      message,
      ...(CONFIG.NODE_ENV === 'development' && err instanceof Error && { stack: err.stack }),
    },
  });
};
