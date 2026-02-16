package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"

	"github.com/DigitalGuards/merchant-api/internal/model"
)

//go:embed migrations/*.sql
var migrations embed.FS

// PostgresStore implements Store using PostgreSQL.
type PostgresStore struct {
	db *sql.DB
}

// NewPostgresStore creates a new PostgresStore and runs migrations.
func NewPostgresStore(db *sql.DB) (*PostgresStore, error) {
	s := &PostgresStore{db: db}
	if err := s.migrate(); err != nil {
		return nil, fmt.Errorf("run migrations: %w", err)
	}
	return s, nil
}

func (s *PostgresStore) migrate() error {
	data, err := migrations.ReadFile("migrations/001_initial.sql")
	if err != nil {
		return fmt.Errorf("read migration: %w", err)
	}
	_, err = s.db.ExecContext(context.Background(), string(data))
	return err
}

func (s *PostgresStore) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

// --- Merchants ---

func (s *PostgresStore) CreateMerchant(ctx context.Context, m *model.Merchant) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO merchants (id, name, api_key_hash, webhook_url, webhook_secret_enc, webhook_secret_nonce, is_active, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		m.ID, m.Name, m.APIKeyHash, m.WebhookURL, m.WebhookSecretEnc, m.WebhookSecretNonce, m.IsActive, m.CreatedAt, m.UpdatedAt,
	)
	return err
}

func (s *PostgresStore) GetMerchantByAPIKeyHash(ctx context.Context, hash string) (*model.Merchant, error) {
	m := &model.Merchant{}
	err := s.db.QueryRowContext(ctx,
		`SELECT id, name, api_key_hash, webhook_url, webhook_secret_enc, webhook_secret_nonce, is_active, created_at, updated_at
		 FROM merchants WHERE api_key_hash = $1 AND is_active = TRUE`, hash,
	).Scan(&m.ID, &m.Name, &m.APIKeyHash, &m.WebhookURL, &m.WebhookSecretEnc, &m.WebhookSecretNonce, &m.IsActive, &m.CreatedAt, &m.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return m, err
}

func (s *PostgresStore) GetMerchantByID(ctx context.Context, id string) (*model.Merchant, error) {
	m := &model.Merchant{}
	err := s.db.QueryRowContext(ctx,
		`SELECT id, name, api_key_hash, webhook_url, webhook_secret_enc, webhook_secret_nonce, is_active, created_at, updated_at
		 FROM merchants WHERE id = $1`, id,
	).Scan(&m.ID, &m.Name, &m.APIKeyHash, &m.WebhookURL, &m.WebhookSecretEnc, &m.WebhookSecretNonce, &m.IsActive, &m.CreatedAt, &m.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return m, err
}

// --- Deposit Wallets ---

func (s *PostgresStore) CreateDepositWallet(ctx context.Context, w *model.DepositWallet) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO deposit_wallets (id, merchant_id, address, encrypted_seed, seed_nonce, payment_intent_id, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		w.ID, w.MerchantID, w.Address, w.EncryptedSeed, w.SeedNonce, nilIfEmpty(w.PaymentIntentID), w.CreatedAt,
	)
	return err
}

func (s *PostgresStore) GetDepositWalletByAddress(ctx context.Context, address string) (*model.DepositWallet, error) {
	w := &model.DepositWallet{}
	var paymentID sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, merchant_id, address, encrypted_seed, seed_nonce, payment_intent_id, created_at
		 FROM deposit_wallets WHERE address = $1`, address,
	).Scan(&w.ID, &w.MerchantID, &w.Address, &w.EncryptedSeed, &w.SeedNonce, &paymentID, &w.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if paymentID.Valid {
		w.PaymentIntentID = paymentID.String
	}
	return w, err
}

// --- Payment Intents ---

func (s *PostgresStore) CreatePaymentWithWallet(ctx context.Context, w *model.DepositWallet, p *model.PaymentIntent) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx,
		`INSERT INTO deposit_wallets (id, merchant_id, address, encrypted_seed, seed_nonce, payment_intent_id, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		w.ID, w.MerchantID, w.Address, w.EncryptedSeed, w.SeedNonce, nilIfEmpty(w.PaymentIntentID), w.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert wallet: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO payment_intents (id, merchant_id, external_id, deposit_address, expected_amount_wei, received_amount_wei, status, required_confs, expires_at, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		p.ID, p.MerchantID, p.ExternalID, p.DepositAddress, p.ExpectedAmountWei, p.ReceivedAmountWei, p.Status, p.RequiredConfs, p.ExpiresAt, p.CreatedAt, p.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert payment: %w", err)
	}

	return tx.Commit()
}

func (s *PostgresStore) CreatePaymentIntent(ctx context.Context, p *model.PaymentIntent) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO payment_intents (id, merchant_id, external_id, deposit_address, expected_amount_wei, received_amount_wei, status, required_confs, expires_at, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		p.ID, p.MerchantID, p.ExternalID, p.DepositAddress, p.ExpectedAmountWei, p.ReceivedAmountWei, p.Status, p.RequiredConfs, p.ExpiresAt, p.CreatedAt, p.UpdatedAt,
	)
	return err
}

func (s *PostgresStore) GetPaymentIntent(ctx context.Context, id string) (*model.PaymentIntent, error) {
	p := &model.PaymentIntent{}
	var txHash sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, merchant_id, external_id, deposit_address, expected_amount_wei, received_amount_wei, status, tx_hash, confirmations, required_confs, expires_at, webhook_enqueued, created_at, updated_at
		 FROM payment_intents WHERE id = $1`, id,
	).Scan(&p.ID, &p.MerchantID, &p.ExternalID, &p.DepositAddress, &p.ExpectedAmountWei, &p.ReceivedAmountWei, &p.Status, &txHash, &p.Confirmations, &p.RequiredConfs, &p.ExpiresAt, &p.WebhookEnqueued, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if txHash.Valid {
		p.TxHash = txHash.String
	}
	return p, err
}

func (s *PostgresStore) GetPaymentIntentByExternalID(ctx context.Context, merchantID, externalID string) (*model.PaymentIntent, error) {
	p := &model.PaymentIntent{}
	var txHash sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, merchant_id, external_id, deposit_address, expected_amount_wei, received_amount_wei, status, tx_hash, confirmations, required_confs, expires_at, webhook_enqueued, created_at, updated_at
		 FROM payment_intents WHERE merchant_id = $1 AND external_id = $2`, merchantID, externalID,
	).Scan(&p.ID, &p.MerchantID, &p.ExternalID, &p.DepositAddress, &p.ExpectedAmountWei, &p.ReceivedAmountWei, &p.Status, &txHash, &p.Confirmations, &p.RequiredConfs, &p.ExpiresAt, &p.WebhookEnqueued, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if txHash.Valid {
		p.TxHash = txHash.String
	}
	return p, err
}

func (s *PostgresStore) ListPendingPayments(ctx context.Context) ([]model.PaymentIntent, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, merchant_id, external_id, deposit_address, expected_amount_wei, received_amount_wei, status, tx_hash, confirmations, required_confs, expires_at, webhook_enqueued, created_at, updated_at
		 FROM payment_intents WHERE status IN ('pending', 'detected') LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPayments(rows)
}

func (s *PostgresStore) SetPaymentTxHash(ctx context.Context, id string, txHash string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE payment_intents SET tx_hash = $2, updated_at = NOW() WHERE id = $1`,
		id, txHash,
	)
	return err
}

func (s *PostgresStore) UpdatePaymentStatus(ctx context.Context, id string, status model.PaymentStatus, txHash string, received string, confirmations int) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE payment_intents SET status = $2, tx_hash = $3, received_amount_wei = $4, confirmations = $5, updated_at = NOW()
		 WHERE id = $1`, id, status, nilIfEmpty(txHash), received, confirmations,
	)
	return err
}

