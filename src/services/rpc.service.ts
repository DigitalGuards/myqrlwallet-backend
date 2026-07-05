import { CONFIG, isNetworkName } from '../config/index.js';
import { cache } from '../utils/cache.js';
import { isRecord, toError } from '../utils/guards.js';
import { healthMonitor } from './rpc/healthMonitor.js';

/**
 * RPC methods whose result is invariant for a given network and therefore safe
 * to cache. Everything else (balances, nonces, block numbers, contract state,
 * gas estimates, receipts, logs, writes) is state-dependent and MUST NOT be
 * cached, because caching state-dependent responses produces stale reads after
 * a transaction confirms (tx-state race condition).
 *
 * See: src/services/rpc.service.ts history for the bug that motivated this
 * whitelist. Do not add state-dependent methods here without a write-through
 * invalidation strategy.
 */
const CACHEABLE_METHODS = new Set(['qrl_chainId', 'net_version']);

/**
 * Methods that must only run against a node we operate. Foundation public RPC
 * doesn't expose `txpool` (and may not expose `debug_*`), so for these we
 * never fail over; we let the request error out rather than route to a node
 * that will reply "method not found".
 */
const PRIMARY_ONLY_PREFIXES = ['txpool_', 'debug_', 'admin_'];

function isPrimaryOnlyMethod(method: string): boolean {
  return PRIMARY_ONLY_PREFIXES.some((p) => method.startsWith(p));
}

/** JSON-RPC 2.0 request id as the spec allows it: string, number, or null. */
export type RpcId = string | number | null;

/**
 * Normalize an untrusted `id` from a client request body. Invalid types (and
 * absurdly long strings, which would otherwise be echoed and cached) degrade
 * to null rather than erroring; the spec treats null as a valid id.
 */
export function normalizeRpcId(raw: unknown): RpcId {
  if (typeof raw === 'string' && raw.length <= 256) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return null;
}

class RPCService {
  async makeRPCCall(
    endpoint: string,
    method: string,
    params: unknown,
    id: RpcId = null
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, CONFIG.RPC_HEALTH.REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // The client's own id is forwarded so the upstream response envelope
        // already carries the id the client expects; the proxy never has to
        // rewrite it. (Previously this sent Date.now(), which broke JSON-RPC
        // id semantics for any client that validates the echo.)
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
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

  async executeRPC(
    network: string,
    method: string,
    params: unknown,
    id: RpcId = null
  ): Promise<unknown> {
    if (!isNetworkName(network)) {
      throw new Error('Invalid network');
    }

    const isCacheable = CACHEABLE_METHODS.has(method);
    const cacheKey = `${network}-${method}-${JSON.stringify(params)}`;

    if (isCacheable) {
      // Only the upstream `result` value is cached, never the envelope:
      // an envelope would replay the original requester's id (and, worse,
      // a transient upstream error) to every later caller within the TTL.
      const cachedResult = cache.get<unknown>(cacheKey);
      if (cachedResult !== undefined) {
        return { jsonrpc: '2.0', id, result: cachedResult };
      }
    }

    // Order endpoints by health; if monitor has no entries (e.g. startup before
    // first poll, or test setup), fall through to the static config list.
    let attemptOrder = healthMonitor.orderEndpointsForAttempt(network);
    if (attemptOrder.length === 0) {
      attemptOrder = [...CONFIG.RPC_ENDPOINTS[network]];
    }
    if (attemptOrder.length === 0) {
      throw new Error('Invalid network');
    }

    // Pin primary-only methods to attemptOrder[0]; failing over `txpool_*` to a
    // node that doesn't expose it surfaces a confusing "method not found"
    // instead of a clean transport error.
    const order = isPrimaryOnlyMethod(method) ? attemptOrder.slice(0, 1) : attemptOrder.slice(0, 2);

    let lastError: Error | undefined;
    let result: unknown;
    let chosenUrl: string | undefined;
    for (const url of order) {
      try {
        result = await this.makeRPCCall(url, method, params, id);
        chosenUrl = url;
        healthMonitor.recordRequestResult(network, url, true);
        break;
      } catch (err) {
        healthMonitor.recordRequestResult(network, url, false, err);
        lastError = toError(err);
      }
    }

    if (chosenUrl === undefined) {
      // Defensive: in current code paths `order` is always non-empty (we
      // throw earlier if `attemptOrder` is empty), so the loop runs at least
      // once and either sets `chosenUrl` or `lastError`. The fallback Error
      // is belt-and-braces for future refactors that might widen this path;
      // never throw undefined.
      throw lastError ?? new Error('No endpoints attempted');
    }

    if (isCacheable && isRecord(result) && result.error === undefined && 'result' in result) {
      cache.set(cacheKey, result.result);
    }
    return result;
  }
}

export const rpcService = new RPCService();
