import { createServer } from 'node:http';
import type { Request, Response } from 'express';
import { app } from './app.js';
import { CONFIG } from './config/index.js';
import { createRelayServer } from './relay/relayServer.js';
import { timingSafeEqualStrings } from './crypto/primitives.js';
import { logger } from './utils/logger.js';
import { activeChannels, bufferedMessages, register } from './relay/metrics.js';
import { healthMonitor } from './services/rpc/healthMonitor.js';

const httpServer = createServer(app);

// Attach Socket.IO relay server
const relay = createRelayServer(httpServer);

/** Timing-safe token check to prevent timing attacks. */
function verifyStatsToken(req: Request, res: Response): boolean {
  const expectedToken = CONFIG.RELAY_STATS_TOKEN;
  if (expectedToken) {
    // A duplicated header arrives as an array; only the plain single-string
    // form can ever match.
    const header = req.headers['x-relay-stats-token'];
    const providedToken = typeof header === 'string' ? header : '';
    if (!timingSafeEqualStrings(expectedToken, providedToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
  } else if (CONFIG.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  return true;
}

/**
 * Refresh point-in-time relay gauges from the channel manager. Joins update
 * activeChannels eagerly, but channels also expire via TTL cleanup with no
 * gauge update, so scrape time is when the gauges are made truthful.
 */
function refreshRelayGauges(): void {
  const stats = relay.channelManager.getStats();
  activeChannels.set(relay.channelManager.getActiveChannelCount());
  bufferedMessages.set(stats.totalBufferedMessages);
}

// Relay stats health endpoint
app.get('/relay/stats', (req, res) => {
  if (!verifyStatsToken(req, res)) return;
  res.json(relay.channelManager.getStats());
});

// Prometheus metrics endpoint
app.get('/metrics', (req, res) => {
  if (!verifyStatsToken(req, res)) return;
  refreshRelayGauges();
  register
    .metrics()
    .then((body) => {
      res.set('Content-Type', register.contentType);
      res.end(body);
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Failed to collect metrics');
      res.status(500).json({ error: 'metrics collection failed' });
    });
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down relay server');
  healthMonitor.stop();
  relay.destroy();
  httpServer.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

httpServer.listen(CONFIG.PORT, () => {
  logger.info({ port: CONFIG.PORT }, 'Server started');
  logger.info('Socket.IO relay available at /relay');
  healthMonitor.start();
});
