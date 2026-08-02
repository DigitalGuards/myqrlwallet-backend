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

export const errorHandler = (err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const status = statusOf(err);
  const errorName = err instanceof Error ? err.name : typeof err;
  const errorMessage = err instanceof Error && err.message ? err.message : 'Unknown error';
  const isRequestParserError =
    status < 500 &&
    isRecord(err) &&
    (typeof err.type === 'string' || (err instanceof SyntaxError && 'body' in err));
  const safeErrorMessage = isRequestParserError
    ? status === 413
      ? 'Request body too large'
      : 'Invalid request body'
    : errorMessage;

  // Do not pass the original object to the logger. body-parser errors carry
  // the raw request in `err.body`, which can contain signed transactions or
  // other wallet data when malformed JSON reaches this handler.
  const logContext = {
    status,
    error: {
      name: errorName,
      message: safeErrorMessage,
      ...(CONFIG.NODE_ENV === 'development' &&
        !isRequestParserError &&
        err instanceof Error && { stack: err.stack }),
    },
  };
  if (status >= 500) logger.error(logContext, 'Unhandled server error');
  else logger.warn(logContext, 'Rejected request');

  const message = status >= 500 ? 'Internal Server Error' : safeErrorMessage;
  res.status(status).json({
    error: {
      message,
      ...(CONFIG.NODE_ENV === 'development' &&
        !isRequestParserError &&
        err instanceof Error && { stack: err.stack }),
    },
  });
};
