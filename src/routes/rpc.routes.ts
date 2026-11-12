import { Router } from 'express';
import { CONFIG, isNetworkName } from '../config/index.js';
import { normalizeRpcId, rpcService } from '../services/rpc.service.js';
import { healthMonitor } from '../services/rpc/healthMonitor.js';
import { asyncHandler } from '../utils/async-handler.js';
import { readStringParam } from '../utils/route-params.js';
import { HttpError, isRecord } from '../utils/guards.js';
import { normalizeClientIpForLimits } from '../utils/client-ip.js';
import {
  RPC_DEFAULT_BODY_LIMIT_BYTES,
  RPC_LARGE_BODY_LIMIT_BYTES,
} from '../middleware/rpc-body.js';
import {
  rpcBatchReject,
  rpcMethodWhitelist,
  rpcRateLimitWrite,
  rpcParamsValidator,
  rpcSecurityLogger,
  getAllowedMethods,
} from '../middleware/rpc-security.js';

const router = Router();

// GET handler - return API documentation plus the network's state.
// `configured` reports a non-empty endpoint list; `ready` reports that at least
// one endpoint currently passes readiness and any configured identity pin.
router.get('/:network', (req, res) => {
  const network = readStringParam(req, 'network');
  if (!isNetworkName(network)) throw new HttpError(404, 'Unknown network');
  const methods = getAllowedMethods();
  res.json({
    name: 'QRL RPC Proxy',
    network,
    configured: CONFIG.RPC_ENDPOINTS[network].length > 0,
    ready: healthMonitor.hasHealthyForNetwork(network),
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
      large_body: `${CONFIG.RPC_LARGE_BODY_RATE_LIMIT_PER_MINUTE} requests/min per IP for bodies above ${RPC_DEFAULT_BODY_LIMIT_BYTES} bytes`,
    },
    max_payload: `${RPC_DEFAULT_BODY_LIMIT_BYTES} bytes (${RPC_LARGE_BODY_LIMIT_BYTES} bytes for qrl_sendRawTransaction, qrl_call and qrl_estimateGas)`,
  });
});

// Apply security middleware in order:
// The application-level admission limiter runs before JSON parsing. The
// JSON parser then enforces the 50 KiB body limit; a request that declares a
// larger length for qrl_sendRawTransaction, qrl_call or qrl_estimateGas is
// handled by the large-body limiter and parser (see rpc-body.ts).
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

    const result = await rpcService.executeRPC(
      network,
      method,
      params,
      id,
      normalizeClientIpForLimits(req.ip ?? 'unknown')
    );
    res.json(result);
  })
);

export const rpcRoutes = router;
