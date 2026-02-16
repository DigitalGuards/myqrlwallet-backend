package model

import "time"

type PoolAddress struct {
	ID              string    `json:"id"`
	MerchantID      string    `json:"merchant_id"`
	Address         string    `json:"address"`
	Status          string    `json:"status"`
	PaymentIntentID string    `json:"payment_intent_id,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
}
