CREATE TABLE IF NOT EXISTS address_pool (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'assigned')),
    payment_intent_id UUID REFERENCES payment_intents(id) ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(address)
);
CREATE INDEX IF NOT EXISTS idx_pool_available ON address_pool(merchant_id, status)
    WHERE status = 'available';
