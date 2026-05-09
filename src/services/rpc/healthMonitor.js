import fetch from 'node-fetch';
import { CONFIG } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { notify } from '../notifier.js';

const STATE_UP = 'up';
const STATE_DOWN = 'down';
const STATE_STALLED = 'stalled';
const STATE_UNKNOWN = 'unknown';

const STATE_ORDER = { [STATE_UP]: 0, [STATE_UNKNOWN]: 1, [STATE_STALLED]: 2, [STATE_DOWN]: 3 };

function makeEndpointRecord(url) {
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
  };
}

function parseHexHeight(hex) {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return null;
  const n = Number.parseInt(hex.slice(2), 16);
  return Number.isFinite(n) ? n : null;
}

class HealthMonitor {
  constructor() {
    this.networks = new Map();
    this.pollerTimer = null;
    this.initialised = false;
  }

  init() {
    if (this.initialised) return;
    for (const [network, endpoints] of Object.entries(CONFIG.RPC_ENDPOINTS)) {
      if (network === 'custom') continue;
      if (!Array.isArray(endpoints) || endpoints.length === 0) continue;
      this.networks.set(network, endpoints.map(makeEndpointRecord));
    }
    this.initialised = true;
  }

  start() {
    this.init();
    if (this.pollerTimer) return;
    if (this.networks.size === 0) {
      logger.warn('[healthMonitor] no networks configured; poller not started');
      return;
    }
    this.pollerTimer = setInterval(
      () => this.pollAll().catch((err) => logger.error({ err }, '[healthMonitor] poll loop error')),
      CONFIG.RPC_HEALTH.POLL_INTERVAL_MS
    );
    if (this.pollerTimer.unref) this.pollerTimer.unref();
    // Kick off an immediate poll so /health is meaningful before the first interval.
    this.pollAll().catch((err) => logger.error({ err }, '[healthMonitor] initial poll error'));
  }

  stop() {
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
  orderEndpointsForAttempt(network) {
    this.init();
    const endpoints = this.networks.get(network);
    if (!endpoints || endpoints.length === 0) return [];
    const ranked = [...endpoints].sort((a, b) => {
      const sa = STATE_ORDER[a.state] ?? 99;
      const sb = STATE_ORDER[b.state] ?? 99;
      if (sa !== sb) return sa - sb;
      const la = a.lastLatencyMs ?? Number.POSITIVE_INFINITY;
      const lb = b.lastLatencyMs ?? Number.POSITIVE_INFINITY;
      return la - lb;
    });
    return ranked.map((e) => e.url);
  }

  pickEndpoint(network) {
    const ordered = this.orderEndpointsForAttempt(network);
    return ordered[0] || null;
  }

  hasHealthyForNetwork(network) {
    this.init();
    const endpoints = this.networks.get(network);
    if (!endpoints) return false;
    return endpoints.some((e) => e.state === STATE_UP || e.state === STATE_UNKNOWN);
  }

  recordRequestResult(network, url, ok, error) {
    this.init();
    const endpoints = this.networks.get(network);
    if (!endpoints) return;
    const ep = endpoints.find((e) => e.url === url);
    if (!ep) return;
    if (ok) {
      this.applyRequestSuccess(network, ep);
    } else {
      this.applyFailure(network, ep, error);
    }
  }

  getSnapshot() {
    this.init();
    const out = {};
    for (const [network, endpoints] of this.networks.entries()) {
      out[network] = endpoints.map((e) => ({
        url: e.url,
        state: e.state,
        lastHeight: e.lastHeight,
        lastHeightChangeAt: e.lastHeightChangeAt,
        lastLatencyMs: e.lastLatencyMs,
        lastError: e.lastError ? String(e.lastError.message || e.lastError) : null,
        lastPollAt: e.lastPollAt,
        consecutiveFailures: e.consecutiveFailures,
        consecutiveSuccesses: e.consecutiveSuccesses,
      }));
    }
    return out;
  }

  async pollAll() {
    if (this.networks.size === 0) return;
    const polls = [];
    for (const [network, endpoints] of this.networks.entries()) {
      for (const ep of endpoints) {
        polls.push(this.pollOne(network, ep));
      }
    }
    await Promise.allSettled(polls);
  }

  async pollOne(network, ep) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.RPC_HEALTH.POLL_TIMEOUT_MS);
    try {
      const response = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'qrl_blockNumber',
          params: [],
        }),
        signal: controller.signal,
      });
      ep.lastPollAt = Date.now();
      ep.lastLatencyMs = Date.now() - start;
      if (!response.ok) {
        this.applyFailure(network, ep, new Error(`HTTP ${response.status}`));
        return;
      }
      const json = await response.json();
      const height = parseHexHeight(json?.result);
      if (height === null) {
        this.applyFailure(network, ep, new Error('Unparseable qrl_blockNumber result'));
        return;
      }
      this.applyPollSuccess(network, ep, height);
    } catch (err) {
      ep.lastPollAt = Date.now();
      ep.lastLatencyMs = Date.now() - start;
      this.applyFailure(network, ep, err);
    } finally {
      clearTimeout(timer);
    }
  }

  applyPollSuccess(network, ep, height) {
    const advanced = ep.lastHeight !== height;
    if (advanced) {
      ep.lastHeight = height;
      ep.lastHeightChangeAt = Date.now();
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

  applyRequestSuccess(network, ep) {
    ep.consecutiveFailures = 0;
    ep.consecutiveSuccesses += 1;
    ep.lastError = null;
    if (
      ep.state === STATE_DOWN &&
      ep.consecutiveSuccesses >= CONFIG.RPC_HEALTH.UP_AFTER_SUCCESSES
    ) {
      ep.state = STATE_UP;
      notify({
        severity: 'info',
        network,
        endpoint: ep.url,
        event: 'up',
        detail: { source: 'request' },
      });
    }
  }

  applyFailure(network, ep, error) {
    const previousState = ep.state;
    ep.consecutiveFailures += 1;
    ep.consecutiveSuccesses = 0;
    ep.lastError = error;
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
        detail: { error: error?.message || String(error), previousState },
      });
    }
  }

  /**
   * Test-only — replaces the in-memory endpoint table for a network.
   * Skip the env-driven init() once this is called.
   */
  __setEndpointsForTesting(network, urls) {
    this.networks.set(network, urls.map(makeEndpointRecord));
    this.initialised = true;
  }

  __forceStateForTesting(network, url, state) {
    const endpoints = this.networks.get(network);
    if (!endpoints) return;
    const ep = endpoints.find((e) => e.url === url);
    if (ep) ep.state = state;
  }

  __resetForTesting() {
    this.stop();
    this.networks = new Map();
    this.initialised = false;
  }
}

export const healthMonitor = new HealthMonitor();
export const HEALTH_STATES = { STATE_UP, STATE_DOWN, STATE_STALLED, STATE_UNKNOWN };
