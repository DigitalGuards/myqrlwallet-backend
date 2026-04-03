import rateLimit from 'express-rate-limit';
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
 * Helper function to send JSON-RPC error responses
 */
const sendRpcError = (res, statusCode, id, errorCode, message) => {
  return res.status(statusCode).json({
    jsonrpc: '2.0',
    id: id || null,
    error: { code: errorCode, message },
  });
};

/**
 * Middleware to reject batch requests
 * Must be applied before other validation middleware
 */
export const rpcBatchReject = (req, res, next) => {
  if (Array.isArray(req.body)) {
    return sendRpcError(
      res,
      400,
      null,
      -32600,
      'Batch requests are not supported on this endpoint.'
    );
  }
  next();
};

/**
 * Middleware to validate and whitelist RPC methods
 */
export const rpcMethodWhitelist = (req, res, next) => {
  const { method, id } = req.body;

  // Validate method exists
  if (!method || typeof method !== 'string') {
    return sendRpcError(res, 400, id, -32600, 'Invalid Request: missing or invalid method');
  }

  // Check if method is allowed
  if (!ALLOWED_RPC_METHODS.has(method)) {
    log.warn({ method, ip: req.ip }, 'Blocked RPC method');
    return sendRpcError(res, 403, id, -32601, `Method not allowed: ${method}`);
  }

  // Tag the request type for rate limiting
  req.rpcMethodType = WRITE_METHODS.has(method) ? 'write' : 'read';

  next();
};

/**
 * Rate limiter for general RPC requests (read operations)
 * More lenient - 300 requests per minute per IP
 */
export const rpcRateLimitGeneral = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use IP + network as key for more granular limiting
    return `${req.ip}-${req.params.network || 'unknown'}`;
  },
  skip: (req) => req.rpcMethodType === 'write', // Skip for write methods (they have their own limiter)
  handler: (req, res) => {
    sendRpcError(res, 429, req.body?.id, -32005, 'Rate limit exceeded. Please try again later.');
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
    return `${req.ip}-write-${req.params.network || 'unknown'}`;
  },
  skip: (req) => req.rpcMethodType !== 'write', // Only apply to write methods
  handler: (req, res) => {
    sendRpcError(
      res,
      429,
      req.body?.id,
      -32005,
      'Transaction rate limit exceeded. Please wait before sending more transactions.'
    );
  },
});

/**
 * Request size limiter - prevent oversized payloads
 * Max 50KB should be more than enough for any legitimate RPC call
 */
export const rpcRequestSizeLimit = (req, res, next) => {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const MAX_SIZE = 50 * 1024; // 50KB

  if (contentLength > MAX_SIZE) {
    return sendRpcError(res, 413, req.body?.id, -32600, 'Request payload too large');
  }

  next();
};

/**
 * Validate params structure for known methods
 */
export const rpcParamsValidator = (req, res, next) => {
  const { method, params, id } = req.body;

  // Params should be an array or undefined/null
  if (params !== undefined && params !== null && !Array.isArray(params)) {
    return sendRpcError(res, 400, id, -32602, 'Invalid params: must be an array');
  }

  // Basic validation for specific methods
  switch (method) {
    case 'qrl_getBalance':
    case 'qrl_getTransactionCount':
    case 'qrl_getCode':
      // These require at least an address
      if (!params || params.length < 1 || typeof params[0] !== 'string') {
        return sendRpcError(res, 400, id, -32602, 'Invalid params: address required');
      }
      // Validate address format (Q or 0x + 40 hex chars)
      if (!/^(Q|0x)[a-fA-F0-9]{40}$/i.test(params[0])) {
        return sendRpcError(res, 400, id, -32602, 'Invalid params: invalid address format');
      }
      break;

    case 'qrl_sendRawTransaction':
      // Requires a hex-encoded signed transaction
      if (!params || params.length < 1 || typeof params[0] !== 'string') {
        return sendRpcError(res, 400, id, -32602, 'Invalid params: signed transaction required');
      }
      // Validate it starts with 0x
      if (!params[0].startsWith('0x')) {
        return sendRpcError(
          res,
          400,
          id,
          -32602,
          'Invalid params: transaction must be hex-encoded'
        );
      }
      break;

    case 'qrl_getTransactionReceipt':
      // Requires a transaction hash
      if (!params || params.length < 1 || typeof params[0] !== 'string') {
        return sendRpcError(res, 400, id, -32602, 'Invalid params: transaction hash required');
      }
      // Validate tx hash format (0x + 64 hex chars)
      if (!/^0x[a-fA-F0-9]{64}$/.test(params[0])) {
        return sendRpcError(
          res,
          400,
          id,
          -32602,
          'Invalid params: invalid transaction hash format'
        );
      }
      break;

    case 'qrl_call':
    case 'qrl_estimateGas':
      // These require a transaction object
      if (!params || params.length < 1 || typeof params[0] !== 'object') {
        return sendRpcError(res, 400, id, -32602, 'Invalid params: transaction object required');
      }
      break;
  }

  next();
};

/**
 * Log suspicious activity
 */
export const rpcSecurityLogger = (req, res, next) => {
  const { method } = req.body;
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
export const getAllowedMethods = () => Array.from(ALLOWED_RPC_METHODS);
