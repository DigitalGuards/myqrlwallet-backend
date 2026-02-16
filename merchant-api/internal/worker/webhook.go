package worker

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/DigitalGuards/merchant-api/internal/crypto"
	"github.com/DigitalGuards/merchant-api/internal/model"
	"github.com/DigitalGuards/merchant-api/internal/store"
)

// retryDelays defines the backoff schedule for webhook delivery attempts.
var retryDelays = []time.Duration{
	30 * time.Second,
	2 * time.Minute,
	15 * time.Minute,
	1 * time.Hour,
	4 * time.Hour,
}

// WebhookPayload is the JSON body sent to merchants on payment confirmation.
type WebhookPayload struct {
	PaymentID        string    `json:"payment_id"`
	ExternalID       string    `json:"external_id"`
	Status           string    `json:"status"`
	DepositAddress   string    `json:"deposit_address"`
	ExpectedAmountWei string  `json:"expected_amount_wei"`
	ReceivedAmountWei string  `json:"received_amount_wei"`
	TxHash           string    `json:"tx_hash,omitempty"`
	Confirmations    int       `json:"confirmations"`
	ConfirmedAt      time.Time `json:"confirmed_at"`
}

// WebhookWorker delivers webhook notifications for confirmed payments.
type WebhookWorker struct {
	store      store.Store
	masterKey  [32]byte
	interval   time.Duration
	maxRetries int
	timeout    time.Duration
	httpClient *http.Client
}

// NewWebhookWorker creates a new webhook delivery worker.
func NewWebhookWorker(s store.Store, masterKey [32]byte, interval time.Duration, maxRetries int, timeout time.Duration) *WebhookWorker {
	return &WebhookWorker{
		store:      s,
		masterKey:  masterKey,
		interval:   interval,
		maxRetries: maxRetries,
		timeout:    timeout,
		httpClient: &http.Client{Timeout: timeout},
	}
}

// Run starts the webhook delivery loop. Blocks until ctx is cancelled.
func (w *WebhookWorker) Run(ctx context.Context) {
	log.Printf("webhook: starting (interval=%s, maxRetries=%d)", w.interval, w.maxRetries)
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("webhook: shutting down")
			return
		case <-ticker.C:
			w.tick(ctx)
		}
	}
}

func (w *WebhookWorker) tick(ctx context.Context) {
	// Phase 1: Enqueue webhooks for newly confirmed payments
	w.enqueueNewWebhooks(ctx)

	// Phase 2: Deliver pending/retryable webhooks
	w.deliverPendingWebhooks(ctx)
}

func (w *WebhookWorker) enqueueNewWebhooks(ctx context.Context) {
	payments, err := w.store.ListUndeliveredConfirmed(ctx)
	if err != nil {
		log.Printf("webhook: list undelivered: %v", err)
		return
	}

	for _, p := range payments {
		merchant, err := w.store.GetMerchantByID(ctx, p.MerchantID)
		if err != nil {
			log.Printf("webhook: get merchant %s: %v", p.MerchantID, err)
			continue
		}
		if merchant == nil {
			log.Printf("webhook: merchant %s not found for payment %s", p.MerchantID, p.ID)
			continue
		}

		// Decrypt webhook secret
		secret, err := crypto.Decrypt(w.masterKey, merchant.WebhookSecretEnc, merchant.WebhookSecretNonce)
		if err != nil {
			log.Printf("webhook: decrypt secret for merchant %s: %v", merchant.ID, err)
			continue
		}

		// Build payload
		payload := WebhookPayload{
			PaymentID:         p.ID,
			ExternalID:        p.ExternalID,
			Status:            string(p.Status),
			DepositAddress:    p.DepositAddress,
			ExpectedAmountWei: p.ExpectedAmountWei,
			ReceivedAmountWei: p.ReceivedAmountWei,
			TxHash:            p.TxHash,
			Confirmations:     p.Confirmations,
			ConfirmedAt:       p.UpdatedAt,
		}

		payloadBytes, err := json.Marshal(payload)
		if err != nil {
			log.Printf("webhook: marshal payload for payment %s: %v", p.ID, err)
			continue
		}

		// Compute HMAC signature: t=<unix>,v1=<hmac>
		timestamp := time.Now().Unix()
		sig := computeSignature(secret, timestamp, payloadBytes)

		delivery := &model.WebhookDelivery{
			ID:              uuid.New().String(),
			PaymentIntentID: p.ID,
			MerchantID:      merchant.ID,
			URL:             merchant.WebhookURL,
			Payload:         payloadBytes,
			HMACSignature:   sig,
			StatusCode:      0,
			Attempt:         1,
			CreatedAt:       time.Now().UTC(),
		}

		if err := w.store.CreateWebhookDelivery(ctx, delivery); err != nil {
			log.Printf("webhook: create delivery for payment %s: %v", p.ID, err)
			continue
		}

		// Mark payment as webhook enqueued so we don't re-enqueue
		if err := w.store.MarkWebhookEnqueued(ctx, p.ID); err != nil {
			log.Printf("webhook: mark delivered for payment %s: %v", p.ID, err)
		}
	}
}

