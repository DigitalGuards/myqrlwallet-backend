import { Router } from 'express';
import { CONFIG } from '../config/index.js';
import { healthMonitor, type HealthSnapshot } from '../services/rpc/healthMonitor.js';

const router = Router();

// Process liveness is independent of external chain readiness. Container
// supervisors use this endpoint so an RPC stall does not create restart loops
// that erase relay state and health-monitor history.
router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

/**
 * Strip the `url` field from each endpoint entry. The internal healthMonitor
 * snapshot exposes the full upstream RPC URLs (primary/secondary nodes); we
 * don't want anonymous internet scanners enumerating that infra.
 * Index-by-position is preserved so the order still corresponds to the
 * configured RPC_ENDPOINTS_<NETWORK> list.
 */
const redactSnapshot = (snapshot: HealthSnapshot) => {
  const out: Record<string, object[]> = {};
  for (const [network, endpoints] of Object.entries(snapshot)) {
    out[network] = endpoints.map(({ url: _url, ...rest }, index) => ({
      index,
      ...rest,
    }));
  }
  return out;
};

router.get('/', (_req, res) => {
  const endpoints = redactSnapshot(healthMonitor.getSnapshot());
  const allRequiredHealthy =
    CONFIG.RPC_REQUIRED_NETWORKS.length > 0 &&
    CONFIG.RPC_REQUIRED_NETWORKS.every((network) => healthMonitor.hasHealthyForNetwork(network));
  const status = allRequiredHealthy ? 'ok' : 'degraded';
  const httpStatus = allRequiredHealthy ? 200 : 503;
  res.status(httpStatus).json({ status, endpoints });
});

export const healthRoutes = router;
