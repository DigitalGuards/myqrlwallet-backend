import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { CONFIG } from '../config/index.js';
import { asyncHandler } from '../utils/async-handler.js';
import { isRecord } from '../utils/guards.js';
import { logger } from '../utils/logger.js';

// Use Node's built-in fetch via globalThis so tests can stub it without
// the ESM-default-export-immutability gymnastics that `node-fetch` required.
const fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args);

const log = logger.child({ module: 'ipfs-routes' });

/**
 * Public IPFS gateway used to resolve user-supplied CIDs.
 * Overridable for self-hosted gateways or staging; defaults to ipfs.io
 * which is widely available + Cloudflare-fronted.
 */
const IPFS_GATEWAY = (process.env.IPFS_GATEWAY ?? 'https://ipfs.io/ipfs/').replace(/\/?$/, '/');

let activeFetches = 0;
let reservedInflightBytes = 0;

function acquireFetchSlot(): (() => void) | null {
  const reservation = CONFIG.IPFS_MAX_SIZE_BYTES;
  if (
    activeFetches >= CONFIG.IPFS_MAX_CONCURRENT ||
    reservedInflightBytes + reservation > CONFIG.IPFS_MAX_INFLIGHT_BYTES
  ) {
    return null;
  }

  activeFetches += 1;
  reservedInflightBytes += reservation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeFetches -= 1;
    reservedInflightBytes -= reservation;
  };
}

function sendStreamError(res: Response, status: number, error: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ error });
}

