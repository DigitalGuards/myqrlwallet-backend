# MyQRLWallet Backend

Backend API service for [MyQRLWallet](https://qrlwallet.com) - a web wallet for the QRL blockchain.

**Production**: https://qrlwallet.com/api

## Features

The backend provides two main services:

### 1. RPC Proxy (`POST /api/qrl-rpc/:network`)
- Routes JSON-RPC calls to QRL blockchain nodes
- Supports testnet and mainnet RPC endpoints
- Response caching via node-cache
- CORS handling for browser requests

### 2. Transaction History (`POST /api/tx-history`)
- Proxies transaction history requests to the configured explorer for the selected network
- Pagination support

## Getting Started

### Prerequisites

- Node.js 22.x
- npm 9.x or later

### Installation

```bash
git clone https://github.com/DigitalGuards/myqrlwallet-backend.git
cd myqrlwallet-backend
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` with your settings:
```env
PORT=3000
LISTEN_HOST=127.0.0.1

# RPC Endpoints
RPC_ENDPOINT_TESTNET=http://localhost:8545
RPC_ENDPOINT_MAINNET=http://localhost:8545

# CORS Origins
ALLOWED_ORIGINS=http://localhost:5173,https://qrlwallet.com
```

### Development

```bash
npm run dev        # Start with tsx watch (auto-reload, runs TS directly)
npm run build      # Compile src/ (TypeScript) to dist/
npm start          # Start production server (requires a prior build)
npm test           # Run tests
npm run typecheck  # tsc --noEmit
npm run lint       # eslint (strict-type-checked)
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/qrl-rpc/:network` | Proxy RPC calls (network: testnet, mainnet) |
| POST | `/api/tx-history` | Get transaction history for address |
| GET | `/health` | RPC readiness check |
| GET | `/health/live` | Process liveness check |

### RPC Proxy Example

```bash
curl -X POST https://qrlwallet.com/api/qrl-rpc/testnet \
  -H "Content-Type: application/json" \
  -d '{"method": "qrl_blockNumber", "params": []}'
```

Every RPC POST, including malformed JSON, rejected methods, and batches, consumes
the general per-IP admission quota. Signed transaction submissions also use a
stricter write quota. Upstream responses are streamed into a bounded parser:
`RPC_MAX_RESPONSE_BYTES` caps one response, while `RPC_MAX_CONCURRENT` and
`RPC_MAX_INFLIGHT_BYTES` cap process-wide admission. Saturation returns 503;
oversized, invalid, or failed upstream responses return 502.

RPC routing returns 503 until an endpoint has a verified readiness sample. Each
poll checks the block height, `qrl_syncing`, and the sampled block's timestamp.
An endpoint must report `qrl_syncing: false`, have a head no older than
`RPC_MAX_HEAD_AGE_MS` (default 300000 ms), and stay within
`RPC_MAX_HEAD_FUTURE_MS` (default 60000 ms) of the server clock. Ready endpoints
must also be within `RPC_MAX_LAG_BLOCKS` (default 8) of the highest fresh head.
A sample expires after the greater of three poll intervals or two poll timeouts.
`/health` reports readiness separately from the endpoint's progress state.
Cached chain identity responses also require a currently ready endpoint.

Each network can additionally pin both `RPC_EXPECTED_CHAIN_ID_<NETWORK>` (a
positive decimal integer, at most 256 bits) and
`RPC_EXPECTED_GENESIS_HASH_<NETWORK>` (`0x` followed by exactly 64 hex characters).
Use the `DEV`, `TESTNET`, or `MAINNET` suffix. Both variables must be absent to
disable identity binding; partial, blank, or malformed pins stop startup.
Configured polls verify `qrl_chainId` and block zero's hash within the existing
poll timeout and response limits. A failed poll immediately revokes that
endpoint's identity readiness, including cached responses, independently of the
progress-state failure threshold. A new complete matching poll is required to
restore readiness. Keep deployment-specific pins and upstream URLs server-side.

Relay payloads use the same byte budgets for offline buffering and live
transport delivery. A slow counterparty cannot grow Socket.IO's internal
egress queue without bound; accepted buffered payloads are delivered on its
next reconnect. Custom relay control events also share a per-IP rate limit.

### Transaction History Example

```bash
curl -X POST https://qrlwallet.com/api/tx-history \
  -H "Content-Type: application/json" \
  -d '{"network": "testnet", "address": "Q1234...", "page": 1, "limit": 10}'
```

The required `network` field accepts `dev`, `testnet`, or `mainnet`. A missing or
invalid network returns 400. Configure fixed explorer origins using
`TX_HISTORY_ORIGIN_DEV`, `TX_HISTORY_ORIGIN_TESTNET`, and
`TX_HISTORY_ORIGIN_MAINNET`; requests cannot select a destination URL. Testnet
defaults to `https://zondscan.com`. Dev and mainnet are unconfigured by default,
and any unconfigured network returns 501 with `HISTORY_UNAVAILABLE`. A blank
origin disables history for that network. Origins must be credential-free HTTPS
origins, with HTTP allowed only for explicit loopback origins. History requests
retain an 8-second timeout, a 2 MiB response limit, and disabled redirects.

## Docker Deployment

### Build Image

```bash
docker build -t myqrlwallet-backend:latest .
```

### Run Container

```bash
docker run -d \
  -e LISTEN_HOST=0.0.0.0 \
  -p 127.0.0.1:3000:3000 \
  myqrlwallet-backend:latest
```

The application binds to `127.0.0.1` by default. Containers must explicitly
set `LISTEN_HOST=0.0.0.0`; publish the port only on host loopback or place it
behind an isolated reverse proxy/ClusterIP. Configure `TRUSTED_PROXY_CIDRS`
with the proxy peer CIDRs before accepting `X-Forwarded-For`.

The container:
- Uses Node.js 22 Alpine with non-root user (UID 1000)
- Serves on port 3000
- Includes process health check at `/health/live`
- Has read-only root filesystem (security hardened)

## Kubernetes Deployment

Kubernetes manifests are provided in the `k8s/` directory.

### Prerequisites

- Kubernetes cluster
- Frontend deployed first (creates namespace and ingress)

### Deploy

```bash
# Apply all manifests
kubectl apply -k k8s/

# Or apply individually
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/hpa.yaml
```

### Manifests

| File | Description |
|------|-------------|
| `deployment.yaml` | 2 replicas with health checks, security context |
| `service.yaml` | ClusterIP service on port 3000 |
| `configmap.yaml` | Non-sensitive config (RPC URLs, CORS) |
| `hpa.yaml` | Horizontal Pod Autoscaler (2-10 replicas) |

### Security Features

- Runs as non-root user (UID 1000)
- Read-only root filesystem
- `/tmp` mounted as emptyDir for temp files
- No privilege escalation allowed

The example ConfigMap deliberately targets an in-cluster `qrl-node` Service
and disables mainnet. Replace that Service name with the actual trusted node
topology before rollout. An RPC endpoint must never point back to the public
wallet proxy because that creates a recursive request loop.

## CI/CD

The GitHub Actions workflow (`.github/workflows/ci.yml`) automatically:

1. **On PR/Push**: Runs tests
2. **On Push to main/dev**: Builds and pushes Docker image to GitHub Container Registry
3. **On Push to main**: Deploys to Kubernetes cluster

### Image Tags

- `ghcr.io/<owner>/myqrlwallet-backend:latest` - Latest main branch
- `ghcr.io/<owner>/myqrlwallet-backend:main-<sha>` - Specific commit
- `ghcr.io/<owner>/myqrlwallet-backend:dev` - Dev branch

### Required GitHub Configuration

**Secrets** (Settings → Secrets and variables → Actions → Secrets):
- `KUBECONFIG` - Base64-encoded kubeconfig for deployment

## Technology Stack

| Category | Technology |
|----------|------------|
| Runtime | Node.js 22 |
| Language | TypeScript (strict, compiled to `dist/`) |
| Framework | Express.js |
| HTTP Client | Native fetch / Axios |
| Caching | node-cache |
| Rate Limiting | express-rate-limit |
| Container | Node.js Alpine |

## Project Structure

```
server.js               # Entry shim -> dist/server.js (build output)
src/
├── server.ts           # Process entry (HTTP + relay + metrics)
├── app.ts              # Express app setup
├── config/             # Configuration (env parsing, NaN-guarded)
├── crypto/
│   └── primitives.ts   # Crypto boundary (only file importing node:crypto)
├── middleware/
│   ├── cors.ts         # CORS configuration
│   ├── error-handler.ts
│   └── rpc-security.ts # Whitelist, validation, rate limits
├── relay/              # Socket.IO dApp Connect relay
├── routes/
│   ├── index.ts        # Route aggregator
│   ├── app.routes.ts   # tx-history route
│   ├── rpc.routes.ts   # RPC proxy routes
│   ├── ipfs.routes.ts  # IPFS gateway shim
│   └── health.routes.ts
├── services/
│   └── rpc.service.ts  # RPC proxy with caching + failover
└── utils/              # cache, logger, guards, asyncHandler
```

## Related Projects

- [myqrlwallet-frontend](https://github.com/DigitalGuards/myqrlwallet-frontend) - React web wallet
- [myqrlwallet-app](https://github.com/DigitalGuards/myqrlwallet-app) - React Native mobile app
- [QuantaPool](https://github.com/DigitalGuards/QuantaPool) - Liquid staking protocol

## License

MIT License - see LICENSE file for details.
