import { createServer } from 'http';
import { timingSafeEqual } from 'crypto';
import { app } from './src/app.js';
import { CONFIG } from './src/config/index.js';
import { createRelayServer } from './src/relay/relayServer.js';
import { logger } from './src/utils/logger.js';
import { register } from './src/relay/metrics.js';

const httpServer = createServer(app);

// Attach Socket.IO relay server
const io = createRelayServer(httpServer);

/** Timing-safe token check to prevent timing attacks. */
function verifyStatsToken(req, res) {
  const expectedToken = CONFIG.RELAY_STATS_TOKEN;
  if (expectedToken) {
    const providedToken = req.headers['x-relay-stats-token'] || '';
    const expectedBuf = Buffer.from(expectedToken);
    const providedBuf = Buffer.from(providedToken);
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
  } else if (CONFIG.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  return true;
}

// Relay stats health endpoint
app.get('/relay/stats', (req, res) => {
  if (!verifyStatsToken(req, res)) return;
  res.json(io.channelManager.getStats());
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  if (!verifyStatsToken(req, res)) return;
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down relay server');
  io.destroy?.();
  httpServer.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

httpServer.listen(CONFIG.PORT, () => {
  logger.info({ port: CONFIG.PORT }, 'Server started');
  logger.info('Socket.IO relay available at /relay');
});
