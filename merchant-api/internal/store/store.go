package store

import (
	"context"

	"github.com/DigitalGuards/merchant-api/internal/model"
)

// Store defines the persistence interface for the merchant payment API.
type Store interface {
	// Ping checks database connectivity.
	Ping(ctx context.Context) error

	// Merchants
	CreateMerchant(ctx context.Context, m *model.Merchant) error
	GetMerchantByAPIKeyHash(ctx context.Context, hash string) (*model.Merchant, error)
	GetMerchantByID(ctx context.Context, id string) (*model.Merchant, error)

	// Deposit Wallets
	CreateDepositWallet(ctx context.Context, w *model.DepositWallet) error
	GetDepositWalletByAddress(ctx context.Context, address string) (*model.DepositWallet, error)

	// Address Pool
	AddPoolAddresses(ctx context.Context, merchantID string, addresses []string) (int, error)
	GetPoolStatus(ctx context.Context, merchantID string) (available int, assigned int, err error)
	AssignAddressAndCreatePayment(ctx context.Context, p *model.PaymentIntent) error

	// Payment Intents
	CreatePaymentWithWallet(ctx context.Context, w *model.DepositWallet, p *model.PaymentIntent) error
	CreatePaymentIntent(ctx context.Context, p *model.PaymentIntent) error
	GetPaymentIntent(ctx context.Context, id string) (*model.PaymentIntent, error)
	GetPaymentIntentByExternalID(ctx context.Context, merchantID, externalID string) (*model.PaymentIntent, error)
	ListPendingPayments(ctx context.Context) ([]model.PaymentIntent, error)
	SetPaymentTxHash(ctx context.Context, id string, txHash string) error
	UpdatePaymentStatus(ctx context.Context, id string, status model.PaymentStatus, txHash string, received string, confirmations int) error
	ExpireStalePayments(ctx context.Context) (int64, error)
	ListUndeliveredConfirmed(ctx context.Context) ([]model.PaymentIntent, error)
	MarkWebhookEnqueued(ctx context.Context, paymentID string) error

	// Webhook Deliveries
	CreateWebhookDelivery(ctx context.Context, d *model.WebhookDelivery) error
	ListPendingWebhooks(ctx context.Context) ([]model.WebhookDelivery, error)
	UpdateWebhookDelivery(ctx context.Context, id string, statusCode int, delivered bool, nextRetry *string) error
}
