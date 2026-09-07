import { Router } from 'express';
import { CONFIG } from '../config/index.js';
import { normalizeRpcId, rpcService } from '../services/rpc.service.js';
import { asyncHandler } from '../utils/async-handler.js';
import { readStringParam } from '../utils/route-params.js';
import { isRecord } from '../utils/guards.js';
import {
  rpcBatchReject,
  rpcMethodWhitelist,
  rpcRateLimitWrite,
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
      admission: `${CONFIG.RPC_RATE_LIMIT_PER_MINUTE} requests/min per IP for all RPC traffic`,
      write: `${CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE} requests/min per IP (sendRawTransaction)`,
    },
    max_payload: '50KB',
  });
});

// Apply security middleware in order:
// The application-level admission limiter runs before JSON parsing. The
// application JSON parser then enforces the actual 50KB decoded-body limit.
// Valid write methods pass through an additional stricter limiter here.
router.post(
  '/:network',
  rpcSecurityLogger,
  rpcBatchReject,
  rpcMethodWhitelist,
  rpcRateLimitWrite,
  rpcParamsValidator,
  asyncHandler(async (req, res) => {
    const network = readStringParam(req, 'network');
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
