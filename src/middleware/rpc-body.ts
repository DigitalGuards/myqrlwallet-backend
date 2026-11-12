import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { CONFIG } from '../config/index.js';
import { isArray, isRecord } from '../utils/guards.js';
import { QRL_ADDRESS_HEX_LENGTH } from '../utils/qrl-address.js';
import { RAW_TX_HEX_PATTERN } from './rpc-security.js';

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
const ADDRESS_PATTERN = new RegExp(`^Q[0-9a-fA-F]{${QRL_ADDRESS_HEX_LENGTH}}$`);
const BLOCK_TAG_PATTERN = /^(?:latest|pending|earliest|safe|finalized|0x[0-9a-fA-F]{1,64})$/;
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['jsonrpc', 'id', 'method', 'params']);

const MAX_ACCESS_LIST_ENTRIES = 64;
const MAX_STORAGE_KEYS = 64;

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
  for (let i = 0; i < buf.length; i += 1) {
    const c = buf.readUInt8(i);
    const isHex = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!isHex) {
      other += 1;
      if (other > MAX_NON_HEX_BYTES) return false;
    }
  }
  return true;
}

function isAccessList(value: unknown): boolean {
  return (
    isArray(value) &&
    value.length <= MAX_ACCESS_LIST_ENTRIES &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        Object.keys(entry).every((key) => key === 'address' || key === 'storageKeys') &&
        typeof entry.address === 'string' &&
        ADDRESS_PATTERN.test(entry.address) &&
        isArray(entry.storageKeys) &&
        entry.storageKeys.length <= MAX_STORAGE_KEYS &&
        entry.storageKeys.every((key) => typeof key === 'string' && HEX_PATTERN.test(key))
    )
  );
}

function isCallObject(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, field]) => {
      if (field === null) return true;
      if (key === 'accessList') return isAccessList(field);
      return typeof field === 'string' && (HEX_PATTERN.test(field) || ADDRESS_PATTERN.test(field));
    })
  );
}

/** Block tag, or an EIP-1898 object with one hex blockNumber or blockHash. */
function isBlockParam(value: unknown): boolean {
  if (typeof value === 'string') return BLOCK_TAG_PATTERN.test(value);
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    !keys.every((key) => key === 'blockNumber' || key === 'blockHash' || key === 'requireCanonical')
  ) {
    return false;
  }
  const hasNumber = value.blockNumber !== undefined;
  const hasHash = value.blockHash !== undefined;
  if (hasNumber === hasHash) return false;
  const tag = hasNumber ? value.blockNumber : value.blockHash;
  if (typeof tag !== 'string' || !HEX_PATTERN.test(tag)) return false;
  return value.requireCanonical === undefined || typeof value.requireCanonical === 'boolean';
}

/** Exact post-parse shape of an accepted body above the default limit. */
function isLargeBodyShape(body: unknown): boolean {
  if (!isRecord(body) || !Object.keys(body).every((key) => ENVELOPE_KEYS.has(key))) return false;
  const { method, params, id } = body;
  if (typeof method !== 'string' || !LARGE_BODY_METHODS.has(method)) return false;
  if (body.jsonrpc !== undefined && body.jsonrpc !== '2.0') return false;
  const idOk =
    id === undefined ||
    id === null ||
    (typeof id === 'string' && id.length <= 256) ||
    (typeof id === 'number' && Number.isFinite(id));
  if (!idOk) return false;
  if (!isArray(params)) return false;
  if (method === SEND_RAW_TX_METHOD) {
    return (
      params.length === 1 && typeof params[0] === 'string' && RAW_TX_HEX_PATTERN.test(params[0])
    );
  }
  if (params.length < 1 || params.length > 2 || !isCallObject(params[0])) return false;
  return params.length === 1 || isBlockParam(params[1]);
}

/**
 * Raw-size parse limit. The method is only known after parsing, so the
 * parser reads up to the large limit and the checks above enforce the
 * default limit afterwards. Batches and non-object bodies keep the default.
 */
const largeJsonParser = express.json({
  limit: RPC_LARGE_BODY_LIMIT_BYTES,
  inflate: false,
  verify: (_req, _res, buf) => {
    if (!looksLikeLargeBody(buf)) {
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
 * Strict per-address limiter for large bodies (RPC_LARGE_BODY_RATE_LIMIT_PER_MINUTE).
 * It sits before the parser and keys on the declared Content-Length
 * (body-parser rejects a body that differs from it), so a large body is
 * counted before it is buffered. A body above the default limit is accepted
 * only with a declared length, so every other request, chunked ones
 * included, skips this limiter and behaves as before.
 */
export const rpcRateLimitLargeBody = rateLimit({
  windowMs: 60 * 1000,
  limit: () => CONFIG.RPC_LARGE_BODY_RATE_LIMIT_PER_MINUTE,
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
  // Anything that does not declare a length above the default limit takes the
  // old path: the global 50kb parser reads it, chunked bodies included.
  if (!mayBeLarge(req)) {
    next();
    return;
  }
  largeJsonParser(req, res, (err?: unknown) => {
    if (err !== undefined) {
      next(err);
      return;
    }
    if (!isLargeBodyShape(req.body)) {
      next(tooLarge());
      return;
    }
    next();
  });
};
