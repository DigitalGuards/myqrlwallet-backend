import { Router } from 'express';
import { normalizeRpcId, rpcService } from '../services/rpc.service.js';
import { asyncHandler } from '../utils/async-handler.js';
import { isRecord } from '../utils/guards.js';
import {
  rpcBatchReject,
  rpcMethodWhitelist,
  rpcRateLimitGeneral,
  rpcRateLimitWrite,
  rpcRequestSizeLimit,
  rpcParamsValidator,
  rpcSecurityLogger,
  getAllowedMethods,
} from '../middleware/rpc-security.js';

const router = Router();

// GET handler - return API documentation
router.get('/:network', (req, res) => {
  const methods = getAllowedMethods();
  res.json({
    name: 'QRL RPC Proxy',
    network: req.params.network,
    description:
      'JSON-RPC 2.0 proxy for the QRL Zond blockchain. Send POST requests with a JSON-RPC body.',
    usage: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        jsonrpc: '2.0',
        method: 'qrl_blockNumber',
        params: [],
        id: 1,
      },
    },
    allowed_methods: methods,
    rate_limits: {
      read: '1000 requests/min per IP',
      write: '10 requests/min per IP (sendRawTransaction, sendTransaction)',
    },
    max_payload: '50KB',
  });
});

// Apply security middleware in order:
// 1. Request size limit (reject oversized payloads early)
// 2. Batch reject (block batch requests)
// 3. Security logger (log all requests)
// 4. Method whitelist (block disallowed methods)
// 5. Params validator (validate input)
// 6. Rate limiters (apply appropriate limits)
router.post(
  '/:network',
  rpcRequestSizeLimit,
  rpcBatchReject,
  rpcSecurityLogger,
  rpcMethodWhitelist,
  rpcParamsValidator,
  rpcRateLimitGeneral,
  rpcRateLimitWrite,
  asyncHandler(async (req, res) => {
    const network = req.params.network ?? '';
    const body: unknown = req.body;
    const method = isRecord(body) && typeof body.method === 'string' ? body.method : '';
    const params = isRecord(body) ? body.params : undefined;
    // Forward the client's own JSON-RPC id so the response envelope echoes
    // it back, as the spec requires (the middleware chain already validated
    // method and params).
    const id = normalizeRpcId(isRecord(body) ? body.id : null);

    const result = await rpcService.executeRPC(network, method, params, id);
    res.json(result);
  })
);

export const rpcRoutes = router;
