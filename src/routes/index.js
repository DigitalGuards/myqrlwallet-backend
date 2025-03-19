import { Router } from 'express';
import { healthRoutes } from './health.routes.js';
import { rpcRoutes } from './rpc.routes.js';
import appRouter from './app.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/api/zond-rpc', rpcRoutes);
router.use('/api', appRouter);

export const routes = router; 