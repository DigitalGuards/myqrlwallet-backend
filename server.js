import { createServer } from 'http';
import { app } from './src/app.js';
import { CONFIG } from './src/config/index.js';
import { createRelayServer } from './src/relay/relayServer.js';

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

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down relay server...`);
  io.destroy?.();
  httpServer.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

httpServer.listen(CONFIG.PORT, () => {
  console.log(`Server running on port ${CONFIG.PORT}`);
  console.log(`Socket.IO relay available at /relay`);
});
