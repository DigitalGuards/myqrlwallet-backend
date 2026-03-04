import { createServer } from 'http';
import { app } from './src/app.js';
import { CONFIG } from './src/config/index.js';
import { createRelayServer } from './src/relay/relayServer.js';

const httpServer = createServer(app);

// Attach Socket.IO relay server
const io = createRelayServer(httpServer);

// Relay stats health endpoint
app.get('/relay/stats', (req, res) => {
  res.json(io.channelManager.getStats());
});

httpServer.listen(CONFIG.PORT, () => {
  console.log(`Server running on port ${CONFIG.PORT}`);
  console.log(`Socket.IO relay available at /relay`);
});
