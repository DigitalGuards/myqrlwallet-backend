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

  async executeRPC(network, method, params) {
    if (!CONFIG.RPC_ENDPOINTS[network]) {
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
      // Defensive: in current code paths `order` is always non-empty (we
      // throw earlier if `attemptOrder` is empty), so the loop runs at least
      // once and either sets `chosenUrl` or `lastError`. The `|| new Error`
      // fallback is belt-and-braces for future refactors that might widen
      // this path — never throw `undefined`.
      throw lastError || new Error('No endpoints attempted');
    }

    if (isCacheable) {
      cache.set(cacheKey, result);
    }
    return result;
  }
}

export const rpcService = new RPCService();
