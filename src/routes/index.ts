import { Router } from 'express';
import { healthRoutes } from './health.routes.js';
import { rpcRoutes } from './rpc.routes.js';
import { ipfsRouter } from './ipfs.routes.js';
import appRouter from './app.routes.js';
import { telegramRoutes } from './telegram.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/api/qrl-rpc', rpcRoutes);
router.use('/api/ipfs', ipfsRouter);
router.use('/api/telegram', telegramRoutes);
router.use('/api', appRouter);

export const routes = router;
