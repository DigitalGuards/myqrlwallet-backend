# MyQRLWallet Backend

Backend API service for [MyQRLWallet](https://qrlwallet.com) - a web wallet for the QRL Zond blockchain.

**Production**: https://qrlwallet.com/api

## Features

The backend provides three main services:

### 1. RPC Proxy (`POST /api/zond-rpc/:network`)
- Routes JSON-RPC calls to Zond blockchain nodes
- Supports testnet, mainnet, and custom RPC endpoints
- Response caching via node-cache
- CORS handling for browser requests

### 2. Support Email (`POST /api/support`)
- Sends support request emails via SMTP
- Sends confirmation email to user
- Rate limited: 10 requests per 15 minutes per IP

### 3. Transaction History (`POST /api/tx-history`)
- Proxies transaction history requests to ZondScan API
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
RPC_URL_TESTNET=https://qrlwallet.com/api/zond-rpc/testnet
RPC_URL_MAINNET=https://qrlwallet.com/api/zond-rpc/mainnet

# SMTP Configuration (for support emails)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-user
SMTP_TOKEN=your-password
SMTP_FROM=noreply@example.com
SMTP_TO=support@example.com

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
| POST | `/api/zond-rpc/:network` | Proxy RPC calls (network: testnet, mainnet, custom) |
| POST | `/api/support` | Send support email |
| POST | `/api/tx-history` | Get transaction history for address |
| GET | `/health` | Health check |

### RPC Proxy Example

```bash
curl -X POST https://qrlwallet.com/api/zond-rpc/testnet \
  -H "Content-Type: application/json" \
  -d '{"method": "eth_blockNumber", "params": []}'
```

### Transaction History Example

```bash
curl -X POST https://qrlwallet.com/api/tx-history \
  -H "Content-Type: application/json" \
  -d '{"address": "Z1234...", "page": 1, "limit": 10}'
```

## Docker Deployment

### Build Image

```bash
docker build -t myqrlwallet-backend:latest .
```

### Run Container

```bash
docker run -d -p 3000:3000 \
  -e SMTP_HOST=smtp.example.com \
  -e SMTP_PORT=587 \
  -e SMTP_USER=your-user \
  -e SMTP_TOKEN=your-password \
  -e SMTP_FROM=noreply@example.com \
  -e SMTP_TO=support@example.com \
  myqrlwallet-backend:latest
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
# Update secrets first!
# Edit k8s/secret.yaml or create via kubectl:
kubectl create secret generic myqrlwallet-backend-secrets \
  --namespace=myqrlwallet \
  --from-literal=SMTP_HOST=smtp.example.com \
  --from-literal=SMTP_PORT=587 \
  --from-literal=SMTP_USER=your-user \
  --from-literal=SMTP_PASS=your-password \
  --from-literal=SMTP_FROM=noreply@example.com \
  --from-literal=SUPPORT_EMAIL=support@example.com

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
| `secret.yaml` | Template for SMTP credentials |
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
| Email | Nodemailer |
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
│   ├── app.routes.js   # Support & tx-history routes
│   ├── rpc.routes.js   # RPC proxy routes
│   └── health.routes.js
├── services/
│   └── rpc.service.js  # RPC proxy with caching
└── utils/
    └── cache.js        # Cache configuration
```

## Merchant Payment API

A standalone Go microservice for accepting QRL payments. Located in the `merchant-api/` directory.

### Features

- **Non-custodial**: Merchants upload their own QRL addresses — the service never holds private keys
- **Automatic deposit detection**: Scans new blocks via zondscan.com to discover transactions without merchant intervention
- **Confirmation tracking**: Monitors tx confirmations and promotes payments through `pending → detected → confirmed`
- **Webhook notifications**: Delivers HMAC-signed webhook callbacks when payments are confirmed
- **Rate limiting**: Configurable token bucket rate limiter per API key
- **Encryption at rest**: Webhook secrets encrypted with AES-256-GCM using a master key

### Prerequisites

- Go 1.24+
- PostgreSQL 16+

### Quick Start

```bash
cd merchant-api

# Set required environment variables
export DATABASE_URL="postgres://user:pass@localhost:5432/merchant_api?sslmode=disable"
export ADMIN_API_KEY="your-admin-key"
export MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)

# Build and run
go build -o merchant-api ./cmd/merchant-api
./merchant-api
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `ADMIN_API_KEY` | Yes | - | Admin API key for merchant management |
| `MASTER_ENCRYPTION_KEY` | Yes | - | 64 hex chars (32 bytes) for AES-256-GCM |
| `PORT` | No | 8080 | HTTP server port |
| `ZOND_RPC_ENDPOINT` | No | http://localhost:8545 | Zond node JSON-RPC URL |
| `ZONDSCAN_URL` | No | https://zondscan.com/api | Zondscan REST API URL |
| `ZONDSCAN_TIMEOUT_SECONDS` | No | 10 | Zondscan HTTP client timeout |
| `MONITOR_INTERVAL_SECONDS` | No | 15 | Block monitor polling interval |
| `DEFAULT_REQUIRED_CONFIRMATIONS` | No | 1 | Confirmations before payment is confirmed |
| `DEFAULT_PAYMENT_TTL_MINUTES` | No | 60 | Payment expiration time |
| `WEBHOOK_INTERVAL_SECONDS` | No | 15 | Webhook delivery polling interval |
| `WEBHOOK_MAX_RETRIES` | No | 5 | Max webhook delivery attempts |
| `WEBHOOK_TIMEOUT_SECONDS` | No | 10 | Webhook HTTP request timeout |
| `RATE_LIMIT_RPS` | No | 10 | Rate limit: requests per second |
| `RATE_LIMIT_BURST` | No | 30 | Rate limit: max burst size |

### API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | None | Health check |
| POST | `/v1/merchants` | Admin | Create a new merchant |
| POST | `/v1/wallets` | Merchant | Generate a QRL address (utility) |
| POST | `/v1/addresses` | Merchant | Upload deposit addresses to pool |
| GET | `/v1/addresses` | Merchant | Get address pool status |
| POST | `/v1/payments` | Merchant | Create a payment intent |
| GET | `/v1/payments/{id}` | Merchant | Get payment status |
| GET | `/v1/payments?external_id=X` | Merchant | Look up payment by external ID |
| PATCH | `/v1/payments/{id}/tx` | Merchant | Submit tx hash (optional fast-path) |

### Payment Flow

```
1. Merchant uploads QRL addresses     POST /v1/addresses
2. Customer checks out                POST /v1/payments (assigns address from pool)
3. Customer sends QRL to address      (on-chain transaction)
4. Block scanner detects deposit      (automatic — scans zondscan every ~15s)
5. Monitor tracks confirmations       (automatic — checks tx receipt)
6. Payment confirmed                  (webhook fires to merchant URL)
```

### Project Structure

```
merchant-api/
├── cmd/merchant-api/       # Entry point
├── internal/
│   ├── address/            # Address normalization (Z→Q prefix)
│   ├── config/             # Environment configuration
│   ├── crypto/             # AES-256-GCM encryption
│   ├── handler/            # HTTP handlers + middleware
│   ├── model/              # Domain types
│   ├── rpc/                # Zond JSON-RPC client
│   ├── store/              # PostgreSQL store + migrations
│   ├── worker/             # Monitor + webhook workers
│   └── zondscan/           # Zondscan REST API client
└── go.mod
```

## Related Projects

- [myqrlwallet-frontend](https://github.com/DigitalGuards/myqrlwallet-frontend) - React web wallet
- [myqrlwallet-app](https://github.com/DigitalGuards/myqrlwallet-app) - React Native mobile app
- [QuantaPool](https://github.com/DigitalGuards/QuantaPool) - Liquid staking protocol

## License

MIT License - see LICENSE file for details.
