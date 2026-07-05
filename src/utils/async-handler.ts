import type { NextFunction, Request, Response } from 'express';

/**
 * Express 4 does not catch rejected promises from async handlers; an unhandled
 * rejection in a route would crash the process on modern Node. This wrapper
 * routes any rejection into next() (the central error handler) and gives the
 * router a plain void-returning function, which also satisfies
 * @typescript-eslint/no-misused-promises.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
