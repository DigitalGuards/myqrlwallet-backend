import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { CONFIG } from '../config/index.js';
import { isArray, isRecord } from '../utils/guards.js';

/** Body limit for every RPC request that is not a large-body method. */
export const RPC_DEFAULT_BODY_LIMIT_BYTES = 50 * 1024;

/**
 * The node's transaction pool accepts up to 128 KiB (131,072 bytes) per
 * transaction. As hex that is 262,144 characters, plus the 2 character `0x`
 * prefix, plus the JSON-RPC envelope and quotes (well under 1 KiB). A
 * transaction that carries several ML-DSA-87 signatures (about 7 KB each)
 * needs more than the default limit. 270,000 bytes covers the arithmetic
 * (about 263 KB) with headroom.
 */
export const RPC_LARGE_BODY_LIMIT_BYTES = 270_000;

/**
 * A wallet estimates and simulates a transaction with the same call data it
 * later sends, so these three methods share the larger limit. Single
 * requests only.
 */
const SEND_RAW_TX_METHOD = 'qrl_sendRawTransaction';
const LARGE_BODY_METHODS: ReadonlySet<string> = new Set([
  SEND_RAW_TX_METHOD,
  'qrl_call',
  'qrl_estimateGas',
]);

/** Bytes outside [0-9a-fA-F] a large body may hold (envelope, keys, quotes). */
const MAX_NON_HEX_BYTES = 1024;

const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
// Shape only: the node checks the address checksum.
const ADDRESS_PATTERN = /^Q[0-9a-fA-F]{128}$/;
const BLOCK_TAG_PATTERN = /^(?:latest|pending|earliest|safe|finalized|0x[0-9a-fA-F]{1,64})$/;
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['jsonrpc', 'id', 'method', 'params']);

// Raw byte length of each parsed body, keyed by request.
const rawBodyBytes = new WeakMap<object, number>();

function tooLarge(): Error {
  return Object.assign(new Error('request entity too large'), {
    name: 'PayloadTooLargeError',
    status: 413,
    statusCode: 413,
    type: 'entity.too.large',
  });
}

/**
 * Pre-parse shape check for a body above the default limit: it names a
 * large-body method and is mostly hex (at most MAX_NON_HEX_BYTES of other
 * bytes). A nested, padded or text body fails here in one byte scan, before
 * JSON.parse allocates anything.
 */
function looksLikeLargeBody(buf: Buffer): boolean {
  let named = false;
  for (const method of LARGE_BODY_METHODS) {
    if (buf.includes(method)) {
      named = true;
      break;
    }
  }
  if (!named) return false;
  let other = 0;
  for (const c of buf) {
    const isHex = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!isHex) {
      other += 1;
      if (other > MAX_NON_HEX_BYTES) return false;
    }
  }
  return true;
}

function isCallObject(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (field) =>
        typeof field === 'string' && (HEX_PATTERN.test(field) || ADDRESS_PATTERN.test(field))
    )
  );
}

/** Exact post-parse shape of an accepted body above the default limit. */
function isLargeBodyShape(body: unknown): boolean {
  if (!isRecord(body) || !Object.keys(body).every((key) => ENVELOPE_KEYS.has(key))) return false;
  const { method, params, id } = body;
  if (typeof method !== 'string' || !LARGE_BODY_METHODS.has(method)) return false;
  if (typeof id === 'string' && id.length > 256) return false;
  if (!isArray(params)) return false;
  if (method === SEND_RAW_TX_METHOD) {
    return params.length === 1 && typeof params[0] === 'string' && HEX_PATTERN.test(params[0]);
  }
  if (params.length < 1 || params.length > 2 || !isCallObject(params[0])) return false;
  return (
    params.length === 1 || (typeof params[1] === 'string' && BLOCK_TAG_PATTERN.test(params[1]))
  );
}

/**
 * Raw-size parse limit. The method is only known after parsing, so the
 * parser reads up to the large limit and the checks above enforce the
 * default limit afterwards. Batches and non-object bodies keep the default.
 */
const largeJsonParser = express.json({
  limit: RPC_LARGE_BODY_LIMIT_BYTES,
  inflate: false,
  verify: (req, _res, buf) => {
    rawBodyBytes.set(req, buf.length);
    if (
      buf.length > RPC_DEFAULT_BODY_LIMIT_BYTES &&
      (declaredLength(req) === null || !looksLikeLargeBody(buf))
    ) {
      throw tooLarge();
    }
  },
});

/** Declared body length, or null when the header is absent or not a plain number. */
function declaredLength(req: {
  headers: { 'content-length'?: string | undefined };
}): number | null {
  const declared = req.headers['content-length'];
  return declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null;
}

/** True only when the request declares a length above the default limit. */
function mayBeLarge(req: Request): boolean {
  const length = declaredLength(req);
  return length !== null && length > RPC_DEFAULT_BODY_LIMIT_BYTES;
}

/**
 * Strict per-address limiter for large bodies, using the write-limit setting.
 * It sits before the parser and keys on the declared Content-Length
 * (body-parser rejects a body that differs from it), so a large body is
 * counted before it is buffered. A body above the default limit is accepted
 * only with a declared length, so every other request, chunked ones
 * included, skips this limiter and behaves as before.
 */
export const rpcRateLimitLargeBody = rateLimit({
  windowMs: 60 * 1000,
  limit: () => CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? 'unknown')}-large-body`,
  skip: (req) => !mayBeLarge(req),
  handler: (_req, res) => {
    res.status(429).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32005,
        message: 'Large request rate limit exceeded. Please wait before sending more.',
      },
    });
  },
});

export const rpcJsonBody = (req: Request, res: Response, next: NextFunction): void => {
  largeJsonParser(req, res, (err?: unknown) => {
    if (err !== undefined) {
      next(err);
      return;
    }
    const bytes = rawBodyBytes.get(req) ?? 0;
    if (bytes > RPC_DEFAULT_BODY_LIMIT_BYTES && !isLargeBodyShape(req.body)) {
      next(tooLarge());
      return;
    }
    next();
  });
};
