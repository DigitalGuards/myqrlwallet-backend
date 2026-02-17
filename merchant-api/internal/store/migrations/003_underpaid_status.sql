-- Add 'underpaid' to the payment status enum and merchant underpayment threshold.

-- 1. Expand the status CHECK constraint to include 'underpaid'.
ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_status_check
    CHECK (status IN ('pending','detected','confirmed','expired','underpaid'));

-- 2. Add underpayment tolerance (basis points, 0-10000) to merchants.
--    0 = no tolerance (default), 100 = 1%, 500 = 5%, etc.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS underpayment_threshold_bps INT NOT NULL DEFAULT 0;
