# CLAUDE.md

Operational rules for coding agents working in `myqrlwallet-backend`.

This is the backend service for `qrlwallet.com` — a Node.js (Express + Socket.IO) process that does three things:

1. **JSON-RPC proxy** at `/api/qrl-rpc/<network>` — forwards wallet read/write calls to the QRL Zond execution layer with caching, security hardening, and multi-endpoint health-aware failover.
2. **dApp Connect relay** at `/relay` (Socket.IO) — the broker that lets a browser-extension dApp pair with a wallet over an end-to-end-encrypted channel.
3. **Misc app endpoints** at `/api/...` (`src/routes/app.routes.js`) — currently a transaction-history proxy that calls `zondscan.com/api/...`.

It is **not** a custodial wallet, an indexer, or a node.

## Priority Order

1. Follow explicit user instructions.
2. Preserve correctness and production safety — this service sits in the request path of every wallet RPC call and every dApp pairing handshake. Regressions here break wallets in the wild.
3. Maintain momentum: implement, validate, and finish end-to-end.

If rules conflict, follow the highest item.

## High-signal map

The backend is hardened TypeScript (strict tsconfig + typescript-eslint strict-type-checked; type assertions are banned, wire input enters through runtime guards in `src/utils/guards.ts`). Source lives in `src/**/*.ts`, compiled by `npm run build` to `dist/`; the root `server.js` is a two-line shim importing `dist/server.js` so pm2/Docker/deploy paths stay stable. Tests remain plain-JS mocha, executed against the TS sources via the `tsx` loader.

| Path | Role |
|---|---|
| `server.js` | Entry shim only: imports `dist/server.js` (build output). Real entry is `src/server.ts`. |
| `src/server.ts` | Process entry: HTTP server + Socket.IO relay + healthMonitor lifecycle + Prometheus `/metrics` endpoint (token-protected). |
| `src/app.ts` | Express app wiring (CORS, JSON, routes, error handler). Imported by `server.ts` and tests. |
| `src/config/index.ts` | dotenv-loaded config singleton. **Endpoint resolution** (`RPC_ENDPOINTS_<NETWORK>` comma-list, back-compat to `RPC_ENDPOINT_<NETWORK>`) lives here. Add tunables to `RPC_HEALTH.*`. All numeric env vars are NaN-guarded (`parsePositiveInt`). |
| `src/crypto/primitives.ts` | The crypto boundary: the only file allowed to import `node:crypto` (ESLint-fenced). Currently just the timing-safe token compare; the relay itself does no crypto (routes E2E ciphertext). |
| `src/utils/guards.ts` | Runtime type guards (`isRecord`, `isArray`, `toError`, `HttpError`). All untrusted input is narrowed here, never type-asserted. |
| `src/services/rpc.service.ts` | RPC proxy: cache for invariant methods (result value only, per-request envelope rebuild), client JSON-RPC id passthrough, primary-only routing for `txpool_*` / `debug_*` / `admin_*`, `AbortController`-bounded native fetch. |
| `src/services/rpc/healthMonitor.ts` | Per-endpoint state machine (`up` / `down` / `stalled` / `unknown`). Background poller (default 10 s) issues `qrl_blockNumber` against each endpoint. Passive signals come from real request results. |
| `src/services/notifier.ts` | Single integration seam for ops alerting. Currently emits structured logs only; add Discord/Telegram/Sentry here, not at call sites. |
| `src/middleware/rpc-security.ts` | Method whitelist, batch reject, request-size limit, two-tier rate limit (read vs write). Source of truth for what's exposed via the proxy. |
| `src/relay/relayServer.ts` | Socket.IO relay for the dApp Connect protocol. PQ-encrypted (ML-KEM + AES-GCM) handshake; backend never sees plaintext payloads. Returns `{ io, channelManager, destroy }`. Ack callbacks from the wire are narrowed via `toAck()`; never call them blindly. |
| `src/relay/channelManager.ts` | Per-channel state: participant slots, message buffer, PK binding, capacity caps. |
| `src/relay/metrics.ts` | `prom-client` registry. Surfaces relay metrics; `/metrics` endpoint is token-gated by `RELAY_STATS_TOKEN`. Point-in-time gauges are refreshed at scrape time in `server.ts`. |
| `src/routes/health.routes.ts` | `/health` (per-endpoint snapshot from `healthMonitor`, URLs redacted). 200 if any endpoint is non-`down`; 503 only when every endpoint is `down`. |
| `src/routes/rpc.routes.ts` | `/api/qrl-rpc/<network>`: applies the security middleware chain, then delegates to `rpcService.executeRPC`. |
| `src/routes/app.routes.ts` | Misc endpoints (currently the tx-history proxy → `zondscan.com`). |
| `src/utils/cache.ts` | `node-cache` instance used only for invariant RPC results (`qrl_chainId`, `net_version`). State-dependent methods MUST NOT be cached. |
| `test/**/*.test.js` | Mocha + chai + sinon (plain JS, runs TS sources through `tsx`). Run via `npm test` (glob is quoted in `package.json`). |

## Execution Contract

### Default behaviour
- Do the work end-to-end (implement + validate + git) in one pass when feasible. Don't stop at advice unless explicitly asked.
- Don't leave TODOs for steps you can execute now.

### Validation gate (mandatory before merge / push / deploy)
```bash
npm run format:check    # CI fails on formatting drift
npm run lint
npm run typecheck
npm test
npm run build           # tsc -> dist/; the deploy scripts and Docker run this
```
State exactly what you ran and what failed if anything did not run.

