# MyQRLWallet Backend

Backend API service for [MyQRLWallet](https://qrlwallet.com) - a web wallet for the QRL blockchain.

**Production**: https://qrlwallet.com/api

## Features

The backend provides two main services:

### 1. RPC Proxy (`POST /api/qrl-rpc/:network`)
- Routes JSON-RPC calls to QRL blockchain nodes
- Supports testnet, mainnet, and custom RPC endpoints
- Response caching via node-cache
- CORS handling for browser requests

### 2. Transaction History (`POST /api/tx-history`)
- Proxies transaction history requests to Explorer (zondscan.com) API
- Pagination support

## Getting Started

### Prerequisites

- Node.js 18.x or later
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

# RPC Endpoints
RPC_URL_TESTNET=https://qrlwallet.com/api/qrl-rpc/testnet
RPC_URL_MAINNET=https://qrlwallet.com/api/qrl-rpc/mainnet

# CORS Origins
CORS_ORIGINS=http://localhost:5173,https://qrlwallet.com
```

### Development

```bash
npm run dev     # Start with nodemon (auto-reload)
npm start       # Start production server
npm test        # Run tests
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/qrl-rpc/:network` | Proxy RPC calls (network: testnet, mainnet, custom) |
| POST | `/api/tx-history` | Get transaction history for address |
| GET | `/health` | Health check |

### RPC Proxy Example

```bash
curl -X POST https://qrlwallet.com/api/qrl-rpc/testnet \
  -H "Content-Type: application/json" \
  -d '{"method": "qrl_blockNumber", "params": []}'
```

### Transaction History Example

```bash
curl -X POST https://qrlwallet.com/api/tx-history \
  -H "Content-Type: application/json" \
  -d '{"address": "Q1234...", "page": 1, "limit": 10}'
```

## Docker Deployment

### Build Image

```bash
docker build -t myqrlwallet-backend:latest .
```

### Run Container

```bash
docker run -d -p 3000:3000 myqrlwallet-backend:latest
```

The container:
- Uses Node.js 20 Alpine with non-root user (UID 1000)
- Serves on port 3000
- Includes health check at `/health`
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
| Runtime | Node.js 20 |
| Framework | Express.js |
| HTTP Client | Axios |
| Caching | node-cache |
| Rate Limiting | express-rate-limit |
| Container | Node.js Alpine |

## Project Structure

```
src/
├── app.js              # Express app setup
├── config/             # Configuration
├── middleware/
│   ├── cors.js         # CORS configuration
│   └── error-handler.js
├── routes/
│   ├── index.js        # Route aggregator
│   ├── app.routes.js   # tx-history route
│   ├── rpc.routes.js   # RPC proxy routes
│   └── health.routes.js
├── services/
│   └── rpc.service.js  # RPC proxy with caching
└── utils/
    └── cache.js        # Cache configuration
```

## Merchant Payment API

A standalone Go microservice for accepting QRL payments. See [docs/merchant-api.md](docs/merchant-api.md) for full documentation.

## Related Projects

- [myqrlwallet-frontend](https://github.com/DigitalGuards/myqrlwallet-frontend) - React web wallet
- [myqrlwallet-app](https://github.com/DigitalGuards/myqrlwallet-app) - React Native mobile app
- [QuantaPool](https://github.com/DigitalGuards/QuantaPool) - Liquid staking protocol

## License

MIT License - see LICENSE file for details.
