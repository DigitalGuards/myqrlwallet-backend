import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { CONFIG } from '../config/index.js';
import { asyncHandler } from '../utils/async-handler.js';
import { readStringParam, readWildcardParam } from '../utils/route-params.js';
import { isRecord } from '../utils/guards.js';
import { logger } from '../utils/logger.js';

// Use Node's built-in fetch via globalThis so tests can stub it without
// the ESM-default-export-immutability gymnastics that `node-fetch` required.
const fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args);

const log = logger.child({ module: 'ipfs-routes' });

interface GatewayState {
  url: string;
  origin: string;
  cooldownUntil: number;
}

interface GatewayFailure {
  status: number;
  error: string;
  upstreamStatus?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 300_000;

function retryAfterMs(value: unknown, now: number): number {
  if (typeof value !== 'string') return DEFAULT_COOLDOWN_MS;
  const input = value.trim();
  if (/^[0-9]+$/.test(input)) return Math.min(Number(input) * 1000, MAX_COOLDOWN_MS);
  const retryAt = /^[A-Za-z]{3}, /.test(input) ? Date.parse(input) : NaN;
  if (Number.isFinite(retryAt)) return Math.min(Math.max(0, retryAt - now), MAX_COOLDOWN_MS);
  return DEFAULT_COOLDOWN_MS;
}

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

function isValidCid(cid: string): boolean {
  return CIDV0_RE.test(cid) || CIDV1_RE.test(cid);
}

function isSafePath(rest: string): boolean {
  if (!rest) return true;
  if (rest.includes('..')) return false;
  const segments = rest.split('/').filter(Boolean);
  return segments.every((s) => PATH_SEGMENT_RE.test(s));
}

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
 * dereferenced through the configured `IPFS_GATEWAYS`.
 *
 * Two route patterns share a handler because a wildcard cannot also match the
 * bare `/:cid` form: the separator it needs is absent when only the CID is
 * supplied.
 */
async function ipfsHandler(req: Request, res: Response, gateways: GatewayState[]): Promise<void> {
  const cid = readStringParam(req, 'cid');
  const rest = readWildcardParam(req, 'splat');

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

  const controller = new AbortController();
  const deadline = performance.now() + CONFIG.IPFS_FETCH_TIMEOUT_MS;
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
    let failure: GatewayFailure = { status: 503, error: 'IPFS gateways cooling down' };
    for (const [index, gateway] of gateways.entries()) {
      if (clientDisconnected) return;
      const remaining = deadline - performance.now();
      if (controller.signal.aborted || remaining <= 0) {
        failure = { status: 504, error: 'gateway timeout' };
        break;
      }
      if (gateway.cooldownUntil > Date.now()) {
        log.debug({ cid, gateway: gateway.origin }, 'IPFS gateway skipped during cooldown');
        continue;
      }

      const available = gateways.slice(index).filter((entry) => entry.cooldownUntil <= Date.now());
      const attempt = new AbortController();
      const abortAttempt = (): void => {
        attempt.abort();
      };
      controller.signal.addEventListener('abort', abortAttempt, { once: true });
      // Reserve time for remaining gateways until this attempt starts delivering
      // bytes. Streaming then uses the remaining overall request budget.
      const attemptTimeout = setTimeout(
        abortAttempt,
        Math.max(1, Math.floor(remaining / available.length))
      );
      let streamingStarted = false;
      let readingBody = false;
      try {
        const url = `${gateway.url}${cid}${rest ? '/' + rest : ''}`;
        // Each attempt stays pinned to its configured origin. Redirects fail
        // before a request can reach a destination supplied by an upstream.
        const response = await fetchImpl(url, { signal: attempt.signal, redirect: 'error' });
        attempt.signal.throwIfAborted();
        if (!response.ok) {
          log.warn(
            { cid, gateway: gateway.origin, status: response.status },
            'IPFS gateway returned non-2xx'
          );
          failure = {
            status: response.status === 404 ? 404 : 502,
            error: 'gateway error',
            upstreamStatus: response.status,
          };
          if (response.status === 429) {
            const now = Date.now();
            const cooldownMs = retryAfterMs(response.headers.get('retry-after'), now);
            gateway.cooldownUntil = Math.max(gateway.cooldownUntil, now + cooldownMs);
            log.warn({ cid, gateway: gateway.origin, cooldownMs }, 'IPFS gateway cooling down');
          }
          if (response.status === 429 || (response.status >= 500 && response.status < 600))
            continue;
          break;
        }

        readingBody = true;
        await streamGatewayResponse(response, res, attempt, cid, gateway.origin, () => {
          streamingStarted = true;
          clearTimeout(attemptTimeout);
        });
        return;
      } catch (error) {
        if (clientDisconnected) return;
        const timedOut = attempt.signal.aborted || (isRecord(error) && error.name === 'AbortError');
        failure = {
          status: timedOut ? 504 : 502,
          error: timedOut
            ? 'gateway timeout'
            : readingBody
              ? 'gateway stream error'
              : 'gateway unreachable',
        };
        log.warn(
          {
            cid,
            gateway: gateway.origin,
            timedOut,
            errorName: error instanceof Error ? error.name : typeof error,
          },
          'IPFS gateway attempt failed'
        );
        if (streamingStarted || res.headersSent) {
          sendStreamError(res, failure.status, failure.error);
          return;
        }
      } finally {
        clearTimeout(attemptTimeout);
        controller.signal.removeEventListener('abort', abortAttempt);
        attempt.abort();
      }
    }

    if (failure.status === 503) {
      const retryAt = Math.min(...gateways.map((gateway) => gateway.cooldownUntil));
      res.set('Retry-After', String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))));
    }
    res.status(failure.status).json({ error: failure.error, status: failure.upstreamStatus });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    req.off('aborted', abortForDisconnect);
    res.off('close', abortForEarlyClose);
    releaseFetchSlot();
  }
}

