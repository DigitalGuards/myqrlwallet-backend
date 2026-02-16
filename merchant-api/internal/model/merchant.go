package model

import "time"

type Merchant struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	APIKeyHash         string    `json:"-"`
	WebhookURL         string    `json:"webhook_url"`
	WebhookSecretEnc   []byte    `json:"-"`
	WebhookSecretNonce []byte    `json:"-"`
	IsActive           bool      `json:"is_active"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}
