import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { normalizeRpcId, type RpcId } from '../services/rpc.service.js';
import { isArray, isRecord } from '../utils/guards.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'rpc-security' });

/**
 * Whitelist of allowed RPC methods.
 * These are the only methods actually used by the frontend.
 */
const ALLOWED_RPC_METHODS = new Set([
  // Account/Balance Operations
  'qrl_getBalance',
  'qrl_getTransactionCount',
  'net_listening',

  // Transaction Operations
  'qrl_gasPrice',
  'qrl_estimateGas',
  'qrl_sendRawTransaction',
  'qrl_sendTransaction',
  'qrl_getTransactionReceipt',

  // Contract Operations
  'qrl_getCode',
  'qrl_call', // Used for ERC20 calls (balanceOf, name, symbol, decimals)
  'qrl_getLogs', // Used for fetching event logs (token transfers, contract events)

  // Block info (needed by web3.js internally)
  'qrl_chainId',
  'qrl_blockNumber',
  'qrl_getBlockByNumber', // Needed for event watching (token transfers, contract events)
  'net_version',
]);

/**
 * Methods that modify state or are expensive - apply stricter rate limits
 */
const WRITE_METHODS = new Set(['qrl_sendRawTransaction', 'qrl_sendTransaction']);

/**
 * qrl_getLogs bounds. Without these a single request can ask the node to
 * scan the whole chain, monopolising RPC capacity for everyone else.
 */
const MAX_GETLOGS_BLOCK_RANGE = 5000; // ~16-17 hours of QRL Zond blocks
const MAX_GETLOGS_ADDRESSES = 10;

/**
 * The request body as parsed by express.json(): typed `any` by Express, so
 * every consumer goes through this single seam that re-types it as unknown
 * and extracts the JSON-RPC fields via runtime checks.
 */
interface RpcRequestBody {
  method: unknown;
  params: unknown;
  id: RpcId;
}

function readRpcBody(req: Request): RpcRequestBody {
  const body: unknown = req.body;
  if (!isRecord(body)) {
    return { method: undefined, params: undefined, id: null };
  }
  return { method: body.method, params: body.params, id: normalizeRpcId(body.id) };
}

/**
 * Parse a hex block tag to a Number, or null for named tags / invalid input.
 */
const parseBlockTag = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  if (v === 'latest' || v === 'pending' || v === 'earliest') return null;
  if (!v.startsWith('0x')) return null;
  const n = parseInt(v, 16);
  return Number.isFinite(n) ? n : null;
};

/**
 * Helper function to send JSON-RPC error responses
 */
const sendRpcError = (
  res: Response,
  statusCode: number,
  id: RpcId,
  errorCode: number,
  message: string
): void => {
  res.status(statusCode).json({
    jsonrpc: '2.0',
    id,
    error: { code: errorCode, message },
  });
};

/**
 * Middleware to reject batch requests
 * Must be applied before other validation middleware
 */
export const rpcBatchReject = (req: Request, res: Response, next: NextFunction): void => {
  if (Array.isArray(req.body)) {
    sendRpcError(res, 400, null, -32600, 'Batch requests are not supported on this endpoint.');
    return;
  }
  next();
};

/**
 * Middleware to validate and whitelist RPC methods
 */
export const rpcMethodWhitelist = (req: Request, res: Response, next: NextFunction): void => {
  const { method, id } = readRpcBody(req);

  // Validate method exists
  if (!method || typeof method !== 'string') {
    sendRpcError(res, 400, id, -32600, 'Invalid Request: missing or invalid method');
    return;
  }

  // Check if method is allowed
  if (!ALLOWED_RPC_METHODS.has(method)) {
    log.warn({ method, ip: req.ip }, 'Blocked RPC method');
    sendRpcError(res, 403, id, -32601, `Method not allowed: ${method}`);
    return;
  }

  // Tag the request type for rate limiting
  req.rpcMethodType = WRITE_METHODS.has(method) ? 'write' : 'read';

  next();
};

/**
 * Rate limiter for general RPC requests (read operations).
 * More lenient: 1000 requests per minute per IP.
 */
export const rpcRateLimitGeneral = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use IP + network as key for more granular limiting
    return `${req.ip ?? 'unknown'}-${req.params.network ?? 'unknown'}`;
  },
  skip: (req) => req.rpcMethodType === 'write', // Skip for write methods (they have their own limiter)
  handler: (req, res) => {
    sendRpcError(
      res,
      429,
      readRpcBody(req).id,
      -32005,
      'Rate limit exceeded. Please try again later.'
    );
  },
});

/**
 * Stricter rate limiter for write operations (sending transactions)
 * 10 transactions per minute per IP
 */
export const rpcRateLimitWrite = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 write operations per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return `${req.ip ?? 'unknown'}-write-${req.params.network ?? 'unknown'}`;
  },
  skip: (req) => req.rpcMethodType !== 'write', // Only apply to write methods
  handler: (req, res) => {
    sendRpcError(
      res,
      429,
      readRpcBody(req).id,
      -32005,
      'Transaction rate limit exceeded. Please wait before sending more transactions.'
    );
  },
});

/**
 * Request size limiter - prevent oversized payloads
 * Max 50KB should be more than enough for any legitimate RPC call
 */
export const rpcRequestSizeLimit = (req: Request, res: Response, next: NextFunction): void => {
  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  const MAX_SIZE = 50 * 1024; // 50KB

  if (contentLength > MAX_SIZE) {
    sendRpcError(res, 413, readRpcBody(req).id, -32600, 'Request payload too large');
    return;
  }

  next();
};

