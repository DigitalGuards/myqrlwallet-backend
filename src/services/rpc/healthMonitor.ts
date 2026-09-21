import { CONFIG, isNetworkName, type RpcIdentity } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { isRecord, toError } from '../../utils/guards.js';
import { BoundedJsonError, readBoundedJsonResponse } from '../../utils/bounded-json.js';
import { notify } from '../notifier.js';

export type EndpointState = 'up' | 'down' | 'stalled' | 'unknown';

const STATE_UP: EndpointState = 'up';
const STATE_DOWN: EndpointState = 'down';
const STATE_STALLED: EndpointState = 'stalled';
const STATE_UNKNOWN: EndpointState = 'unknown';
const HEALTH_RESPONSE_MAX_BYTES = 16 * 1024;
const HEALTH_BLOCK_MAX_BYTES = 1024 * 1024;

const STATE_ORDER: Record<EndpointState, number> = {
  [STATE_UP]: 0,
  [STATE_UNKNOWN]: 1,
  [STATE_STALLED]: 2,
  [STATE_DOWN]: 3,
};

export interface EndpointRecord {
  url: string;
  state: EndpointState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastHeight: number | null;
  lastHeightChangeAt: number;
  lastLatencyMs: number | null;
  lastError: Error | null;
  lastPollAt: number | null;
  lastVerifiedPollAt: number | null;
  headTimestamp: number | null;
  syncing: boolean | null;
  verifiedIdentity: RpcIdentity | null;
}

export interface EndpointSnapshot {
  url: string;
  state: EndpointState;
  lastHeight: number | null;
  lastHeightChangeAt: number;
  lastLatencyMs: number | null;
  lastError: string | null;
  lastPollAt: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastVerifiedPollAt: number | null;
  headTimestamp: number | null;
  syncing: boolean | null;
  ready: boolean;
}

export type HealthSnapshot = Record<string, EndpointSnapshot[]>;

function makeEndpointRecord(url: string): EndpointRecord {
  return {
    url,
    state: STATE_UNKNOWN,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastHeight: null,
    lastHeightChangeAt: Date.now(),
    lastLatencyMs: null,
    lastError: null,
    lastPollAt: null,
    lastVerifiedPollAt: null,
    headTimestamp: null,
    syncing: null,
    verifiedIdentity: null,
  };
}

