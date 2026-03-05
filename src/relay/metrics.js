/**
 * Prometheus metrics for the relay server.
 * Exposes counters, gauges, and histograms for monitoring.
 */
import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

const register = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register });

// --- Gauges (current values) ---

export const activeChannels = new Gauge({
  name: 'relay_active_channels',
  help: 'Number of active relay channels',
  registers: [register],
});

export const activeSockets = new Gauge({
  name: 'relay_active_sockets',
  help: 'Number of active socket connections',
  registers: [register],
});

export const bufferedMessages = new Gauge({
  name: 'relay_buffered_messages',
  help: 'Total number of buffered messages across all channels',
  registers: [register],
});

// --- Counters (cumulative) ---

export const messagesRouted = new Counter({
  name: 'relay_messages_routed_total',
  help: 'Total messages routed through the relay',
  labelNames: ['status'],
  registers: [register],
});

export const connectionsTotal = new Counter({
  name: 'relay_connections_total',
  help: 'Total socket connections',
  registers: [register],
});

export const rateLimitHits = new Counter({
  name: 'relay_rate_limit_hits_total',
  help: 'Total rate limit rejections',
  labelNames: ['bucket'],
  registers: [register],
});

export const channelJoins = new Counter({
  name: 'relay_channel_joins_total',
  help: 'Total channel join operations',
  labelNames: ['status'],
  registers: [register],
});

// --- Histograms ---

export const messageSize = new Histogram({
  name: 'relay_message_size_bytes',
  help: 'Size of messages in bytes',
  buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 256000],
  registers: [register],
});

export { register };