### Hardening rules (mandate, mirrors myqrlwallet-connect PR #15)
- No type laundering: `consistent-type-assertions: never`, `no-explicit-any`, `no-non-null-assertion`, `ban-ts-comment`. Untrusted input (HTTP bodies, Socket.IO payloads, upstream RPC JSON, env vars) enters the typed world only through runtime guards.
- Crypto fence: only `src/crypto/` may import `node:crypto` (or any crypto lib). The relay must never grow inline crypto; it routes E2E ciphertext only.

### Review requests
When asked for a "review", output findings first, ordered by severity, each with `path:line` references. Bugs/regressions/risks before summaries. If no findings, say so explicitly and list residual risks/testing gaps.

## Deployment

Auto-deploy via the workspace `myqrlwallet-cicd` GitHub-webhook listener on `ops@49.13.162.117`:

| Branch push | Deploys to | Script | PM2 process | Port |
|---|---|---|---|---|
| `main` | prod (`qrlwallet.com`) | `deploy-backend-prod.sh` | `myqrlwallet-backend` | `3000` |
| `dev`  | dev (`dev.qrlwallet.com`) | `deploy-backend-dev.sh` | `myqrlwallet-backend-dev` | `3002` |

Both run `git pull && npm install && npm run build && pm2 restart` (no `--update-env`). The build step is required: pm2 boots the `server.js` shim, which imports `dist/server.js`. After **env-var** changes you must restart manually:

```bash
ssh ops@49.13.162.117 \
  "export PATH=\$HOME/.nvm/versions/node/v22.18.0/bin:\$PATH; \
   pm2 restart myqrlwallet-backend{,-dev} --update-env"
```

`/health` is **not** exposed through the public domain — nginx routes `/health` to the static frontend. To probe the live backend, hit `127.0.0.1:3000` via SSH:

```bash
ssh ops@49.13.162.117 'curl -s http://127.0.0.1:3000/health' | jq .
```

## Branching

- Default integration branch is `dev`. Prod tracks `main`.
- For features/fixes: feature branch → PR to `dev` → review → merge.
- For dev → main releases: PR or fast-forward push (`git push origin dev:main`) when the diff is reviewed and you want both auto-deploys to fire.
- For ops-style env-only rollouts (no code change): do not push noise commits — edit `.env` on the host and `pm2 restart … --update-env`.
- Don't force-push `main` (auto-deploys prod). Don't `--no-verify` unless explicitly asked.

## Critical invariants

### RPC caching
`src/services/rpc.service.js` only caches **invariant** RPC methods (`qrl_chainId`, `net_version`). Every state-dependent method (balances, nonces, block numbers, contract state, gas estimates, receipts, logs, writes) MUST go uncached, otherwise wallets serve stale reads after a tx confirms. Adding to `CACHEABLE_METHODS` requires a write-through invalidation strategy.

### Primary-only methods
`txpool_*`, `debug_*`, `admin_*` are pinned to the **first** endpoint in `RPC_ENDPOINTS_<NETWORK>`. The QRL Foundation public RPC (currently `209.250.255.226:8545`, used as the testnet failover) does **not** expose those namespaces — failing over would surface a misleading "method not found". Don't remove the primary-only list unless you're certain every configured endpoint exposes the method.

### Endpoint env precedence
- `RPC_ENDPOINTS_<NETWORK>` (comma-separated) is preferred.
- `RPC_ENDPOINT_<NETWORK>` (single URL) is the legacy fallback.
- Both unset → defaults to `['http://localhost:8545']` (only meaningful for local dev).

When ops adds a new failover entry, it's an env edit + pm2 restart, not a code change.

### Health-state semantics
`healthMonitor` distinguishes `up` / `down` / `stalled` / `unknown`. Stall is detected by the **background poller** (block height unchanged for `RPC_STALL_AFTER_MS`, default 5 min). Strictly-increasing block height is required to count as forward progress; reorgs/regressions do not reset the stall timer and emit a `height-regression` notifier event. Real wallet requests update health state passively via `recordRequestResult` and can flip `unknown → up` immediately on success.

### dApp Connect canonical behaviour
The relay protocol contract — handshake idempotency, channel rotation, participant types, stale-session cleanup — lives in the workspace-root CLAUDE.md §4. Read that section before touching `src/relay/`. A regression in the dApp Connect surface is high-priority because it ships in mobile + web wallets that may be many days out of date.

## Useful commands

```bash
# Quick dev loop
npm run dev                    # tsx watch src/server.ts
npm test
npm run lint:fix && npm run format
npm run typecheck

# Tail prod logs (cicd + backend)
ssh ops@49.13.162.117 'tail -f ~/.pm2/logs/myqrlwallet-backend-out.log'
ssh ops@49.13.162.117 'tail -f ~/.pm2/logs/myqrlwallet-cicd-out.log'

# Inspect live health (per-endpoint state)
ssh ops@49.13.162.117 'curl -s http://127.0.0.1:3000/health' | jq .
ssh ops@49.13.162.117 'curl -s http://127.0.0.1:3002/health' | jq .   # dev

# Smoke a public RPC call against the proxy
curl -s -X POST https://qrlwallet.com/api/qrl-rpc/testnet \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"qrl_blockNumber","params":[],"id":1}'
```

## See also

- Workspace root `CLAUDE.md` — cross-repo workspace map, dApp Connect protocol contract (§4), and the canonical RPC failover runbook (§5.4).
- `SECURITY.md` — vulnerability disclosure.
