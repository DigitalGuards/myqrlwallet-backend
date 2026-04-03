# Merchant Payment API

A standalone Go microservice for accepting QRL payments. Non-custodial — merchants upload their own addresses and the service never holds private keys.

Located in the `merchant-api/` directory.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Merchant    │────▶│  Merchant API    │────▶│ PostgreSQL  │
│  (REST API)  │◀────│  (Go, port 8080) │◀────│             │
└──────────────┘     └───────┬──────────┘     └─────────────┘
                             │
                    ┌────────┴────────┐
                    │                 │
              ┌─────▼──────┐   ┌─────▼──────┐
              │  Monitor   │   │  Webhook   │
              │  Worker    │   │  Worker    │
              └─────┬──────┘   └─────┬──────┘
                    │                 │
           ┌───────┴───┐        ┌────▼────────┐
           │           │        │  Merchant   │
      ┌────▼───┐  ┌────▼───┐   │  Webhook    │
      │ Zond   │  │Zondscan│   │  Endpoint   │
      │ RPC    │  │  API   │   └─────────────┘
      └────────┘  └────────┘
```

**Components:**

1. **API Server** — REST endpoints for merchant operations, rate-limited with token bucket per client
2. **Monitor Worker** — Polls blockchain every 15s, detects deposits, tracks confirmations, expires stale payments
3. **Webhook Worker** — Delivers HMAC-signed callbacks with exponential backoff retry

## Features

- **Non-custodial**: Merchants generate and upload their own QRL addresses
- **Automatic deposit detection**: Scans new blocks via zondscan.com without merchant intervention
- **Confirmation tracking**: Promotes payments through `pending → detected → confirmed`
- **Underpayment handling**: Configurable tolerance threshold per merchant (basis points)
- **Webhook notifications**: HMAC-SHA256 signed callbacks when payments are confirmed
- **Idempotent operations**: Duplicate `external_id` returns existing payment safely
- **Rate limiting**: In-memory token bucket per API key with configurable RPS and burst
- **Encryption at rest**: Webhook secrets encrypted with AES-256-GCM

## Prerequisites

- Go 1.24+
- PostgreSQL 16+

## Quick Start

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

Database migrations run automatically on startup.

## Payment Flow

```
1. Merchant generates wallets locally     merchant-keygen -count 100
2. Merchant uploads public addresses      POST /v1/addresses (or via -api flag)
3. Customer checks out                    POST /v1/payments (assigns address from pool)
4. Customer sends QRL to address          (on-chain transaction)
5. Block scanner detects deposit          (automatic — scans zondscan every ~15s)
6. Monitor tracks confirmations           (automatic — checks tx receipt via RPC)
7. Payment confirmed                      (webhook fires to merchant URL)
```

## Payment Lifecycle

```
pending  ──▶  detected  ──▶  confirmed  ──▶  (webhook delivered)
  │                │
  │                └──────▶  underpaid   ──▶  (webhook delivered)
  │
  └──────▶  expired
```

| Status | Description |
|--------|-------------|
| `pending` | Created, waiting for deposit. Subject to TTL expiration. |
| `detected` | Balance found at deposit address. Tx hash may not be known yet. |
| `confirmed` | Sufficient confirmations and amount meets requirements (or within threshold). |
| `underpaid` | Confirmed but received less than expected, beyond merchant's tolerance. |
| `expired` | TTL exceeded while still pending. No longer accepts deposits. |

**Key transitions:**
- `pending → detected`: Monitor finds non-zero balance at deposit address via RPC
- `detected → confirmed`: Tx receipt found, confirmations >= required, amount sufficient
- `detected → underpaid`: Confirmed but shortfall exceeds `underpayment_threshold_bps`
- `pending → expired`: TTL exceeded, checked every monitor tick

Once a payment reaches `detected`, it is no longer subject to TTL expiration.

---

## API Reference

### Authentication

**Merchant endpoints** require an `X-API-Key` header:
```
X-API-Key: qrl_live_<64_hex_chars>
```

The server hashes the key with SHA-256 and looks up the merchant by hash. The plaintext key is never stored.

**Admin endpoints** require the `ADMIN_API_KEY` value in the same header. Validated with constant-time comparison.

### Endpoints

#### Health Check

```
GET /health

200 { "status": "ok" }
503 { "status": "unhealthy" }  (DB ping failed)
```

#### Create Merchant (Admin)

```
POST /v1/merchants
X-API-Key: <ADMIN_API_KEY>

Request:
{
  "name": "Acme Store",
  "webhook_url": "https://acme.com/webhooks/qrl",
  "underpayment_threshold_bps": 100
}

