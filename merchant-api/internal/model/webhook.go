package model

import "time"

type WebhookDelivery struct {
	ID              string     `json:"id"`
	PaymentIntentID string     `json:"payment_intent_id"`
	MerchantID      string     `json:"merchant_id"`
	URL             string     `json:"url"`
	Payload         []byte     `json:"payload"`
	HMACSignature   string     `json:"hmac_signature"`
	StatusCode      int        `json:"status_code"`
	Attempt         int        `json:"attempt"`
	NextRetryAt     *time.Time `json:"next_retry_at,omitempty"`
	DeliveredAt     *time.Time `json:"delivered_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
}
