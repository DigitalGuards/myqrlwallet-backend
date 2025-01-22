# Zond Web Wallet Backend

The backend service for the Zond Web Wallet - a modern, secure web wallet for the Quantum Resistant Ledger's Zond blockchain. This repository handles the server-side operations and API endpoints that support the main web application.

## Overview

This backend service provides the necessary API endpoints and server-side functionality to support the Zond Web Wallet frontend. It handles critical operations such as:

- Account management and validation
- Transaction processing and verification
- Network status and synchronization
- API endpoints for blockchain interaction
- Security and rate limiting

## Getting Started

### Prerequisites

- Node.js 16.x or later
- npm 7.x or later

### Local Development

1. Clone the repository:
```bash
git clone https://github.com/DigitalGuards/zondwebwallet-backend.git
cd zondwebwallet-backend
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm run dev
```

The server will start on the default port (usually 3000).

## Technology Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB
- **Blockchain Integration**: @theqrl/web3
- **API Documentation**: Swagger/OpenAPI

## API Documentation

API documentation is available at `/api-docs` when running the server locally.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Related Projects

- [Zond Web Wallet Frontend](https://github.com/DigitalGuards/zondwebwallet) - The frontend web application
