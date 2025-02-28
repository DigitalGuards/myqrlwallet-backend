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

// Add a new endpoint for custom testnet URL
router.post('/custom', async (req, res, next) => {
  try {
    const { url, method, params } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'Custom URL is required' });
    }

    const result = await rpcService.executeCustomRPC(url, method, params);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export const rpcRoutes = router; 