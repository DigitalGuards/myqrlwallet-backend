import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export type NetworkName = 'dev' | 'testnet' | 'mainnet';

export function isNetworkName(value: string): value is NetworkName {
  return value === 'dev' || value === 'testnet' || value === 'mainnet';
}

/**
 * Resolve the configured RPC endpoint list for a given network. Prefers the
 * comma-separated `RPC_ENDPOINTS_<NETWORK>` env var; falls back to the legacy
 * single-URL `RPC_ENDPOINT_<NETWORK>` env var; falls back to the supplied
 * default. Order matters: list[0] is the primary, list[1+] are failovers.
 */
function parseEndpointList(networkKey: string, fallback: string[] = []): string[] {
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

/**
 * Parse a positive-integer env var, falling back when unset, non-numeric,
 * zero, or negative. Caps, intervals, and timeouts fed to Socket.IO,
 * node-cache, and the health poller must never be NaN or <= 0; NaN
 * comparisons are always false, which silently disables the limit.
 */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Like parsePositiveInt but permits an explicit 0 (node-cache: 0 = no TTL).
 */
export function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export interface RpcHealthConfig {
  POLL_INTERVAL_MS: number;
  POLL_TIMEOUT_MS: number;
  REQUEST_TIMEOUT_MS: number;
  DOWN_AFTER_FAILURES: number;
  UP_AFTER_SUCCESSES: number;
  STALL_AFTER_MS: number;
}

export interface AppConfig {
  PORT: number;
  NODE_ENV: string;
  LOG_LEVEL: string;
  CACHE_TTL: number;
  RELAY_STATS_TOKEN: string;
  RELAY_MAX_ACTIVE_SOCKETS: number;
  RELAY_MAX_SOCKETS_PER_IP: number;
  RELAY_MAX_ACTIVE_CHANNELS: number;
  RELAY_PING_INTERVAL_MS: number;
  RELAY_PING_TIMEOUT_MS: number;
  ALLOWED_ORIGINS: string[];
  RPC_ENDPOINTS: Record<NetworkName, string[]>;
  RPC_HEALTH: RpcHealthConfig;
}

export const CONFIG: AppConfig = {
  PORT: parsePositiveInt(process.env.PORT, 3000),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  LOG_LEVEL: process.env.LOG_LEVEL ?? '',
  CACHE_TTL: parseNonNegativeInt(process.env.CACHE_TTL, 10),
  RELAY_STATS_TOKEN: process.env.RELAY_STATS_TOKEN ?? '',
  RELAY_MAX_ACTIVE_SOCKETS: parsePositiveInt(process.env.RELAY_MAX_ACTIVE_SOCKETS, 5000),
  RELAY_MAX_SOCKETS_PER_IP: parsePositiveInt(process.env.RELAY_MAX_SOCKETS_PER_IP, 25),
  RELAY_MAX_ACTIVE_CHANNELS: parsePositiveInt(process.env.RELAY_MAX_ACTIVE_CHANNELS, 20000),
  RELAY_PING_INTERVAL_MS: parsePositiveInt(process.env.RELAY_PING_INTERVAL_MS, 25000),
  RELAY_PING_TIMEOUT_MS: parsePositiveInt(process.env.RELAY_PING_TIMEOUT_MS, 20000),

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .filter((origin) => origin.length > 0),

  RPC_ENDPOINTS: {
    dev: parseEndpointList('DEV', ['http://localhost:8545']),
    testnet: parseEndpointList('TESTNET', ['http://localhost:8545']),
    mainnet: parseEndpointList('MAINNET', ['http://localhost:8545']),
  },

  RPC_HEALTH: {
    POLL_INTERVAL_MS: parsePositiveInt(process.env.RPC_HEALTH_POLL_INTERVAL_MS, 10000),
    POLL_TIMEOUT_MS: parsePositiveInt(process.env.RPC_HEALTH_POLL_TIMEOUT_MS, 5000),
    REQUEST_TIMEOUT_MS: parsePositiveInt(process.env.RPC_REQUEST_TIMEOUT_MS, 8000),
    DOWN_AFTER_FAILURES: parsePositiveInt(process.env.RPC_DOWN_AFTER_FAILURES, 3),
    UP_AFTER_SUCCESSES: parsePositiveInt(process.env.RPC_UP_AFTER_SUCCESSES, 3),
    STALL_AFTER_MS: parsePositiveInt(process.env.RPC_STALL_AFTER_MS, 300000), // 5 min
  },
};