async function streamGatewayResponse(
  response: globalThis.Response,
  res: Response,
  controller: AbortController,
  cid: string,
  gateway: string,
  onFirstChunk: () => void
): Promise<void> {
  // Check both declared and actual sizes, including bodies with missing or
  // understated Content-Length. Every attempt shares the same admission slot.
  const declaredSize = parseInt(response.headers.get('content-length') ?? '0', 10);
  if (declaredSize > CONFIG.IPFS_MAX_SIZE_BYTES) {
    log.warn({ cid, gateway, size: declaredSize }, 'IPFS gateway response too large');
    res
      .status(413)
      .json({ error: 'too large', size: declaredSize, max: CONFIG.IPFS_MAX_SIZE_BYTES });
    return;
  }

  const upstreamContentType = response.headers.get('content-type');
  const inlineAllowed = upstreamContentType !== null && isInlineMediaType(upstreamContentType);
  const contentType = inlineAllowed ? upstreamContentType : 'application/octet-stream';
  if (!response.body) {
    log.warn({ cid, gateway, status: response.status }, 'IPFS gateway returned empty body');
    res.status(502).json({ error: 'gateway error' });
    return;
  }

  // Fetch body chunks enter as unknown and pass a runtime binary check.
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
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data: blob:; sandbox",
      // Media outside the allowlist is downloaded under the wallet origin.
      ...(inlineAllowed ? {} : { 'Content-Disposition': 'attachment' }),
    });
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        log.error({ cid, gateway }, 'IPFS gateway stream yielded a non-binary chunk');
        sendStreamError(res, 502, 'gateway stream error');
        return;
      }
      if (received + value.byteLength > CONFIG.IPFS_MAX_SIZE_BYTES) {
        log.warn(
          { cid, gateway, size: received + value.byteLength },
          'IPFS gateway response too large'
        );
        // Terminate a partial response as soon as its size reaches the cap.
        if (res.headersSent) res.destroy();
        else
          res.status(413).json({
            error: 'too large',
            size: received + value.byteLength,
            max: CONFIG.IPFS_MAX_SIZE_BYTES,
          });
        return;
      }
      if (value.byteLength === 0) continue;
      if (received === 0) onFirstChunk();
      received += value.byteLength;
      setProxyHeaders();
      await writeChunkWithAbort(res, value, controller.signal);
    }
    setProxyHeaders();
    res.end();
    log.info({ cid, gateway, bytes: received }, 'IPFS gateway served content');
  } finally {
    // Cancel without waiting so upstream cleanup cannot extend the deadline.
    void reader.cancel().catch(() => undefined);
  }
}

export function createIpfsRouter(): Router {
  const gateways = CONFIG.IPFS_GATEWAYS.map((url) => ({
    url,
    origin: new URL(url).origin,
    cooldownUntil: 0,
  }));
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate-limited' },
    })
  );
  const handler = asyncHandler((req, res) => ipfsHandler(req, res, gateways));
  router.get('/:cid', handler);
  router.get('/:cid/*splat', handler);
  return router;
}

const ipfsRouter = createIpfsRouter();

/**
 * Media types the NFT feature renders inline: raster and SVG images, video,
 * audio and JSON metadata. Everything else is served as a download.
 */
const INLINE_MEDIA_TYPES =
  /^(image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)|video\/(mp4|webm|ogg)|audio\/(mpeg|mp3|ogg|wav|x-wav|webm|mp4|aac|flac)|application\/json)$/;

function isInlineMediaType(contentType: string): boolean {
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return INLINE_MEDIA_TYPES.test(mediaType);
}

export { ipfsRouter };
