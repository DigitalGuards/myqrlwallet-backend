import fetch from 'node-fetch';
import { CONFIG } from '../config/index.js';
import { cache } from '../utils/cache.js';
import { healthMonitor } from './rpc/healthMonitor.js';

/**
 * RPC methods whose result is invariant for a given network and therefore safe
 * to cache. Everything else — balances, nonces, block numbers, contract state,
 * gas estimates, receipts, logs, writes — is state-dependent and MUST NOT be
 * cached, because caching state-dependent responses produces stale reads after
 * a transaction confirms (tx-state race condition).
 *
 * See: src/services/rpc.service.js history for the bug that motivated this
 * whitelist. Do not add state-dependent methods here without a write-through
 * invalidation strategy.
 */
const CACHEABLE_METHODS = new Set(['qrl_chainId', 'net_version']);

/**
 * Methods that must only run against a node we operate. Foundation public RPC
 * doesn't expose `txpool` (and may not expose `debug_*`), so for these we
 * never fail over — we let the request error out rather than route to a node
 * that will reply "method not found".
 */
const PRIMARY_ONLY_PREFIXES = ['txpool_', 'debug_', 'admin_'];

function isPrimaryOnlyMethod(method) {
  return PRIMARY_ONLY_PREFIXES.some((p) => method.startsWith(p));
}

/**
 * Validate a custom RPC URL to prevent SSRF attacks.
 * Blocks private IP ranges, localhost, cloud metadata endpoints, and non-HTTP protocols.
 */
function validateCustomRpcUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid custom RPC URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Custom RPC URL must use http or https protocol');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // Block IPv6 localhost
  if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
    throw new Error('Custom RPC URL cannot target localhost');
  }

  // Block localhost hostnames
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Custom RPC URL cannot target localhost');
  }

  // Block cloud metadata hostnames
  if (hostname === 'metadata.google.internal') {
    throw new Error('Custom RPC URL cannot target internal services');
  }

  // Block private/reserved IPv4 ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (a === 0) throw new Error('Custom RPC URL cannot target reserved addresses');
    if (a === 127) throw new Error('Custom RPC URL cannot target localhost');
    if (a === 10) throw new Error('Custom RPC URL cannot target private networks');
    if (a === 172 && b >= 16 && b <= 31)
      throw new Error('Custom RPC URL cannot target private networks');
    if (a === 192 && b === 168) throw new Error('Custom RPC URL cannot target private networks');
    if (a === 169 && b === 254)
      throw new Error('Custom RPC URL cannot target link-local addresses');
  }
}

class RPCService {
  async makeRPCCall(endpoint, method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.RPC_HEALTH.REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async executeRPC(network, method, params, customRpcUrl = '') {
    if (!CONFIG.RPC_ENDPOINTS[network]) {
      throw new Error('Invalid network');
    }

    if (network === 'custom') {
      if (customRpcUrl !== '') {
        validateCustomRpcUrl(customRpcUrl);
        return await this.makeRPCCall(customRpcUrl, method, params);
      }
      throw new Error('Invalid network');
    }

    const isCacheable = CACHEABLE_METHODS.has(method);
    const cacheKey = isCacheable ? `${network}-${method}-${JSON.stringify(params)}` : null;

    if (isCacheable) {
      const cachedResult = cache.get(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }
    }

    // Order endpoints by health; if monitor has no entries (e.g. startup before
    // first poll, or test setup), fall through to the static config list.
    let attemptOrder = healthMonitor.orderEndpointsForAttempt(network);
    if (attemptOrder.length === 0) {
      attemptOrder = Array.isArray(CONFIG.RPC_ENDPOINTS[network])
        ? [...CONFIG.RPC_ENDPOINTS[network]]
        : [];
    }
    if (attemptOrder.length === 0) {
      throw new Error('Invalid network');
    }

    // Pin primary-only methods to attemptOrder[0]; failing over `txpool_*` to a
    // node that doesn't expose it surfaces a confusing "method not found"
    // instead of a clean transport error.
    const order = isPrimaryOnlyMethod(method) ? attemptOrder.slice(0, 1) : attemptOrder.slice(0, 2);

    let lastError;
    let result;
    let chosenUrl;
    for (const url of order) {
      try {
        result = await this.makeRPCCall(url, method, params);
        chosenUrl = url;
        healthMonitor.recordRequestResult(network, url, true);
        break;
      } catch (err) {
        healthMonitor.recordRequestResult(network, url, false, err);
        lastError = err;
      }
    }

    if (chosenUrl === undefined) {
      throw lastError;
    }

    if (isCacheable) {
      cache.set(cacheKey, result);
    }
    return result;
  }
}

export const rpcService = new RPCService();
