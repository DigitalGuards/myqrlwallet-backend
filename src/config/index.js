import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

/**
 * Resolve the configured RPC endpoint list for a given network. Prefers the
 * comma-separated `RPC_ENDPOINTS_<NETWORK>` env var; falls back to the legacy
 * single-URL `RPC_ENDPOINT_<NETWORK>` env var; falls back to the supplied
 * default. Order matters — list[0] is the primary, list[1+] are failovers.
 */
function parseEndpointList(networkKey, fallback = []) {
  const listVar = process.env[`RPC_ENDPOINTS_${networkKey}`];
  if (listVar) {
    const list = listVar
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  const singleVar = process.env[`RPC_ENDPOINT_${networkKey}`];
  if (singleVar) return [singleVar];
  return fallback;
}

export const CONFIG = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  LOG_LEVEL: process.env.LOG_LEVEL || '',
  CACHE_TTL: parseInt(process.env.CACHE_TTL || '10', 10),
  RELAY_STATS_TOKEN: process.env.RELAY_STATS_TOKEN || '',
  RELAY_MAX_ACTIVE_SOCKETS: parseInt(process.env.RELAY_MAX_ACTIVE_SOCKETS || '5000', 10),
  RELAY_MAX_SOCKETS_PER_IP: parseInt(process.env.RELAY_MAX_SOCKETS_PER_IP || '25', 10),
  RELAY_MAX_ACTIVE_CHANNELS: parseInt(process.env.RELAY_MAX_ACTIVE_CHANNELS || '20000', 10),

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .filter((origin) => origin.length > 0),

  RPC_ENDPOINTS: {
    dev: parseEndpointList('DEV', ['http://localhost:8545']),
    testnet: parseEndpointList('TESTNET', ['http://localhost:8545']),
    mainnet: parseEndpointList('MAINNET', ['http://localhost:8545']),
  },

  RPC_HEALTH: {
    POLL_INTERVAL_MS: parseInt(process.env.RPC_HEALTH_POLL_INTERVAL_MS || '10000', 10),
    POLL_TIMEOUT_MS: parseInt(process.env.RPC_HEALTH_POLL_TIMEOUT_MS || '5000', 10),
    REQUEST_TIMEOUT_MS: parseInt(process.env.RPC_REQUEST_TIMEOUT_MS || '8000', 10),
    DOWN_AFTER_FAILURES: parseInt(process.env.RPC_DOWN_AFTER_FAILURES || '3', 10),
    UP_AFTER_SUCCESSES: parseInt(process.env.RPC_UP_AFTER_SUCCESSES || '3', 10),
    STALL_AFTER_MS: parseInt(process.env.RPC_STALL_AFTER_MS || '300000', 10), // 5 min
  },
};