function parseHexHeight(hex: unknown): number | null {
  if (typeof hex !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(hex)) return null;
  const n = Number.parseInt(hex.slice(2), 16);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Convert untrusted fetch failures into stable, credential-free categories. */
function sanitizeHealthError(error: unknown): Error {
  const err = toError(error);
  if (err instanceof BoundedJsonError) return new Error(err.message);
  if (err.name === 'AbortError') return new Error('upstream request timed out');
  if (/^HTTP \d{3}$/.test(err.message)) return new Error(err.message);
  if (err.message === 'Unparseable qrl_blockNumber result') return new Error(err.message);
  if (err.message === 'RPC chain identity mismatch') return new Error(err.message);
  return new Error('upstream health check failed');
}

class HealthMonitor {
  networks = new Map<string, EndpointRecord[]>();
  private pollerTimer: NodeJS.Timeout | null = null;
  private initialised = false;
  private polling = false;

  init(): void {
    if (this.initialised) return;
    for (const [network, endpoints] of Object.entries(CONFIG.RPC_ENDPOINTS)) {
      if (!Array.isArray(endpoints) || endpoints.length === 0) continue;
      this.networks.set(network, endpoints.map(makeEndpointRecord));
    }
    this.initialised = true;
  }

  start(): void {
    this.init();
    if (this.pollerTimer) return;
    if (this.networks.size === 0) {
      logger.warn('[healthMonitor] no networks configured; poller not started');
      return;
    }
    // Re-entrancy guard: setInterval doesn't await its callback, so if a poll
    // ever runs longer than POLL_INTERVAL_MS the next tick would overlap. With
    // current settings (10s interval, 5s timeout, parallel polls) overlap is
    // unreachable, but the guard makes that property explicit and survives
    // future endpoint-list growth.
    this.pollerTimer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      this.pollAll()
        .catch((err: unknown) => {
          logger.error({ err }, '[healthMonitor] poll loop error');
        })
        .finally(() => {
          this.polling = false;
        });
    }, CONFIG.RPC_HEALTH.POLL_INTERVAL_MS);
    this.pollerTimer.unref();
    // Kick off an immediate poll so /health is meaningful before the first interval.
    this.polling = true;
    this.pollAll()
      .catch((err: unknown) => {
        logger.error({ err }, '[healthMonitor] initial poll error');
      })
      .finally(() => {
        this.polling = false;
      });
  }

  stop(): void {
    if (this.pollerTimer) {
      clearInterval(this.pollerTimer);
      this.pollerTimer = null;
    }
  }

  /**
   * Return the configured endpoint URLs for `network` ordered by preference:
   * up → unknown → stalled → down. Within a state group, lower latency first.
   * Callers iterate this list and stop on first success.
   */
  orderEndpointsForAttempt(network: string): string[] {
    this.init();
    const endpoints = this.networks.get(network);
    if (!endpoints || endpoints.length === 0) return [];
    const ranked = [...endpoints].sort((a, b) => {
      const sa = STATE_ORDER[a.state];
      const sb = STATE_ORDER[b.state];
      if (sa !== sb) return sa - sb;
      const la = a.lastLatencyMs ?? Number.POSITIVE_INFINITY;
      const lb = b.lastLatencyMs ?? Number.POSITIVE_INFINITY;
      return la - lb;
    });
    return ranked.map((e) => e.url);
  }

  pickEndpoint(network: string): string | null {
    const ordered = this.orderEndpointsForAttempt(network);
    return ordered[0] ?? null;
  }

  hasHealthyForNetwork(network: string): boolean {
    return this.readyEndpointsForAttempt(network).length > 0;
  }

  private hasFreshHead(ep: EndpointRecord, now: number): boolean {
    const maxPollAge = Math.max(
      CONFIG.RPC_HEALTH.POLL_INTERVAL_MS * 3,
      CONFIG.RPC_HEALTH.POLL_TIMEOUT_MS * 2
    );
    return (
      ep.state === STATE_UP &&
      ep.syncing === false &&
      ep.lastHeight !== null &&
      ep.headTimestamp !== null &&
      ep.lastVerifiedPollAt !== null &&
      now - ep.lastVerifiedPollAt <= maxPollAge &&
      now - ep.headTimestamp <= CONFIG.RPC_HEALTH.MAX_HEAD_AGE_MS &&
      ep.headTimestamp - now <= CONFIG.RPC_HEALTH.MAX_HEAD_FUTURE_MS
    );
  }

  /** Route only to independently verified recent heads, allowing small reorgs and polling skew. */
  readyEndpointsForAttempt(network: string): string[] {
    if (!isNetworkName(network)) return [];
    const ordered = this.orderEndpointsForAttempt(network);
    const endpoints = this.networks.get(network) ?? [];
    const now = Date.now();
    const expectedIdentity = CONFIG.RPC_EXPECTED_IDENTITIES[network];
    const fresh = endpoints.filter(
      (ep) =>
        this.hasFreshHead(ep, now) &&
        (expectedIdentity === null ||
          (ep.verifiedIdentity?.chainId === expectedIdentity.chainId &&
            ep.verifiedIdentity.genesisHash === expectedIdentity.genesisHash))
    );
    const highest = fresh.reduce((height, ep) => Math.max(height, ep.lastHeight ?? 0), 0);
    const ready = new Set(
      fresh
        .filter((ep) => highest - (ep.lastHeight ?? 0) <= CONFIG.RPC_HEALTH.MAX_LAG_BLOCKS)
        .map((ep) => ep.url)
    );
    return ordered.filter((url) => ready.has(url));
  }

  getSnapshot(): HealthSnapshot {
    this.init();
    const out: HealthSnapshot = {};
    for (const [network, endpoints] of this.networks.entries()) {
      const ready = new Set(this.readyEndpointsForAttempt(network));
      out[network] = endpoints.map((e) => ({
        url: e.url,
        state: e.state,
        lastHeight: e.lastHeight,
        lastHeightChangeAt: e.lastHeightChangeAt,
        lastLatencyMs: e.lastLatencyMs,
        lastError: e.lastError ? e.lastError.message || String(e.lastError) : null,
        lastPollAt: e.lastPollAt,
        consecutiveFailures: e.consecutiveFailures,
        consecutiveSuccesses: e.consecutiveSuccesses,
        lastVerifiedPollAt: e.lastVerifiedPollAt,
        headTimestamp: e.headTimestamp,
        syncing: e.syncing,
        ready: ready.has(e.url),
      }));
    }
    return out;
  }

  async pollAll(): Promise<void> {
    if (this.networks.size === 0) return;
    const polls: Promise<void>[] = [];
    for (const [network, endpoints] of this.networks.entries()) {
      for (const ep of endpoints) {
        polls.push(this.pollOne(network, ep));
      }
    }
    await Promise.allSettled(polls);
  }

  async pollOne(network: string, ep: EndpointRecord): Promise<void> {
    if (!isNetworkName(network)) return;
    const expectedIdentity = CONFIG.RPC_EXPECTED_IDENTITIES[network];
    const start = Date.now();
    const pollId = start;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, CONFIG.RPC_HEALTH.POLL_TIMEOUT_MS);
    try {
      const response = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: pollId,
          method: 'qrl_blockNumber',
          params: [],
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      ep.lastPollAt = Date.now();
      ep.lastLatencyMs = Date.now() - start;
      if (!response.ok) {
        controller.abort();
        this.applyFailure(network, ep, new Error(`HTTP ${response.status}`));
        return;
      }
      // qrl_blockNumber is a tiny envelope. Bound even this operator poll so
      // a compromised or misconfigured upstream cannot stream the process out
      // of memory outside the client-facing RPC admission controls.
      const json = await readBoundedJsonResponse(response, controller, HEALTH_RESPONSE_MAX_BYTES);
      const height = parseHexHeight(
        isRecord(json) && json.jsonrpc === '2.0' && json.id === pollId && !('error' in json)
          ? json.result
          : undefined
      );
      if (height === null) {
        this.applyFailure(network, ep, new Error('Unparseable qrl_blockNumber result'));
        return;
      }
      const query = async (
        method: string,
        params: unknown[],
        maxBytes: number
      ): Promise<unknown> => {
        const result = await fetch(ep.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
          signal: controller.signal,
          redirect: 'error',
        });
        if (!result.ok) {
          controller.abort();
          throw new Error(`HTTP ${result.status}`);
        }
        const body = await readBoundedJsonResponse(result, controller, maxBytes);
        if (
          !isRecord(body) ||
          body.jsonrpc !== '2.0' ||
          body.id !== method ||
          'error' in body ||
          !('result' in body)
        ) {
          throw new Error('Invalid readiness response');
        }
        return body.result;
      };
      if (expectedIdentity !== null) {
        const chainId = await query('qrl_chainId', [], HEALTH_RESPONSE_MAX_BYTES);
        if (
          typeof chainId !== 'string' ||
          !/^0x[1-9a-fA-F][0-9a-fA-F]{0,63}$/.test(chainId) ||
          chainId.toLowerCase() !== expectedIdentity.chainId
        ) {
          throw new Error('RPC chain identity mismatch');
        }
        const genesis = await query('qrl_getBlockByNumber', ['0x0', false], HEALTH_BLOCK_MAX_BYTES);
        if (
          !isRecord(genesis) ||
          genesis.number !== '0x0' ||
          typeof genesis.hash !== 'string' ||
          !/^0x[0-9a-fA-F]{64}$/.test(genesis.hash) ||
          genesis.hash.toLowerCase() !== expectedIdentity.genesisHash
        ) {
          throw new Error('RPC chain identity mismatch');
        }
      }
      const syncing = await query('qrl_syncing', [], HEALTH_RESPONSE_MAX_BYTES);
      if (
        syncing !== false &&
        (!isRecord(syncing) ||
          parseHexHeight(syncing.startingBlock) === null ||
          parseHexHeight(syncing.currentBlock) === null ||
          parseHexHeight(syncing.highestBlock) === null)
      )
        throw new Error('Invalid synchronization response');
      const block = await query(
        'qrl_getBlockByNumber',
        [`0x${height.toString(16)}`, false],
        HEALTH_BLOCK_MAX_BYTES
      );
      const timestamp = isRecord(block) ? parseHexHeight(block.timestamp) : null;
      if (
        !isRecord(block) ||
        parseHexHeight(block.number) !== height ||
        timestamp === null ||
        timestamp > Number.MAX_SAFE_INTEGER / 1000
      ) {
        throw new Error('Invalid head timestamp response');
      }
      ep.syncing = syncing !== false;
      ep.headTimestamp = timestamp * 1000;
      ep.lastVerifiedPollAt = Date.now();
      ep.verifiedIdentity = expectedIdentity === null ? null : { ...expectedIdentity };
      ep.lastLatencyMs = Date.now() - start;
      this.applyPollSuccess(network, ep, height);
    } catch (err) {
      ep.lastPollAt = Date.now();
      ep.lastLatencyMs = Date.now() - start;
      this.applyFailure(network, ep, err);
    } finally {
      clearTimeout(timer);
    }
  }

  applyPollSuccess(network: string, ep: EndpointRecord, height: number): void {
    // Only treat strictly increasing height as forward progress. A regression
    // (chain reorg, bad node serving an older head) must NOT reset the stall
    // timer; a node going backwards is sick, not "advancing".
    const advanced = ep.lastHeight === null || height > ep.lastHeight;
    if (advanced) {
      ep.lastHeight = height;
      ep.lastHeightChangeAt = Date.now();
    } else if (ep.lastHeight !== null && height < ep.lastHeight) {
      // Height regression: log via notifier so operators see it; keep
      // tracking the regressed height so a subsequent climb back up registers
      // as forward progress, but leave lastHeightChangeAt alone (we want stall
      // detection to fire if the node stays stuck on the lower head).
      notify({
        severity: 'warn',
        network,
        endpoint: ep.url,
        event: 'height-regression',
        detail: { previousHeight: ep.lastHeight, observedHeight: height },
      });
      ep.lastHeight = height;
    }
    ep.consecutiveSuccesses += 1;
    ep.consecutiveFailures = 0;
    ep.lastError = null;

    const previousState = ep.state;
    let newState = previousState;

    if (advanced) {
      if (previousState === STATE_UNKNOWN || previousState === STATE_STALLED) {
        newState = STATE_UP;
      } else if (
        previousState === STATE_DOWN &&
        ep.consecutiveSuccesses >= CONFIG.RPC_HEALTH.UP_AFTER_SUCCESSES
      ) {
        newState = STATE_UP;
      }
    } else {
      const stallMs = Date.now() - ep.lastHeightChangeAt;
      if (stallMs > CONFIG.RPC_HEALTH.STALL_AFTER_MS) {
        newState = STATE_STALLED;
      } else if (previousState === STATE_UNKNOWN) {
        // Successful poll, even without an advance, qualifies an unknown
        // endpoint as up. Stall threshold takes over from there.
        newState = STATE_UP;
      } else if (
        previousState === STATE_DOWN &&
        ep.consecutiveSuccesses >= CONFIG.RPC_HEALTH.UP_AFTER_SUCCESSES
      ) {
        newState = STATE_UP;
      }
    }

    if (newState !== previousState) {
      ep.state = newState;
      if (newState === STATE_UP) {
        notify({
          severity: 'info',
          network,
          endpoint: ep.url,
          event: 'up',
          detail: { height, previousState },
        });
      } else if (newState === STATE_STALLED) {
        notify({
          severity: 'warn',
          network,
          endpoint: ep.url,
          event: 'stalled',
          detail: { height, stallMs: Date.now() - ep.lastHeightChangeAt },
        });
      }
    }
  }

  applyFailure(network: string, ep: EndpointRecord, error: unknown): void {
    // Identity-bound networks fail closed on the first failed poll, including
    // mismatches, malformed evidence and transport failures. Progress-state
    // hysteresis remains independent from authorization to route requests.
    ep.verifiedIdentity = null;
    const previousState = ep.state;
    const err = sanitizeHealthError(error);
    ep.consecutiveFailures += 1;
    ep.consecutiveSuccesses = 0;
    ep.lastError = err;
    if (
      ep.consecutiveFailures >= CONFIG.RPC_HEALTH.DOWN_AFTER_FAILURES &&
      previousState !== STATE_DOWN
    ) {
      ep.state = STATE_DOWN;
      notify({
        severity: 'error',
        network,
        endpoint: ep.url,
        event: 'down',
        detail: { error: err.message, previousState },
      });
    }
  }

  /**
   * Test-only: replaces the in-memory endpoint table for a network.
   * Skip the env-driven init() once this is called.
   */
  __setEndpointsForTesting(network: string, urls: string[]): void {
    this.networks.set(network, urls.map(makeEndpointRecord));
    this.initialised = true;
  }

  __forceStateForTesting(network: string, url: string, state: EndpointState): void {
    const endpoints = this.networks.get(network);
    if (!endpoints) return;
    const ep = endpoints.find((e) => e.url === url);
    if (ep) ep.state = state;
  }

  __resetForTesting(): void {
    this.stop();
    this.networks = new Map();
    this.initialised = false;
  }
}

export const healthMonitor = new HealthMonitor();
export const HEALTH_STATES = { STATE_UP, STATE_DOWN, STATE_STALLED, STATE_UNKNOWN };
