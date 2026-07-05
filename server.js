/**
 * Entry shim. pm2, Docker, and the deploy scripts all point at this stable
 * path; the real entrypoint is src/server.ts, compiled by `npm run build`
 * into dist/server.js. If the import below fails with ERR_MODULE_NOT_FOUND,
 * the build step has not run.
 */
import './dist/server.js';
