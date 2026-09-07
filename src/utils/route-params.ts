import type { Request } from 'express';

/**
 * Route parameter readers for Express 5.
 *
 * `@types/express` 5 types every entry of `req.params` as `string | string[]`
 * because path-to-regexp v8 returns a named wildcard (`/:cid/*splat`) as an
 * array of individually decoded segments. A plain `:name` segment is always a
 * string at runtime, but the type no longer says so, and a caller that feeds
 * `req.params.x` straight into a `string` API no longer compiles.
 *
 * Both readers narrow to a string and treat any unexpected shape as empty, so
 * the validators downstream (`isNetworkName`, `isValidCid`, `isSafePath`)
 * reject it the same way they reject a missing value.
 */

/** Read a single `:name` segment. Anything that is not a string reads as ''. */
export function readStringParam(req: Request, name: string): string {
  const raw: unknown = req.params[name];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Read a `*name` wildcard as one `/`-joined path string.
 *
 * Express 4 exposed the matched remainder as a single string in
 * `req.params[0]`; re-joining the v8 array keeps path validators operating on
 * the shape they were written and tested against, so traversal checks and
 * per-segment allowlists stay in force. A wildcard that matched nothing, or
 * any element that is not a string, reads as ''.
 */
export function readWildcardParam(req: Request, name: string): string {
  const raw: unknown = req.params[name];
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  const segments: string[] = [];
  for (const segment of raw) {
    if (typeof segment !== 'string') return '';
    segments.push(segment);
  }
  return segments.join('/');
}