Response: 201
{
  "merchant_id": "uuid",
  "api_key": "qrl_live_<64_hex>",
  "webhook_secret": "whsec_<64_hex>",
  "created_at": "2026-01-15T10:30:00Z"
}
```

- `webhook_url` must be HTTPS. Private IPs, localhost, and link-local addresses are blocked (SSRF protection with DNS rebinding prevention).
- `underpayment_threshold_bps` is optional (0-1000 basis points). At 100 bps (1%), a payment expecting 1000 wei would accept 990+ wei as confirmed.
- **Save the `api_key` and `webhook_secret` immediately** — they are never shown again.

#### Upload Addresses

```
POST /v1/addresses
X-API-Key: <merchant_key>

Request:
{
  "addresses": ["Q1234...", "Q5678...", ...]
}

Response: 200
{
  "added": 98,
  "duplicates_skipped": 2,
  "pool_available": 98
}
```

- 1-1000 addresses per request
- Validates with `go-qrllib` `common.IsValidAddress()`
- Both Z-prefix and Q-prefix accepted (normalized to Q internally)
- Duplicates silently skipped via `ON CONFLICT DO NOTHING`

#### Get Pool Status

```
GET /v1/addresses
X-API-Key: <merchant_key>

Response: 200
{
  "available": 85,
  "assigned": 15,
  "total": 100
}
```

#### Create Payment Intent

```
POST /v1/payments
X-API-Key: <merchant_key>

Request:
{
  "external_id": "order-12345",
  "amount_wei": "1000000000000000000",
  "required_confirmations": 3,
  "ttl_minutes": 120
}

Response: 201 (new) or 200 (existing with same external_id)
{
  "id": "uuid",
  "merchant_id": "uuid",
  "external_id": "order-12345",
  "deposit_address": "Q1234...abcd",
  "expected_amount_wei": "1000000000000000000",
  "received_amount_wei": "0",
  "status": "pending",
  "tx_hash": "",
  "confirmations": 0,
  "required_confirmations": 3,
  "expires_at": "2026-01-15T12:30:00Z",
  "created_at": "2026-01-15T10:30:00Z",
  "updated_at": "2026-01-15T10:30:00Z"
}
```

- `external_id` must be unique per merchant. Duplicate returns the existing payment (200) — safe for retries.
- `amount_wei` is a string to handle arbitrarily large integers.
- `required_confirmations` max: 1000. Default: 1.
- `ttl_minutes` max: 10,080 (7 days). Default: 60.
- Returns **409 Conflict** if no addresses available in the pool.
- Address assignment uses `FOR UPDATE SKIP LOCKED` to prevent race conditions.

#### Get Payment

```
GET /v1/payments/{id}
GET /v1/payments?external_id=order-12345
X-API-Key: <merchant_key>

Response: 200 { payment object }
         404 { "error": "payment not found" }
```

Merchants can only access their own payments.

#### Submit Transaction Hash

```
PATCH /v1/payments/{id}/tx
X-API-Key: <merchant_key>

Request:
{
  "tx_hash": "0x<64_hex_chars>"
}

Response: 200 { updated payment object }
```

- Optional fast-path if merchant knows the tx hash before the block scanner finds it
- Only valid for `pending` or `detected` payments
- Format: `0x`-prefixed, 64 hex characters

### Error Responses

| Code | Meaning |
|------|---------|
| 400 | Validation error (bad input, invalid address, etc.) |
| 401 | Missing or invalid API key |
| 403 | Merchant doesn't own the requested resource |
| 404 | Resource not found |
| 409 | Conflict (no available addresses, invalid state transition) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |
| 503 | Service unavailable (health check) |

---

## Webhook Delivery

### Signature Format

```
X-QRL-Signature: t=1705312200,v1=a1b2c3d4...
```

**Verification (merchant-side):**
1. Extract `t` (timestamp) and `v1` (signature) from header
2. Compute: `HMAC-SHA256(webhook_secret, "<t>.<json_payload>")`
3. Compare with `v1` using constant-time comparison
4. Optionally reject if `t` is more than 5 minutes old

### Webhook Payload

```json
{
  "payment_id": "uuid",
  "external_id": "order-12345",
  "status": "confirmed",
  "deposit_address": "Q1234...abcd",
  "expected_amount_wei": "1000000000000000000",
  "received_amount_wei": "1000000000000000000",
  "tx_hash": "0xabc123...",
  "confirmations": 3,
  "confirmed_at": "2026-01-15T10:35:00Z"
}
```

`status` is either `confirmed` or `underpaid`.

### Retry Schedule

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 30 seconds |
| 3 | 2 minutes |
| 4 | 15 minutes |
| 5 | 1 hour |
| 6 | 4 hours |
| 7+ | Abandoned |

Max retries configurable via `WEBHOOK_MAX_RETRIES` (default: 5).

A webhook is enqueued exactly once per payment via the `webhook_enqueued` flag — idempotent across status transitions.

### SSRF Protection

Webhook delivery uses a custom HTTP dialer that blocks connections to:
- Loopback addresses (127.0.0.0/8, ::1)
- Private networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Link-local addresses (169.254.0.0/16, fe80::/10)
- Unspecified addresses (0.0.0.0, ::)

DNS resolution is checked at connection time to prevent rebinding attacks.

---

## On-Chain Monitoring

### Block Scanning

1. Query zondscan for latest block number
2. Compare with persisted cursor (`kv_state['last_scanned_block']`)
3. Process up to 10 blocks per tick (prevents backlog on restart)
4. For each successful transaction: check if recipient matches an assigned address
5. If matched: set the payment's `tx_hash`
6. Cursor persisted after each block — survives restarts without re-scanning

### Balance & Confirmation Tracking

- **Pending payments**: RPC `qrl_getBalance` polled each tick. Non-zero → `detected`.
- **Detected payments**: RPC `qrl_getTransactionReceipt` for confirmation count. Once confirmations >= required: evaluate amount.
- **Amount evaluation**: If received >= expected (or within threshold) → `confirmed`. Otherwise → `underpaid`.

Only `pending` and `detected` payments are actively monitored.

---

## Merchant Keygen Tool

CLI tool for generating QRL wallets locally. Private keys never leave the merchant's machine.

### Build

```bash
cd merchant-api
go build -o merchant-keygen ./cmd/merchant-keygen
```

### Usage

```bash
# Generate 50 wallets, save keys locally
./merchant-keygen -count 50 -out ./my-wallets

