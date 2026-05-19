import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger.js';

// Use Node 22's built-in fetch via globalThis so tests can stub it without
// the ESM-default-export-immutability gymnastics that `node-fetch` requires.
const fetchImpl = (...args) => globalThis.fetch(...args);

const log = logger.child({ module: 'ipfs-routes' });

/**
 * Public IPFS gateway used to resolve user-supplied CIDs.
 * Overridable for self-hosted gateways or staging; defaults to ipfs.io
 * which is widely available + Cloudflare-fronted.
 */
const IPFS_GATEWAY = (process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/').replace(/\/?$/, '/');
const FETCH_TIMEOUT_MS = parseInt(process.env.IPFS_FETCH_TIMEOUT_MS || '8000', 10);
const MAX_SIZE = parseInt(process.env.IPFS_MAX_SIZE_BYTES || String(10 * 1024 * 1024), 10); // 10 MB

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
  max: 60, // 60 requests/min/IP — well above expected normal NFT browsing
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited' },
});

function isValidCid(cid) {
  return CIDV0_RE.test(cid) || CIDV1_RE.test(cid);
}

function isSafePath(rest) {
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
 * The route does NOT accept arbitrary URLs (no `?url=` style proxying)
 * — that would be a giant SSRF surface. Only well-formed IPFS CIDs are
 * dereferenced through the configured `IPFS_GATEWAY`.
 *
 * Two route patterns share a handler because Express 4's path-to-regexp
 * won't match `/:cid` against `/:cid/*?` — the optional star modifier still
 * requires a `/` separator that isn't present when only the CID is supplied.
 */
async function ipfsHandler(req, res) {
  const { cid } = req.params;
  const rest = req.params[0] || '';

  if (!isValidCid(cid)) {
    return res.status(400).json({ error: 'invalid CID' });
  }
  if (!isSafePath(rest)) {
    return res.status(400).json({ error: 'invalid path' });
  }

  const url = `${IPFS_GATEWAY}${cid}${rest ? '/' + rest : ''}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      log.warn({ cid, status: response.status }, 'IPFS gateway returned non-2xx');
      return res
        .status(response.status === 404 ? 404 : 502)
        .json({ error: 'gateway error', status: response.status });
    }

    // Reject oversize responses up front if the gateway is honest about
    // Content-Length. A malicious or buggy gateway can still under-declare
    // (or omit) the header and stream arbitrarily many bytes, so we ALSO
    // enforce the cap incrementally as we read the body — never let an
    // attacker buffer >MAX_SIZE into our heap.
    const declaredSize = parseInt(response.headers.get('content-length') || '0', 10);
    if (declaredSize > MAX_SIZE) {
      return res.status(413).json({ error: 'too large', size: declaredSize, max: MAX_SIZE });
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_SIZE) {
          // Stop pulling bytes off the gateway socket before we ever
          // commit them to our heap. cancel() may reject if the stream
          // is already closed — swallow that.
          try {
            await reader.cancel();
          } catch {
            /* noop */
          }
          return res.status(413).json({ error: 'too large', size: received, max: MAX_SIZE });
        }
        chunks.push(value);
      }
    } catch (streamErr) {
      log.error({ err: streamErr.message, url }, 'IPFS proxy stream read failed');
      return res.status(502).json({ error: 'gateway stream error' });
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));

    res.set({
      'Content-Type': contentType,
      // IPFS content is content-addressed, so caching for an hour is safe.
      'Cache-Control': 'public, max-age=3600, immutable',
      // Sane defaults — never let user-supplied content advertise itself
      // as the wallet's own scripts.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data: blob:; sandbox",
    });
    res.send(buf);
  } catch (err) {
    if (err.name === 'AbortError') {
      log.warn({ cid, rest }, 'IPFS proxy timeout');
      return res.status(504).json({ error: 'gateway timeout' });
    }
    log.error({ err: err.message, url }, 'IPFS proxy failed');
    return res.status(502).json({ error: 'gateway unreachable' });
  } finally {
    clearTimeout(timeout);
  }
}

ipfsRouter.get('/:cid', ipfsHandler);
ipfsRouter.get('/:cid/*', ipfsHandler);

export { ipfsRouter };
