import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { CONFIG, isNetworkName } from '../config/index.js';
import { normalizeRpcId, type RpcId } from '../services/rpc.service.js';
import { isArray, isRecord } from '../utils/guards.js';
import { readStringParam } from '../utils/route-params.js';
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
const WRITE_METHODS = new Set(['qrl_sendRawTransaction']);

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
 * Parse a canonical hex block tag without losing precision. Named tags and
 * invalid values return null.
 */
const parseBlockTag = (v: unknown): bigint | null => {
  if (typeof v !== 'string') return null;
  if (v === 'latest' || v === 'pending' || v === 'earliest') return null;
  if (!/^0x[0-9a-f]{1,64}$/i.test(v)) return null;
  return BigInt(v);
};

const isNamedBlockTag = (v: unknown): boolean =>
  v === 'latest' || v === 'pending' || v === 'earliest';

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
    sendRpcError(res, 403, id, -32601, 'Method not allowed');
    return;
  }

  // Tag the request type for rate limiting
  req.rpcMethodType = WRITE_METHODS.has(method) ? 'write' : 'read';

  next();
};

/**
 * Admission limiter for every RPC request, including malformed, batched,
 * disallowed, and write requests. This must run before request validation so
 * rejected traffic cannot bypass admission accounting.
 */
export const rpcRateLimitGeneral = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: () => CONFIG.RPC_RATE_LIMIT_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Collapse arbitrary path values into one bucket. Valid configured
    // networks retain separate quotas without letting attackers rotate an
    // unbounded `:network` string to bypass admission or grow the store.
    const requestedNetwork = readStringParam(req, 'network');
    const network = isNetworkName(requestedNetwork) ? requestedNetwork : 'invalid';
    return `${ipKeyGenerator(req.ip ?? 'unknown')}-${network}`;
  },
  skip: (req) => req.method !== 'POST',
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
 * The configured limit is applied per IP and network.
 */
export const rpcRateLimitWrite = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: () => CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const requestedNetwork = readStringParam(req, 'network');
    const network = isNetworkName(requestedNetwork) ? requestedNetwork : 'invalid';
    return `${ipKeyGenerator(req.ip ?? 'unknown')}-write-${network}`;
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
      // Require canonical, byte-aligned hex rather than forwarding arbitrary
      // text that happens to carry a 0x prefix.
      if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(rawTx)) {
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
    case 'qrl_estimateGas': {
      // These require a transaction object
      if (!params || params.length < 1 || !isRecord(params[0])) {
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

      if (filter.blockHash !== undefined && filter.blockHash !== null) {
        if (
          typeof filter.blockHash !== 'string' ||
          !/^0x[a-fA-F0-9]{64}$/.test(filter.blockHash) ||
          filter.fromBlock !== undefined ||
          filter.toBlock !== undefined
        ) {
          sendRpcError(
            res,
            400,
            id,
            -32602,
            'Invalid params: blockHash must be a 32-byte hash and cannot be combined with a range'
          );
          return;
        }
      } else {
        const from = parseBlockTag(filter.fromBlock);
        const to = parseBlockTag(filter.toBlock);

        if (
          (filter.fromBlock !== undefined &&
            filter.fromBlock !== null &&
            from === null &&
            !isNamedBlockTag(filter.fromBlock)) ||
          (filter.toBlock !== undefined &&
            filter.toBlock !== null &&
            to === null &&
            !isNamedBlockTag(filter.toBlock))
        ) {
          sendRpcError(res, 400, id, -32602, 'Invalid params: invalid block tag');
          return;
        }

        // Open-ended scans from genesis are never legitimate. Compare on
        // the parsed numeric value so all hex variations of zero
        // ("0x0", "0x00", "0x000", ...) are caught; a literal-string
        // check would be trivially bypassable.
        if (filter.fromBlock === 'earliest' || from === 0n) {
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
          if (range < 0n || range > BigInt(MAX_GETLOGS_BLOCK_RANGE)) {
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

        // A numeric start combined with a dynamic or omitted end can cover
        // an unbounded range. Require a numeric end so the cap above is
        // enforceable without an extra upstream height lookup.
        const dynamicEnd =
          filter.toBlock === undefined ||
          filter.toBlock === null ||
          isNamedBlockTag(filter.toBlock);
        if (from !== null && dynamicEnd) {
          sendRpcError(
            res,
            400,
            id,
            -32602,
            'Invalid params: numeric fromBlock requires a numeric toBlock'
          );
          return;
        }
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
  const loggedMethod =
    typeof method === 'string'
      ? method.length <= 128
        ? method
        : `${method.slice(0, 128)}...`
      : undefined;
  const startTime = Date.now();

  // Log the request
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logEntry = {
      timestamp: new Date().toISOString(),
      ip: req.ip,
      network: req.params.network,
      method: loggedMethod,
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
