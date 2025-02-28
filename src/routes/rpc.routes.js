import { Router } from 'express';
import { rpcService } from '../services/rpc.service.js';

const router = Router();

router.post('/:network', async (req, res, next) => {
  try {
    const { network } = req.params;
    const { method, params } = req.body;
    
    const result = await rpcService.executeRPC(network, method, params);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export const rpcRoutes = router; 