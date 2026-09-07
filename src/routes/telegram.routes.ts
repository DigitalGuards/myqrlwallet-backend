import { Router } from 'express';
import {
  handleTelegramUpdate,
  telegramConfigStatus,
  verifyTelegramWebhookSecret,
} from '../services/telegramBot.js';
import { CONFIG } from '../config/index.js';
import { healthMonitor } from '../services/rpc/healthMonitor.js';

const router = Router();

router.get('/status', (_req, res) => {
  const networks = Object.fromEntries(
    Object.keys(healthMonitor.getSnapshot()).map((network) => [
      network,
      healthMonitor.hasHealthyForNetwork(network) ? 'up' : 'degraded',
    ])
  );
  const healthy =
    CONFIG.RPC_REQUIRED_NETWORKS.length > 0 &&
    CONFIG.RPC_REQUIRED_NETWORKS.every((network) => healthMonitor.hasHealthyForNetwork(network));
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    networks,
    telegram: telegramConfigStatus(),
  });
});

router.post('/webhook', (req, res, next) => {
  const header = req.headers['x-telegram-bot-api-secret-token'];
  const provided = typeof header === 'string' ? header : '';
  if (!verifyTelegramWebhookSecret(provided)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  handleTelegramUpdate(req.body)
    .then(() => res.status(200).json({ ok: true }))
    .catch(next);
});

export const telegramRoutes = router;
