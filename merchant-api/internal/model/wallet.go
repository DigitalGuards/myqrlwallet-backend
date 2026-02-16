package model

import "time"

type DepositWallet struct {
	ID              string    `json:"id"`
	MerchantID      string    `json:"merchant_id"`
	Address         string    `json:"address"`
	EncryptedSeed   []byte    `json:"-"`
	SeedNonce       []byte    `json:"-"`
	PaymentIntentID string    `json:"payment_intent_id,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
}