func (w *WebhookWorker) deliverPendingWebhooks(ctx context.Context) {
	deliveries, err := w.store.ListPendingWebhooks(ctx)
	if err != nil {
		log.Printf("webhook: list pending: %v", err)
		return
	}

	for _, d := range deliveries {
		w.deliver(ctx, d)
	}
}

func (w *WebhookWorker) deliver(ctx context.Context, d model.WebhookDelivery) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.URL, bytes.NewReader(d.Payload))
	if err != nil {
		log.Printf("webhook: create request for %s: %v", d.ID, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-QRL-Signature", d.HMACSignature)

	resp, err := w.httpClient.Do(req)
	if err != nil {
		log.Printf("webhook: deliver %s (attempt %d): %v", d.ID, d.Attempt, err)
		w.handleFailure(ctx, d, 0)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		log.Printf("webhook: delivered %s (attempt %d, status %d)", d.ID, d.Attempt, resp.StatusCode)
		if err := w.store.UpdateWebhookDelivery(ctx, d.ID, resp.StatusCode, true, nil); err != nil {
			log.Printf("webhook: update delivery %s: %v", d.ID, err)
		}
		return
	}

	log.Printf("webhook: deliver %s failed (attempt %d, status %d)", d.ID, d.Attempt, resp.StatusCode)
	w.handleFailure(ctx, d, resp.StatusCode)
}

func (w *WebhookWorker) handleFailure(ctx context.Context, d model.WebhookDelivery, statusCode int) {
	if d.Attempt >= w.maxRetries {
		log.Printf("webhook: delivery %s exhausted retries (%d attempts)", d.ID, d.Attempt)
		abandonTime := time.Now().UTC().AddDate(100, 0, 0).Format(time.RFC3339)
		if err := w.store.UpdateWebhookDelivery(ctx, d.ID, statusCode, false, &abandonTime); err != nil {
			log.Printf("webhook: update delivery %s: %v", d.ID, err)
		}
		return
	}

	// Schedule retry with exponential backoff
	delayIdx := d.Attempt - 1
	if delayIdx >= len(retryDelays) {
		delayIdx = len(retryDelays) - 1
	}
	nextRetry := time.Now().UTC().Add(retryDelays[delayIdx])
	nextRetryStr := nextRetry.Format(time.RFC3339)

	if err := w.store.UpdateWebhookDelivery(ctx, d.ID, statusCode, false, &nextRetryStr); err != nil {
		log.Printf("webhook: update delivery %s: %v", d.ID, err)
	}
}

// computeSignature creates the X-QRL-Signature header value.
// Format: t=<unix_timestamp>,v1=<HMAC-SHA256(secret, timestamp.payload)>
func computeSignature(secret []byte, timestamp int64, payload []byte) string {
	msg := fmt.Sprintf("%d.%s", timestamp, payload)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(msg))
	sig := hex.EncodeToString(mac.Sum(nil))
	return fmt.Sprintf("t=%d,v1=%s", timestamp, sig)
}
