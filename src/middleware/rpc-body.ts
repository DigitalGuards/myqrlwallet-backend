import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { isRecord } from '../utils/guards.js';

/** Body limit for every RPC method except qrl_sendRawTransaction. */
export const RPC_DEFAULT_BODY_LIMIT_BYTES = 50 * 1024;

/**
 * The node's transaction pool accepts up to 128 KiB (131,072 bytes) per
 * transaction. As hex that is 262,144 characters, plus the 2 character `0x`
 * prefix, plus the JSON-RPC envelope and quotes (well under 1 KiB). A
 * transaction that carries several ML-DSA-87 signatures (about 7 KB each)
 * needs more than the default limit. 270,000 bytes covers the arithmetic
 * (about 263 KB) with headroom.
 */
export const RPC_SEND_RAW_TX_BODY_LIMIT_BYTES = 270_000;

const SEND_RAW_TX_METHOD = 'qrl_sendRawTransaction';

// Raw byte length of each parsed body, keyed by request.
const rawBodyBytes = new WeakMap<object, number>();

function tooLarge(): Error {
  return Object.assign(new Error('request entity too large'), {
    status: 413,
    statusCode: 413,
    type: 'entity.too.large',
  });
}

/**
 * Parses the RPC body under the larger raw-transaction limit, then enforces
 * the default limit for everything else. The method is only known after
 * parsing, so two checks apply: a cheap pre-parse check on the raw bytes (a
 * body above the default limit must at least mention the raw-transaction
 * method) and an exact post-parse check on the decoded method. Batches and
 * non-object bodies keep the default limit.
 */
const largeJsonParser = express.json({
  limit: RPC_SEND_RAW_TX_BODY_LIMIT_BYTES,
  inflate: false,
  verify: (req, _res, buf) => {
    rawBodyBytes.set(req, buf.length);
    if (buf.length > RPC_DEFAULT_BODY_LIMIT_BYTES && !buf.includes(SEND_RAW_TX_METHOD)) {
      throw tooLarge();
    }
  },
});

export const rpcJsonBody = (req: Request, res: Response, next: NextFunction): void => {
  largeJsonParser(req, res, (err?: unknown) => {
    if (err !== undefined) {
      next(err);
      return;
    }
    const bytes = rawBodyBytes.get(req) ?? 0;
    if (bytes > RPC_DEFAULT_BODY_LIMIT_BYTES) {
      const body: unknown = req.body;
      if (!isRecord(body) || body.method !== SEND_RAW_TX_METHOD) {
        next(tooLarge());
        return;
      }
    }
    next();
  });
};
