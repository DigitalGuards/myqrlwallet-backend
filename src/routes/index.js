import { Router } from 'express';
import { healthRoutes } from './health.routes.js';
import { rpcRoutes } from './rpc.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/api/zond-rpc', rpcRoutes);

export const routes = router; 