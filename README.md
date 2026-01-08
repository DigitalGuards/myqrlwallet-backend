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
RPC_URL_TESTNET=https://your-testnet-node
RPC_URL_MAINNET=https://your-mainnet-node

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
| GET | `/api/health` | Health check |

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

## Technology Stack

| Category | Technology |
|----------|------------|
| Runtime | Node.js |
| Framework | Express.js |
| Email | Nodemailer |
| HTTP Client | Axios |
| Caching | node-cache |
| Rate Limiting | express-rate-limit |

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

## Related Projects

- [myqrlwallet-frontend](https://github.com/DigitalGuards/myqrlwallet-frontend) - React web wallet
- [myqrlwallet-app](https://github.com/DigitalGuards/myqrlwallet-app) - React Native mobile app
- [QuantaPool](https://github.com/DigitalGuards/QuantaPool) - Liquid staking protocol

## License

MIT License - see LICENSE file for details.