# Generate and upload addresses to API in one step
./merchant-keygen -count 100 -out ./my-wallets \
  -api https://api.example.com \
  -key qrl_live_your_api_key_here
```

### Output Files

- `wallets-SECRET-<timestamp>.csv` — Private keys (address, extended_seed_hex). File permissions `0600`. **Store offline, never share.**
- `addresses-<timestamp>.json` — Public addresses array. Safe to upload.

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-count` | 10 | Number of wallets to generate (1-1000) |
| `-out` | `.` | Output directory |
| `-api` | — | Merchant API base URL (enables auto-upload) |
| `-key` | — | Merchant API key (required with `-api`) |

Uses ML-DSA-87 key generation via `go-qrllib`. Wallet memory is zeroized after address extraction.

---

## Database Schema

### Tables

**merchants**
| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Merchant identifier |
| `name` | TEXT | Display name |
| `api_key_hash` | TEXT UNIQUE | SHA-256 hash of API key |
| `webhook_url` | TEXT | HTTPS callback URL |
| `webhook_secret_enc` | BYTEA | AES-256-GCM encrypted webhook secret |
| `webhook_secret_nonce` | BYTEA | Encryption nonce |
| `is_active` | BOOLEAN | Whether merchant can make requests |
| `underpayment_threshold_bps` | INT | Tolerance in basis points (0-1000) |

**payment_intents**
| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Payment identifier |
| `merchant_id` | UUID FK | Owning merchant |
| `external_id` | TEXT | Merchant's reference (unique per merchant) |
| `deposit_address` | TEXT | Assigned from pool |
| `expected_amount_wei` | TEXT | String for large integer precision |
| `received_amount_wei` | TEXT | Detected balance |
| `status` | TEXT | `pending\|detected\|confirmed\|expired\|underpaid` |
| `tx_hash` | TEXT | Set when block scanner finds transaction |
| `confirmations` | INT | Current confirmation count |
| `required_confs` | INT | Required before confirming |
| `expires_at` | TIMESTAMPTZ | TTL deadline |
| `webhook_enqueued` | BOOLEAN | Idempotency flag for webhook creation |

**address_pool**
| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Address record identifier |
| `merchant_id` | UUID FK | Owning merchant |
| `address` | TEXT UNIQUE | Q-prefix QRL address |
| `status` | TEXT | `available\|assigned` |
| `payment_intent_id` | UUID FK | Assigned payment (if any) |

**webhook_deliveries**
| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Delivery record identifier |
| `payment_intent_id` | UUID FK | Associated payment |
| `merchant_id` | UUID FK | Target merchant |
| `url` | TEXT | Delivery URL |
| `payload` | JSONB | Serialized webhook body |
| `hmac_signature` | TEXT | `t=<unix>,v1=<hex>` |
| `status_code` | INT | HTTP response (0 = not yet delivered) |
| `attempt` | INT | Current attempt number |
| `next_retry_at` | TIMESTAMPTZ | When to retry (NULL if delivered) |
| `delivered_at` | TIMESTAMPTZ | Successful delivery time |

