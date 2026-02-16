CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    webhook_url TEXT NOT NULL,
    webhook_secret_enc BYTEA NOT NULL,
    webhook_secret_nonce BYTEA NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposit_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    address TEXT NOT NULL UNIQUE,
    encrypted_seed BYTEA NOT NULL,
    seed_nonce BYTEA NOT NULL,
    payment_intent_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallets_merchant ON deposit_wallets(merchant_id);
CREATE INDEX IF NOT EXISTS idx_wallets_address ON deposit_wallets(address);

CREATE TABLE IF NOT EXISTS payment_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    external_id TEXT NOT NULL,
    deposit_address TEXT NOT NULL,
    expected_amount_wei TEXT NOT NULL,
    received_amount_wei TEXT NOT NULL DEFAULT '0',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','detected','confirmed','expired')),
    tx_hash TEXT,
    confirmations INT NOT NULL DEFAULT 0,
    required_confs INT NOT NULL DEFAULT 10,
    expires_at TIMESTAMPTZ NOT NULL,
    webhook_delivered BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(merchant_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payment_intents(status);
CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payment_intents(merchant_id);
CREATE INDEX IF NOT EXISTS idx_payments_address ON payment_intents(deposit_address);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_intent_id UUID NOT NULL REFERENCES payment_intents(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    url TEXT NOT NULL,
    payload JSONB NOT NULL,
    hmac_signature TEXT NOT NULL,
    status_code INT NOT NULL DEFAULT 0,
    attempt INT NOT NULL DEFAULT 1,
    next_retry_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_pending ON webhook_deliveries(next_retry_at)
    WHERE delivered_at IS NULL;
