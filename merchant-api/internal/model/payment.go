package model

import "time"

type PaymentStatus string

const (
	StatusPending   PaymentStatus = "pending"
	StatusDetected  PaymentStatus = "detected"
	StatusConfirmed PaymentStatus = "confirmed"
	StatusExpired   PaymentStatus = "expired"
)

type PaymentIntent struct {
	ID               string        `json:"id"`
	MerchantID       string        `json:"merchant_id"`
	ExternalID       string        `json:"external_id"`
	DepositAddress   string        `json:"deposit_address"`
	ExpectedAmountWei string       `json:"expected_amount_wei"`
	ReceivedAmountWei string       `json:"received_amount_wei"`
	Status           PaymentStatus `json:"status"`
	TxHash           string        `json:"tx_hash,omitempty"`
	Confirmations    int           `json:"confirmations"`
	RequiredConfs    int           `json:"required_confirmations"`
	ExpiresAt        time.Time     `json:"expires_at"`
	WebhookEnqueued  bool          `json:"-"`
	CreatedAt        time.Time     `json:"created_at"`
	UpdatedAt        time.Time     `json:"updated_at"`
}
