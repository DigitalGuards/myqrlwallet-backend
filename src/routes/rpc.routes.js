import { Router } from 'express';
import { rpcService } from '../services/rpc.service.js';
import {
  rpcBatchReject,
  rpcMethodWhitelist,
  rpcRateLimitGeneral,
  rpcRateLimitWrite,
  rpcRequestSizeLimit,
  rpcParamsValidator,
  rpcSecurityLogger
} from '../middleware/rpc-security.js';

const router = Router();

// Apply security middleware in order:
// 1. Request size limit (reject oversized payloads early)
// 2. Batch reject (block batch requests)
// 3. Security logger (log all requests)
// 4. Method whitelist (block disallowed methods)
// 5. Params validator (validate input)
// 6. Rate limiters (apply appropriate limits)
router.post('/:network',
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

      let { customRpcUrl } = req.query;

      const result = await rpcService.executeRPC(network, method, params, customRpcUrl);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);


export const rpcRoutes = router;