**kv_state**
| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT PK | State key |
| `value` | TEXT | State value |

Used for `last_scanned_block` cursor persistence.

### Migrations

Located in `internal/store/migrations/`:
- `001_initial.sql` — merchants, payment_intents, webhook_deliveries
- `002_address_pool.sql` — address_pool, kv_state
- `003_underpaid_status.sql` — underpaid enum value, threshold column

Run automatically on startup.

---

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `ADMIN_API_KEY` | Yes | — | Admin key for merchant creation |
| `MASTER_ENCRYPTION_KEY` | Yes | — | 64 hex chars (32 bytes) for AES-256-GCM |
| `PORT` | No | 8080 | HTTP server port |
| `ZOND_RPC_ENDPOINT` | No | http://localhost:8545 | Zond node JSON-RPC URL |
| `ZONDSCAN_URL` | No | https://zondscan.com/api | Block scanner endpoint |
| `ZONDSCAN_TIMEOUT_SECONDS` | No | 10 | Zondscan HTTP client timeout |
| `MONITOR_INTERVAL_SECONDS` | No | 15 | Block monitor polling interval |
| `DEFAULT_REQUIRED_CONFIRMATIONS` | No | 1 | Default confirmations per payment |
| `DEFAULT_PAYMENT_TTL_MINUTES` | No | 60 | Default payment expiration |
| `WEBHOOK_INTERVAL_SECONDS` | No | 15 | Webhook delivery polling interval |
| `WEBHOOK_MAX_RETRIES` | No | 5 | Max webhook delivery attempts |
| `WEBHOOK_TIMEOUT_SECONDS` | No | 10 | Webhook HTTP request timeout |
| `RATE_LIMIT_RPS` | No | 10 | Requests per second per client |
| `RATE_LIMIT_BURST` | No | 30 | Max burst size |

### Database Connection Pool

- Max open connections: 25
- Max idle connections: 5
- Connection max lifetime: 5 minutes

---

## Security

- **API keys**: Only SHA-256 hash stored. Plaintext shown once at creation.
- **Webhook secrets**: AES-256-GCM encrypted with unique nonce per secret. Decrypted only when enqueuing webhooks.
- **Admin auth**: Constant-time comparison via `subtle.ConstantTimeCompare()`
- **Webhook signatures**: HMAC-SHA256 with timestamp to prevent replay attacks
- **SSRF prevention**: Webhook URLs validated for HTTPS, no private IPs, DNS rebinding protection
- **Rate limiting**: In-memory token bucket with auto-cleanup (10min inactive, 100k max buckets)
- **Request size**: 1MB body limit via `http.MaxBytesReader()`
- **Address assignment**: `FOR UPDATE SKIP LOCKED` prevents race conditions
- **Graceful shutdown**: Signal-based context cancellation propagated to all workers

## Project Structure

```
merchant-api/
├── cmd/
│   ├── merchant-api/           # Server entry point (main.go)
│   └── merchant-keygen/        # Client-side wallet generator (main.go)
├── internal/
│   ├── address/                # Address normalization (Z→Q prefix)
│   │   ├── normalize.go
│   │   └── normalize_test.go
│   ├── config/                 # Environment configuration
│   │   └── config.go
│   ├── crypto/                 # AES-256-GCM encryption + wallet generation
│   │   ├── encrypt.go
│   │   ├── encrypt_test.go
│   │   └── wallet.go
│   ├── handler/                # HTTP handlers + middleware
│   │   ├── address.go          # POST/GET /v1/addresses
│   │   ├── handler_test.go
│   │   ├── merchant.go         # POST /v1/merchants
│   │   ├── middleware.go       # Auth, panic recovery, body limit
│   │   ├── payment.go          # POST/GET/PATCH /v1/payments
│   │   ├── ratelimit.go        # Token bucket rate limiter
│   │   └── routes.go           # Route registration
│   ├── model/                  # Domain types
│   │   ├── merchant.go
│   │   ├── payment.go
│   │   └── webhook.go
│   ├── rpc/                    # Zond JSON-RPC client
│   │   ├── client.go           # GetBalance, BlockNumber, GetReceipt
│   │   └── types.go
│   ├── store/                  # PostgreSQL store + migrations
│   │   ├── migrations/
│   │   │   ├── 001_initial.sql
│   │   │   ├── 002_address_pool.sql
│   │   │   └── 003_underpaid_status.sql
│   │   └── postgres.go
│   ├── worker/                 # Background workers
│   │   ├── monitor.go          # Block scanner + payment status updater
│   │   ├── monitor_test.go
│   │   ├── webhook.go          # Webhook enqueue + delivery
│   │   └── webhook_test.go
│   └── zondscan/               # Zondscan REST API client
│       └── client.go
└── go.mod
```