/**
 * Validate params structure for known methods
 */
export const rpcParamsValidator = (req: Request, res: Response, next: NextFunction): void => {
  const { method, params, id } = readRpcBody(req);

  // Params should be an array or undefined/null
  if (params !== undefined && params !== null && !isArray(params)) {
    sendRpcError(res, 400, id, -32602, 'Invalid params: must be an array');
    return;
  }

  // Basic validation for specific methods
  switch (method) {
    case 'qrl_getBalance':
    case 'qrl_getTransactionCount':
    case 'qrl_getCode': {
      // These require at least an address
      const address = params?.[0];
      if (typeof address !== 'string') {
        sendRpcError(res, 400, id, -32602, 'Invalid params: address required');
        return;
      }
      // Validate address format (Q + 40 hex chars)
      if (!/^Q[a-fA-F0-9]{40}$/i.test(address)) {
        sendRpcError(res, 400, id, -32602, 'Invalid params: invalid address format');
        return;
      }
      break;
    }

    case 'qrl_sendRawTransaction': {
      // Requires a hex-encoded signed transaction
      const rawTx = params?.[0];
      if (typeof rawTx !== 'string') {
        sendRpcError(res, 400, id, -32602, 'Invalid params: signed transaction required');
        return;
      }
      // Validate it starts with 0x
      if (!rawTx.startsWith('0x')) {
        sendRpcError(res, 400, id, -32602, 'Invalid params: transaction must be hex-encoded');
        return;
      }
      break;
    }

    case 'qrl_getTransactionReceipt': {
      // Requires a transaction hash
      const txHash = params?.[0];
      if (typeof txHash !== 'string') {
        sendRpcError(res, 400, id, -32602, 'Invalid params: transaction hash required');
        return;
      }
      // Validate tx hash format (0x + 64 hex chars)
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        sendRpcError(res, 400, id, -32602, 'Invalid params: invalid transaction hash format');
        return;
      }
      break;
    }

    case 'qrl_call':
    case 'qrl_estimateGas':
    case 'qrl_sendTransaction': {
      // These require a transaction object
      if (!params || params.length < 1 || typeof params[0] !== 'object') {
        sendRpcError(res, 400, id, -32602, 'Invalid params: transaction object required');
        return;
      }
      break;
    }

    case 'qrl_getLogs': {
      // Bound the request before proxying; otherwise a caller can ask the
      // node to scan from genesis to tip, blocking the RPC for everyone
      // else for seconds. blockHash form (single-block) is always fine.
      const filter = params?.[0];
      if (!isRecord(filter)) {
        sendRpcError(res, 400, id, -32602, 'Invalid params: filter object required');
        return;
      }

      if (typeof filter.blockHash !== 'string') {
        const from = parseBlockTag(filter.fromBlock);
        const to = parseBlockTag(filter.toBlock);

        // Open-ended scans from genesis are never legitimate. Compare on
        // the parsed numeric value so all hex variations of zero
        // ("0x0", "0x00", "0x000", ...) are caught; a literal-string
        // check would be trivially bypassable.
        if (filter.fromBlock === 'earliest' || from === 0) {
          sendRpcError(
            res,
            400,
            id,
            -32602,
            'Invalid params: qrl_getLogs from genesis is not allowed; supply a recent fromBlock'
          );
          return;
        }

        // Both sides numeric → enforce the range cap directly.
        if (from !== null && to !== null) {
          const range = to - from;
          if (range < 0 || range > MAX_GETLOGS_BLOCK_RANGE) {
            sendRpcError(
              res,
              400,
              id,
              -32602,
              `Invalid params: qrl_getLogs block range exceeds ${MAX_GETLOGS_BLOCK_RANGE}`
            );
            return;
          }
        }
        // Known gap: when `to` is "latest"/"pending" and `from` is a
        // small-but-nonzero number, the range check is bypassed.
        // Closing that requires querying current chain height from
        // here (currently the middleware has no access to
        // healthMonitor's lastHeight). Tracked for the next sprint;
        // the genesis check above still covers the worst case.
      }

      // Address filter: require the canonical QRL v2 form (Q + 40 hex
      // chars). Also cap array length so a single request can't fan out
      // into N parallel address lookups on the node.
      if (filter.address !== undefined && filter.address !== null) {
        const addrs = isArray(filter.address) ? filter.address : [filter.address];
        if (addrs.length > MAX_GETLOGS_ADDRESSES) {
          sendRpcError(
            res,
            400,
            id,
            -32602,
            `Invalid params: too many addresses (max ${MAX_GETLOGS_ADDRESSES})`
          );
          return;
        }
        for (const a of addrs) {
          if (typeof a !== 'string' || !/^Q[a-fA-F0-9]{40}$/i.test(a)) {
            sendRpcError(
              res,
              400,
              id,
              -32602,
              'Invalid params: QRL addresses must match Q + 40 hex chars'
            );
            return;
          }
        }
      }
      break;
    }
  }

  next();
};

/**
 * Log suspicious activity
 */
export const rpcSecurityLogger = (req: Request, res: Response, next: NextFunction): void => {
  const { method } = readRpcBody(req);
  const startTime = Date.now();

  // Log the request
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logEntry = {
      timestamp: new Date().toISOString(),
      ip: req.ip,
      network: req.params.network,
      method,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
    };

    // Log errors or slow requests
    if (res.statusCode >= 400 || duration > 5000) {
      log.warn(logEntry, 'RPC security event');
    }
  });

  next();
};

// Export the allowed methods for testing/documentation
export const getAllowedMethods = (): string[] => Array.from(ALLOWED_RPC_METHODS);
