import dotenv from 'dotenv';
import { isIP } from 'node:net';

// Load environment variables from .env file
dotenv.config({ quiet: true });

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

/** Gateway configuration is validated before the application can listen. */
export function parseIpfsGateways(list: unknown, legacy: unknown): string[] {
  if (list === undefined && legacy === undefined) {
    // ipfs.io and dweb.link share an operator and rate limit. Pinata gives
    // the first fallback an independent capacity pool.
    return [
      'https://ipfs.io/ipfs/',
      'https://gateway.pinata.cloud/ipfs/',
      'https://dweb.link/ipfs/',
    ];
  }

  const name = list === undefined ? 'IPFS_GATEWAY' : 'IPFS_GATEWAYS';
  const value = list === undefined ? legacy : list;
  if (typeof value !== 'string') throw new Error(`${name} must contain HTTPS gateway URLs`);
  const entries = list === undefined ? [value] : value.split(',');
  return Array.from(
    new Set(
      entries.map((entry, index) => {
        const input = entry.trim();
        try {
          const url = new URL(input);
          const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
          url.pathname = url.pathname.replace(/\/+$/, '') + '/';
          if (
            !/^https:\/\/[^/]/i.test(input) ||
            /[\\\s@?#,]/.test(input) ||
            url.protocol !== 'https:' ||
            url.hostname.length === 0 ||
            isIP(hostname) !== 0 ||
            url.port === '0' ||
            url.pathname !== '/ipfs/' ||
            url.username ||
            url.password
          ) {
            throw new Error('invalid gateway');
          }
          return url.href;
        } catch {
          throw new Error(
            `${name} entry ${index + 1} must be an absolute HTTPS URL with a DNS hostname, a nonzero port, and base path /ipfs/ without credentials, query, or fragment`
          );
        }
      })
    )
  );
}

function loadIpfsGateways(): string[] {
  try {
    return parseIpfsGateways(process.env.IPFS_GATEWAYS, process.env.IPFS_GATEWAY);
  } catch (error) {
    // Configuration initializes before the structured logger is available.
    console.error(
      'Invalid IPFS gateway configuration:',
      error instanceof Error ? error.message : 'invalid value'
    );
    throw error;
  }
}

export interface RpcHealthConfig {
  POLL_INTERVAL_MS: number;
  POLL_TIMEOUT_MS: number;
  REQUEST_TIMEOUT_MS: number;
  DOWN_AFTER_FAILURES: number;
  UP_AFTER_SUCCESSES: number;
  STALL_AFTER_MS: number;
  MAX_HEAD_AGE_MS: number;
  MAX_HEAD_FUTURE_MS: number;
  MAX_LAG_BLOCKS: number;
}

export interface RpcIdentity {
  chainId: string;
  genesisHash: string;
}

/** Both pins are optional together. Partial or malformed identity configuration is fatal. */
export function parseRpcIdentity(
  chainId: string | undefined,
  genesisHash: string | undefined
): RpcIdentity | null {
  if (chainId === undefined && genesisHash === undefined) return null;
  if (
    chainId === undefined ||
    genesisHash === undefined ||
    !/^[1-9][0-9]{0,77}$/.test(chainId) ||
    !/^0x[0-9a-fA-F]{64}$/.test(genesisHash) ||
    BigInt(chainId) >= 1n << 256n
  ) {
    throw new Error(
      'RPC expected identity requires both a positive decimal uint256 chain ID and a 32-byte genesis hash'
    );
  }
  return { chainId: `0x${BigInt(chainId).toString(16)}`, genesisHash: genesisHash.toLowerCase() };
}

export interface AppConfig {
  PORT: number;
  LISTEN_HOST: string;
  NODE_ENV: string;
  LOG_LEVEL: string;
  CACHE_TTL: number;
  RELAY_STATS_TOKEN: string;
  RELAY_MAX_ACTIVE_SOCKETS: number;
  RELAY_MAX_SOCKETS_PER_IP: number;
  RELAY_MAX_ACTIVE_CHANNELS: number;
  RELAY_MAX_CHANNELS_PER_IP: number;
  RELAY_MAX_BUFFERED_BYTES_PER_CHANNEL: number;
  RELAY_MAX_BUFFERED_BYTES_PER_IP: number;
  RELAY_MAX_BUFFERED_BYTES_GLOBAL: number;
  RELAY_PING_INTERVAL_MS: number;
  RELAY_PING_TIMEOUT_MS: number;
  TRUSTED_PROXY_CIDRS: string[];
  ALLOWED_ORIGINS: string[];
  RPC_ENDPOINTS: Record<NetworkName, string[]>;
  RPC_EXPECTED_IDENTITIES: Record<NetworkName, RpcIdentity | null>;
  TX_HISTORY_ORIGINS: Record<NetworkName, string | null>;
  RPC_REQUIRED_NETWORKS: NetworkName[];
  RPC_HEALTH: RpcHealthConfig;
  RPC_RATE_LIMIT_PER_MINUTE: number;
  RPC_WRITE_RATE_LIMIT_PER_MINUTE: number;
  RPC_MAX_RESPONSE_BYTES: number;
  RPC_MAX_CONCURRENT: number;
  RPC_MAX_CONCURRENT_PER_CLIENT: number;
  RPC_MAX_INFLIGHT_BYTES: number;
  IPFS_GATEWAYS: string[];
  IPFS_FETCH_TIMEOUT_MS: number;
  IPFS_FALLBACK_RESERVE_MS: number;
  IPFS_MAX_COOLDOWN_MS: number;
  IPFS_MAX_SIZE_BYTES: number;
  IPFS_MAX_CONCURRENT: number;
  IPFS_MAX_INFLIGHT_BYTES: number;
}

export function resolveListenHost(value: string | undefined): string {
  const host = value?.trim();
  if (host === undefined || host.length === 0) return '127.0.0.1';
  return host;
}

/** History destinations are configured by the server and contain only an origin. */
export function parseHistoryOrigin(
  value: string | undefined,
  fallback: string | null
): string | null {
  if (value === undefined) return fallback;
  const input = value.trim();
  if (input.length === 0) return null;
  const url = new URL(input);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Transaction-history origin must be credential-free HTTPS or loopback HTTP');
  }
  return url.origin;
}

