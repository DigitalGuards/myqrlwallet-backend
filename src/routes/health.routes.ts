import { Router } from 'express';
import { healthMonitor, type HealthSnapshot } from '../services/rpc/healthMonitor.js';

const router = Router();

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
  const networks = Object.keys(endpoints);
  const anyHealthy =
    networks.length === 0 || networks.some((n) => healthMonitor.hasHealthyForNetwork(n));
  const status = anyHealthy ? 'ok' : 'degraded';
  const httpStatus = anyHealthy ? 200 : 503;
  res.status(httpStatus).json({ status, endpoints });
});

export const healthRoutes = router;
