import { Router } from 'express';
import { healthMonitor } from '../services/rpc/healthMonitor.js';

const router = Router();

router.get('/', (req, res) => {
  const endpoints = healthMonitor.getSnapshot();
  const networks = Object.keys(endpoints);
  const anyHealthy =
    networks.length === 0 || networks.some((n) => healthMonitor.hasHealthyForNetwork(n));
  const status = anyHealthy ? 'ok' : 'degraded';
  const httpStatus = anyHealthy ? 200 : 503;
  res.status(httpStatus).json({ status, endpoints });
});

export const healthRoutes = router;