function parseRequiredNetworks(value: string | undefined): NetworkName[] {
  const requested = (value ?? 'testnet')
    .split(',')
    .map((network) => network.trim().toLowerCase())
    .filter(isNetworkName);
  return Array.from(new Set(requested));
}

const rpcMaxConcurrent = parsePositiveInt(process.env.RPC_MAX_CONCURRENT, 16);
const rpcMaxResponseBytes = parsePositiveInt(process.env.RPC_MAX_RESPONSE_BYTES, 8 * 1024 * 1024);

export const CONFIG: AppConfig = {
  PORT: parsePositiveInt(process.env.PORT, 3000),
  // Binding to loopback is the safe default for the PM2 + local-nginx
  // deployment. Containers that deliberately listen on their pod network
  // must opt in with LISTEN_HOST=0.0.0.0.
  LISTEN_HOST: resolveListenHost(process.env.LISTEN_HOST),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  LOG_LEVEL: process.env.LOG_LEVEL ?? '',
  CACHE_TTL: parseNonNegativeInt(process.env.CACHE_TTL, 10),
  RELAY_STATS_TOKEN: process.env.RELAY_STATS_TOKEN ?? '',
  RELAY_MAX_ACTIVE_SOCKETS: parsePositiveInt(process.env.RELAY_MAX_ACTIVE_SOCKETS, 5000),
  RELAY_MAX_SOCKETS_PER_IP: parsePositiveInt(process.env.RELAY_MAX_SOCKETS_PER_IP, 25),
  RELAY_MAX_ACTIVE_CHANNELS: parsePositiveInt(process.env.RELAY_MAX_ACTIVE_CHANNELS, 20000),
  RELAY_MAX_CHANNELS_PER_IP: parsePositiveInt(process.env.RELAY_MAX_CHANNELS_PER_IP, 25),
  RELAY_MAX_BUFFERED_BYTES_PER_CHANNEL: parsePositiveInt(
    process.env.RELAY_MAX_BUFFERED_BYTES_PER_CHANNEL,
    2 * 1024 * 1024
  ),
  RELAY_MAX_BUFFERED_BYTES_PER_IP: parsePositiveInt(
    process.env.RELAY_MAX_BUFFERED_BYTES_PER_IP,
    8 * 1024 * 1024
  ),
  RELAY_MAX_BUFFERED_BYTES_GLOBAL: parsePositiveInt(
    process.env.RELAY_MAX_BUFFERED_BYTES_GLOBAL,
    64 * 1024 * 1024
  ),
  RELAY_PING_INTERVAL_MS: parsePositiveInt(process.env.RELAY_PING_INTERVAL_MS, 25000),
  RELAY_PING_TIMEOUT_MS: parsePositiveInt(process.env.RELAY_PING_TIMEOUT_MS, 20000),

  // Forwarding headers are ignored unless the direct peer matches one of
  // these ranges. Production nginx runs on loopback; Cloudflare/other proxy
  // ranges must be opted in explicitly when they connect to Node directly.
  TRUSTED_PROXY_CIDRS: (
    process.env.TRUSTED_PROXY_CIDRS ??
    ((process.env.NODE_ENV ?? 'development') === 'production' ? 'loopback' : '')
  )
    .split(',')
    .map((cidr) => cidr.trim())
    .filter(Boolean),

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .filter((origin) => origin.length > 0),

  RPC_ENDPOINTS: {
    dev: parseEndpointList('DEV', ['http://localhost:8545']),
    testnet: parseEndpointList('TESTNET', ['http://localhost:8545']),
    mainnet: parseEndpointList('MAINNET', ['http://localhost:8545']),
  },

  RPC_EXPECTED_IDENTITIES: {
    dev: parseRpcIdentity(
      process.env.RPC_EXPECTED_CHAIN_ID_DEV,
      process.env.RPC_EXPECTED_GENESIS_HASH_DEV
    ),
    testnet: parseRpcIdentity(
      process.env.RPC_EXPECTED_CHAIN_ID_TESTNET,
      process.env.RPC_EXPECTED_GENESIS_HASH_TESTNET
    ),
    mainnet: parseRpcIdentity(
      process.env.RPC_EXPECTED_CHAIN_ID_MAINNET,
      process.env.RPC_EXPECTED_GENESIS_HASH_MAINNET
    ),
  },

  TX_HISTORY_ORIGINS: {
    dev: parseHistoryOrigin(process.env.TX_HISTORY_ORIGIN_DEV, null),
    testnet: parseHistoryOrigin(process.env.TX_HISTORY_ORIGIN_TESTNET, 'https://zondscan.com'),
    mainnet: parseHistoryOrigin(process.env.TX_HISTORY_ORIGIN_MAINNET, null),
  },

  RPC_REQUIRED_NETWORKS: parseRequiredNetworks(process.env.RPC_REQUIRED_NETWORKS),

  RPC_HEALTH: {
    POLL_INTERVAL_MS: parsePositiveInt(process.env.RPC_HEALTH_POLL_INTERVAL_MS, 10000),
    POLL_TIMEOUT_MS: parsePositiveInt(process.env.RPC_HEALTH_POLL_TIMEOUT_MS, 5000),
    REQUEST_TIMEOUT_MS: parsePositiveInt(process.env.RPC_REQUEST_TIMEOUT_MS, 8000),
    DOWN_AFTER_FAILURES: parsePositiveInt(process.env.RPC_DOWN_AFTER_FAILURES, 3),
    UP_AFTER_SUCCESSES: parsePositiveInt(process.env.RPC_UP_AFTER_SUCCESSES, 3),
    STALL_AFTER_MS: parsePositiveInt(process.env.RPC_STALL_AFTER_MS, 300000), // 5 min
    MAX_HEAD_AGE_MS: parsePositiveInt(process.env.RPC_MAX_HEAD_AGE_MS, 300000),
    MAX_HEAD_FUTURE_MS: parsePositiveInt(process.env.RPC_MAX_HEAD_FUTURE_MS, 60000),
    MAX_LAG_BLOCKS: parseNonNegativeInt(process.env.RPC_MAX_LAG_BLOCKS, 8),
  },

  RPC_RATE_LIMIT_PER_MINUTE: parsePositiveInt(process.env.RPC_RATE_LIMIT_PER_MINUTE, 1000),
  RPC_WRITE_RATE_LIMIT_PER_MINUTE: parsePositiveInt(
    process.env.RPC_WRITE_RATE_LIMIT_PER_MINUTE,
    10
  ),
  RPC_MAX_RESPONSE_BYTES: rpcMaxResponseBytes,
  RPC_MAX_CONCURRENT: rpcMaxConcurrent,
  RPC_MAX_CONCURRENT_PER_CLIENT: parsePositiveInt(process.env.RPC_MAX_CONCURRENT_PER_CLIENT, 4),
  // Defaults to CONCURRENT x RESPONSE so RPC_MAX_CONCURRENT is the binding
  // limit; an explicit smaller value lowers the effective concurrency.
  RPC_MAX_INFLIGHT_BYTES: parsePositiveInt(
    process.env.RPC_MAX_INFLIGHT_BYTES,
    rpcMaxConcurrent * rpcMaxResponseBytes
  ),

  IPFS_GATEWAYS: loadIpfsGateways(),
  IPFS_FETCH_TIMEOUT_MS: parsePositiveInt(process.env.IPFS_FETCH_TIMEOUT_MS, 8000),
  IPFS_FALLBACK_RESERVE_MS: Math.max(
    250,
    parsePositiveInt(process.env.IPFS_FALLBACK_RESERVE_MS, 1000)
  ),
  IPFS_MAX_COOLDOWN_MS: Math.max(
    900_000,
    parsePositiveInt(process.env.IPFS_MAX_COOLDOWN_MS, 900_000)
  ),
  IPFS_MAX_SIZE_BYTES: parsePositiveInt(process.env.IPFS_MAX_SIZE_BYTES, 10 * 1024 * 1024),
  IPFS_MAX_CONCURRENT: parsePositiveInt(process.env.IPFS_MAX_CONCURRENT, 8),
  IPFS_MAX_INFLIGHT_BYTES: parsePositiveInt(process.env.IPFS_MAX_INFLIGHT_BYTES, 40 * 1024 * 1024),
};