function writeChunkWithAbort(res: Response, value: Uint8Array, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => {
      const error = new Error('IPFS response deadline exceeded');
      error.name = 'AbortError';
      finish(error);
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      res.write(value, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// CIDv0: starts with Qm + 44 base58 chars (no 0, O, I, l)
const CIDV0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
// CIDv1: starts with single multibase prefix; 'b' (base32) is by far the most
// common. We accept the typical base32 form; other prefixes are rejected to
// keep the surface tight.
const CIDV1_RE = /^b[A-Za-z2-7]{58,}$/;
// After the CID, any number of `/segment` path components are allowed. Path
// segments may not contain `..`, `\\`, or whitespace.
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

const ipfsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 requests/min/IP - well above expected normal NFT browsing
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited' },
});

function isValidCid(cid: string): boolean {
  return CIDV0_RE.test(cid) || CIDV1_RE.test(cid);
}

function isSafePath(rest: string): boolean {
  if (!rest) return true;
  if (rest.includes('..')) return false;
  const segments = rest.split('/').filter(Boolean);
  return segments.every((s) => PATH_SEGMENT_RE.test(s));
}

const ipfsRouter = Router();
ipfsRouter.use(ipfsRateLimit);

/**
 * GET /api/ipfs/:cid             → fetches gateway/<cid>
 * GET /api/ipfs/:cid/path/to/x   → fetches gateway/<cid>/path/to/x
 *
 * Used as a same-origin shim so the wallet's strict
 * `img-src 'self' data:` CSP can still render IPFS-hosted NFT images
 * without allowlisting every public gateway, and so JSON metadata
 * fetches don't depend on the gateway's (often missing) CORS headers.
 *
 * The route does NOT accept arbitrary URLs (no `?url=` style proxying);
 * that would be a giant SSRF surface. Only well-formed IPFS CIDs are
 * dereferenced through the configured `IPFS_GATEWAY`.
 *
 * Two route patterns share a handler because Express 4's path-to-regexp
 * won't match `/:cid` against `/:cid/*?`: the optional star modifier still
 * requires a `/` separator that isn't present when only the CID is supplied.
 */
async function ipfsHandler(req: Request, res: Response): Promise<void> {
  const cid = req.params.cid ?? '';
  const rest = req.params['0'] ?? '';

  if (!isValidCid(cid)) {
    res.status(400).json({ error: 'invalid CID' });
    return;
  }
  if (!isSafePath(rest)) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }

  const releaseFetchSlot = acquireFetchSlot();
  if (!releaseFetchSlot) {
    res.set('Retry-After', '1').status(503).json({ error: 'IPFS proxy busy' });
    return;
  }

  const url = `${IPFS_GATEWAY}${cid}${rest ? '/' + rest : ''}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, CONFIG.IPFS_FETCH_TIMEOUT_MS);
  let clientDisconnected = false;
  const abortForDisconnect = (): void => {
    clientDisconnected = true;
    controller.abort();
  };
  const abortForEarlyClose = (): void => {
    if (!res.writableEnded) abortForDisconnect();
  };
  req.once('aborted', abortForDisconnect);
  res.once('close', abortForEarlyClose);

  try {
    // Keep the request pinned to the configured gateway origin. Following an
    // upstream redirect would turn a compromised gateway into an SSRF hop to
    // loopback, cloud metadata, or another private service.
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      controller.abort();
      log.warn({ cid, status: response.status }, 'IPFS gateway returned non-2xx');
      res
        .status(response.status === 404 ? 404 : 502)
        .json({ error: 'gateway error', status: response.status });
      return;
    }

    // Reject oversize responses up front if the gateway is honest about
    // Content-Length. A malicious or buggy gateway can still under-declare
    // (or omit) the header and stream arbitrarily many bytes, so we ALSO
    // enforce the cap incrementally as we read the body; never let an
    // attacker buffer >MAX_SIZE into our heap.
    const declaredSize = parseInt(response.headers.get('content-length') ?? '0', 10);
    if (declaredSize > CONFIG.IPFS_MAX_SIZE_BYTES) {
      controller.abort();
      res
        .status(413)
        .json({ error: 'too large', size: declaredSize, max: CONFIG.IPFS_MAX_SIZE_BYTES });
      return;
    }

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';

    // Fetch API allows response.body to be null (e.g. 204 No Content). Without
    // an explicit check, the .getReader() call below would throw a TypeError
    // that we'd report as "gateway unreachable"; misleading.
    if (!response.body) {
      log.warn({ cid, status: response.status }, 'IPFS gateway returned empty body');
      res.status(502).json({ error: 'gateway error' });
      return;
    }

    // undici types the body as ReadableStream<any>; declare the chunk type
    // here and verify it at runtime (instanceof below) instead of trusting it.
    const stream: ReadableStream<unknown> = response.body;
    const reader = stream.getReader();
    let received = 0;
    let proxyHeadersSet = false;
    const setProxyHeaders = (): void => {
      if (proxyHeadersSet) return;
      proxyHeadersSet = true;
      res.set({
        'Content-Type': contentType,
        // IPFS content is content-addressed, so caching for an hour is safe.
        'Cache-Control': 'public, max-age=3600, immutable',
        // Sane defaults; never let user-supplied content advertise itself
        // as the wallet's own scripts.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data: blob:; sandbox",
      });
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          log.error({ cid, rest }, 'IPFS gateway stream yielded a non-binary chunk');
          controller.abort();
          void reader.cancel().catch(() => undefined);
          sendStreamError(res, 502, 'gateway stream error');
          return;
        }
        if (received + value.byteLength > CONFIG.IPFS_MAX_SIZE_BYTES) {
          // Never write a byte beyond the cap. Once streaming has started an
          // HTTP status cannot be changed, so terminate that partial response.
          try {
            await reader.cancel();
          } catch {
            /* noop */
          }
          controller.abort();
          if (!res.headersSent) {
            res.status(413).json({
              error: 'too large',
              size: received + value.byteLength,
              max: CONFIG.IPFS_MAX_SIZE_BYTES,
            });
          } else {
            res.destroy();
          }
          return;
        }
        received += value.byteLength;
        setProxyHeaders();
        await writeChunkWithAbort(res, value, controller.signal);
      }
    } catch (streamErr) {
      // An AbortError mid-stream is the FETCH_TIMEOUT_MS controller firing,
      // not a stream-specific failure. Re-throw so the outer catch maps it
      // to 504 like the pre-streaming code did. Anything else stays a 502.
      if (isRecord(streamErr) && streamErr.name === 'AbortError') throw streamErr;
      if (clientDisconnected) return;
      controller.abort();
      void reader.cancel().catch(() => undefined);
      log.error(
        { cid, rest, errorName: streamErr instanceof Error ? streamErr.name : typeof streamErr },
        'IPFS proxy stream read failed'
      );
      sendStreamError(res, 502, 'gateway stream error');
      return;
    }
    setProxyHeaders();
    res.end();
  } catch (err) {
    if (clientDisconnected) return;
    if (isRecord(err) && err.name === 'AbortError') {
      log.warn({ cid, rest }, 'IPFS proxy timeout');
      sendStreamError(res, 504, 'gateway timeout');
      return;
    }
    log.error(
      { cid, rest, errorName: err instanceof Error ? err.name : typeof err },
      'IPFS proxy failed'
    );
    sendStreamError(res, 502, 'gateway unreachable');
  } finally {
    clearTimeout(timeout);
    req.off('aborted', abortForDisconnect);
    res.off('close', abortForEarlyClose);
    releaseFetchSlot();
  }
}

ipfsRouter.get('/:cid', asyncHandler(ipfsHandler));
ipfsRouter.get('/:cid/*', asyncHandler(ipfsHandler));

export { ipfsRouter };
