import { Router } from 'express';
import { rpcService } from '../services/rpc.service.js';
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
  async (req, res, next) => {
    try {
      const { network } = req.params;
      const { method, params } = req.body;

      const result = await rpcService.executeRPC(network, method, params);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export const rpcRoutes = router;