func (s *PostgresStore) ExpireStalePayments(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE payment_intents SET status = 'expired', updated_at = NOW()
		 WHERE status = 'pending' AND expires_at < NOW()`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *PostgresStore) ListUndeliveredConfirmed(ctx context.Context) ([]model.PaymentIntent, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, merchant_id, external_id, deposit_address, expected_amount_wei, received_amount_wei, status, tx_hash, confirmations, required_confs, expires_at, webhook_enqueued, created_at, updated_at
		 FROM payment_intents WHERE status = 'confirmed' AND webhook_enqueued = FALSE LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPayments(rows)
}

func (s *PostgresStore) MarkWebhookEnqueued(ctx context.Context, paymentID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE payment_intents SET webhook_enqueued = TRUE, updated_at = NOW() WHERE id = $1`, paymentID)
	return err
}

// --- Webhook Deliveries ---

func (s *PostgresStore) CreateWebhookDelivery(ctx context.Context, d *model.WebhookDelivery) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO webhook_deliveries (id, payment_intent_id, merchant_id, url, payload, hmac_signature, status_code, attempt, next_retry_at, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		d.ID, d.PaymentIntentID, d.MerchantID, d.URL, d.Payload, d.HMACSignature, d.StatusCode, d.Attempt, d.NextRetryAt, d.CreatedAt,
	)
	return err
}

func (s *PostgresStore) ListPendingWebhooks(ctx context.Context) ([]model.WebhookDelivery, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, payment_intent_id, merchant_id, url, payload, hmac_signature, status_code, attempt, next_retry_at, delivered_at, created_at
		 FROM webhook_deliveries WHERE delivered_at IS NULL AND (next_retry_at IS NULL OR next_retry_at <= NOW())
		 ORDER BY created_at ASC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var deliveries []model.WebhookDelivery
	for rows.Next() {
		var d model.WebhookDelivery
		if err := rows.Scan(&d.ID, &d.PaymentIntentID, &d.MerchantID, &d.URL, &d.Payload, &d.HMACSignature, &d.StatusCode, &d.Attempt, &d.NextRetryAt, &d.DeliveredAt, &d.CreatedAt); err != nil {
			return nil, err
		}
		deliveries = append(deliveries, d)
	}
	return deliveries, rows.Err()
}

func (s *PostgresStore) UpdateWebhookDelivery(ctx context.Context, id string, statusCode int, delivered bool, nextRetry *string) error {
	if delivered {
		_, err := s.db.ExecContext(ctx,
			`UPDATE webhook_deliveries SET status_code = $2, delivered_at = NOW() WHERE id = $1`, id, statusCode)
		return err
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE webhook_deliveries SET status_code = $2, attempt = attempt + 1, next_retry_at = $3 WHERE id = $1`, id, statusCode, nextRetry)
	return err
}

// --- Helpers ---

func scanPayments(rows *sql.Rows) ([]model.PaymentIntent, error) {
	var payments []model.PaymentIntent
	for rows.Next() {
		var p model.PaymentIntent
		var txHash sql.NullString
		if err := rows.Scan(&p.ID, &p.MerchantID, &p.ExternalID, &p.DepositAddress, &p.ExpectedAmountWei, &p.ReceivedAmountWei, &p.Status, &txHash, &p.Confirmations, &p.RequiredConfs, &p.ExpiresAt, &p.WebhookEnqueued, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		if txHash.Valid {
			p.TxHash = txHash.String
		}
		payments = append(payments, p)
	}
	return payments, rows.Err()
}

func nilIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
