import { createServer } from 'http';
import { app } from './src/app.js';
import { CONFIG } from './src/config/index.js';
import { createRelayServer } from './src/relay/relayServer.js';
import { logger } from './src/utils/logger.js';
import { register } from './src/relay/metrics.js';

const httpServer = createServer(app);

// Attach Socket.IO relay server
const io = createRelayServer(httpServer);

// Relay stats health endpoint
app.get('/relay/stats', (req, res) => {
  const expectedToken = CONFIG.RELAY_STATS_TOKEN;
  if (expectedToken) {
    const providedToken = req.headers['x-relay-stats-token'];
    if (providedToken !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else if (CONFIG.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(io.channelManager.getStats());
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  const expectedToken = CONFIG.RELAY_STATS_TOKEN;
  if (expectedToken) {
    const providedToken = req.headers['x-relay-stats-token'];
    if (providedToken !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else if (CONFIG.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
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
