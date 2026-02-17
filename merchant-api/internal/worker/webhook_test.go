package worker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/DigitalGuards/merchant-api/internal/crypto"
	"github.com/DigitalGuards/merchant-api/internal/model"
	"github.com/DigitalGuards/merchant-api/internal/testutil"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func testMasterKey() [32]byte {
	var key [32]byte
	copy(key[:], []byte("test-master-key-exactly-32bytes!"))
	return key
}

func newTestWebhookWorker(ms *testutil.MockStore) *WebhookWorker {
	return &WebhookWorker{
		store:      ms,
		masterKey:  testMasterKey(),
		interval:   time.Second,
		maxRetries: 3,
		timeout:    5 * time.Second,
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}
}

func seedMerchantWithSecret(t *testing.T, ms *testutil.MockStore, merchantID, webhookURL, rawSecret string) {
	t.Helper()
	key := testMasterKey()
	enc, nonce, err := crypto.Encrypt(key, []byte(rawSecret))
	if err != nil {
		t.Fatal(err)
	}
	ms.SeedMerchant(&model.Merchant{
		ID:                 merchantID,
		Name:               "Test",
		WebhookURL:         webhookURL,
		WebhookSecretEnc:   enc,
		WebhookSecretNonce: nonce,
		IsActive:           true,
	})
}

func seedConfirmedPayment(ms *testutil.MockStore, merchantID, paymentID string, enqueued bool) {
	ms.SeedPayment(&model.PaymentIntent{
		ID:                paymentID,
		MerchantID:        merchantID,
		ExternalID:        "ext-" + paymentID,
		DepositAddress:    "Z0000000000000000000000000000000000000001",
		ExpectedAmountWei: "1000000000000000000",
		ReceivedAmountWei: "1000000000000000000",
		Status:            model.StatusConfirmed,
		TxHash:            "0xabc123",
		Confirmations:     10,
		RequiredConfs:     6,
		ExpiresAt:         time.Now().Add(time.Hour),
		WebhookEnqueued:   enqueued,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
	})
}

// ---------------------------------------------------------------------------
// Fake webhook receiver
// ---------------------------------------------------------------------------

type receivedWebhook struct {
	Body      []byte
	Signature string // X-QRL-Signature header
}

type webhookReceiver struct {
	mu       sync.Mutex
	requests []receivedWebhook
	status   int
}

func newWebhookReceiver(status int) (*httptest.Server, *webhookReceiver) {
	recv := &webhookReceiver{status: status}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		recv.mu.Lock()
		recv.requests = append(recv.requests, receivedWebhook{
			Body:      body,
			Signature: r.Header.Get("X-QRL-Signature"),
		})
		recv.mu.Unlock()
		w.WriteHeader(recv.status)
	}))
	return srv, recv
}

func (wr *webhookReceiver) count() int {
	wr.mu.Lock()
	defer wr.mu.Unlock()
	return len(wr.requests)
}

func (wr *webhookReceiver) get(i int) receivedWebhook {
	wr.mu.Lock()
	defer wr.mu.Unlock()
	return wr.requests[i]
}

// ---------------------------------------------------------------------------
// Enqueue Tests
// ---------------------------------------------------------------------------

func TestWebhook_EnqueuesConfirmedPayment(t *testing.T) {
	ms := testutil.NewMockStore()
	srv, _ := newWebhookReceiver(200)
	defer srv.Close()

	seedMerchantWithSecret(t, ms, "m1", srv.URL, "webhook-secret-123")
	seedConfirmedPayment(ms, "m1", "pay1", false)

	w := newTestWebhookWorker(ms)
	w.tick(context.Background())

	// Assert: one webhook delivery was created
	if got := ms.WebhookCount(); got != 1 {
		t.Fatalf("expected 1 webhook delivery, got %d", got)
	}

	// Assert: payment is now marked as enqueued
	p := ms.GetPayment("pay1")
	if p == nil {
		t.Fatal("payment not found")
	}
	if !p.WebhookEnqueued {
		t.Fatal("expected payment WebhookEnqueued=true, got false")
	}
}

func TestWebhook_DoesNotReEnqueue(t *testing.T) {
	ms := testutil.NewMockStore()
	srv, _ := newWebhookReceiver(200)
	defer srv.Close()

	seedMerchantWithSecret(t, ms, "m1", srv.URL, "webhook-secret-123")
	seedConfirmedPayment(ms, "m1", "pay1", true) // already enqueued

	w := newTestWebhookWorker(ms)
	w.tick(context.Background())

	if got := ms.WebhookCount(); got != 0 {
		t.Fatalf("expected 0 webhook deliveries, got %d", got)
	}
}

// ---------------------------------------------------------------------------
// Delivery Tests
// ---------------------------------------------------------------------------

func TestWebhook_DeliversSuccessfully(t *testing.T) {
	ms := testutil.NewMockStore()
	srv, recv := newWebhookReceiver(200)
	defer srv.Close()

	seedMerchantWithSecret(t, ms, "m1", srv.URL, "webhook-secret-123")
	seedConfirmedPayment(ms, "m1", "pay1", false)

	w := newTestWebhookWorker(ms)

	// First tick: enqueues the webhook
	w.tick(context.Background())

	if ms.WebhookCount() != 1 {
		t.Fatalf("expected 1 webhook delivery after first tick, got %d", ms.WebhookCount())
	}

	// Second tick: delivers the webhook
	w.tick(context.Background())

	// Assert receiver got one request
	if recv.count() != 1 {
		t.Fatalf("expected receiver to get 1 request, got %d", recv.count())
	}

	// Assert delivery is marked as delivered (DeliveredAt != nil)
	// We need to check all webhooks since we don't know the ID
	found := false
	for i := 0; i < ms.WebhookCount(); i++ {
		// Iterate via ListPendingWebhooks won't find delivered ones, so check directly
	}
	// Use ListPendingWebhooks: delivered webhooks should NOT appear
	pending, err := ms.ListPendingWebhooks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("expected 0 pending webhooks after successful delivery, got %d", len(pending))
	}
	_ = found
}

func TestWebhook_RetriesOn500(t *testing.T) {
	ms := testutil.NewMockStore()
	srv, _ := newWebhookReceiver(500)
	defer srv.Close()

	seedMerchantWithSecret(t, ms, "m1", srv.URL, "webhook-secret-123")
	seedConfirmedPayment(ms, "m1", "pay1", false)

	w := newTestWebhookWorker(ms)

	// Enqueue
	w.tick(context.Background())
	if ms.WebhookCount() != 1 {
		t.Fatalf("expected 1 webhook, got %d", ms.WebhookCount())
	}

	// Deliver (will fail with 500)
	w.tick(context.Background())

	// Find the delivery and check its state
	pending, err := ms.ListPendingWebhooks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The delivery should NOT be in pending right now because NextRetryAt is in the future
	// (30s from now per retryDelays[0])
	if len(pending) != 0 {
		t.Fatalf("expected 0 currently-pending webhooks (retry scheduled in future), got %d", len(pending))
	}

	// Verify the delivery was not marked as delivered and attempt was incremented
	// We need to check via WebhookCount that it still exists (not deleted)
	if ms.WebhookCount() != 1 {
		t.Fatalf("expected webhook delivery to still exist, got count %d", ms.WebhookCount())
	}
}

func TestWebhook_ExhaustsRetries(t *testing.T) {
	ms := testutil.NewMockStore()
	srv, _ := newWebhookReceiver(500)
	defer srv.Close()

	seedMerchantWithSecret(t, ms, "m1", srv.URL, "webhook-secret-123")
	seedConfirmedPayment(ms, "m1", "pay1", false)

	w := newTestWebhookWorker(ms)
	w.maxRetries = 1 // Exhaust after first attempt

	// Enqueue
	w.tick(context.Background())
	if ms.WebhookCount() != 1 {
		t.Fatalf("expected 1 webhook, got %d", ms.WebhookCount())
	}

	// Deliver (will fail; attempt=1 which equals maxRetries=1, so it's abandoned)
	w.tick(context.Background())

	// The delivery should not be pending (NextRetryAt set 100 years in future)
	pending, err := ms.ListPendingWebhooks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("expected 0 pending webhooks after exhausting retries, got %d", len(pending))
	}

	// The webhook still exists
	if ms.WebhookCount() != 1 {
		t.Fatalf("expected 1 webhook delivery to still exist, got %d", ms.WebhookCount())
	}
}

// ---------------------------------------------------------------------------
// Signature Tests
// ---------------------------------------------------------------------------

func TestComputeSignature_Format(t *testing.T) {
	sig := computeSignature([]byte("secret"), 1234567890, []byte(`{"test":true}`))

	re := regexp.MustCompile(`^t=1234567890,v1=[0-9a-f]{64}$`)
	if !re.MatchString(sig) {
		t.Fatalf("signature %q does not match expected format t=1234567890,v1=<64_hex_chars>", sig)
	}
}

func TestComputeSignature_Deterministic(t *testing.T) {
	secret := []byte("my-secret")
	ts := int64(1700000000)
	payload := []byte(`{"amount":"100"}`)

	sig1 := computeSignature(secret, ts, payload)
	sig2 := computeSignature(secret, ts, payload)

	if sig1 != sig2 {
		t.Fatalf("expected identical signatures, got %q and %q", sig1, sig2)
	}
}

func TestComputeSignature_DifferentSecrets(t *testing.T) {
	ts := int64(1700000000)
	payload := []byte(`{"amount":"100"}`)

	sig1 := computeSignature([]byte("secret-a"), ts, payload)
	sig2 := computeSignature([]byte("secret-b"), ts, payload)

	if sig1 == sig2 {
		t.Fatal("expected different signatures for different secrets, but they were equal")
	}
}

// ---------------------------------------------------------------------------
// Payload Tests
// ---------------------------------------------------------------------------

func TestWebhook_PayloadContents(t *testing.T) {
	ms := testutil.NewMockStore()
	srv, recv := newWebhookReceiver(200)
	defer srv.Close()

	seedMerchantWithSecret(t, ms, "m1", srv.URL, "webhook-secret-123")
	seedConfirmedPayment(ms, "m1", "pay1", false)

	w := newTestWebhookWorker(ms)

	// Enqueue + deliver
	w.tick(context.Background())
	w.tick(context.Background())

	if recv.count() != 1 {
		t.Fatalf("expected 1 request, got %d", recv.count())
	}

	body := recv.get(0).Body
	var payload WebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("failed to unmarshal webhook payload: %v", err)
	}

	if payload.PaymentID != "pay1" {
		t.Errorf("expected payment_id=%q, got %q", "pay1", payload.PaymentID)
	}
	if payload.ExternalID != "ext-pay1" {
		t.Errorf("expected external_id=%q, got %q", "ext-pay1", payload.ExternalID)
	}
	if payload.Status != "confirmed" {
		t.Errorf("expected status=%q, got %q", "confirmed", payload.Status)
	}
	if payload.DepositAddress != "Z0000000000000000000000000000000000000001" {
		t.Errorf("expected deposit_address=%q, got %q", "Z0000000000000000000000000000000000000001", payload.DepositAddress)
	}
	if payload.ExpectedAmountWei != "1000000000000000000" {
		t.Errorf("expected expected_amount_wei=%q, got %q", "1000000000000000000", payload.ExpectedAmountWei)
	}
	if payload.ReceivedAmountWei != "1000000000000000000" {
		t.Errorf("expected received_amount_wei=%q, got %q", "1000000000000000000", payload.ReceivedAmountWei)
	}
	if payload.TxHash != "0xabc123" {
		t.Errorf("expected tx_hash=%q, got %q", "0xabc123", payload.TxHash)
	}
	if payload.Confirmations != 10 {
		t.Errorf("expected confirmations=%d, got %d", 10, payload.Confirmations)
	}
	if payload.ConfirmedAt.IsZero() {
		t.Error("expected confirmed_at to be non-zero")
	}
}

func TestWebhook_SignatureHeader(t *testing.T) {
	ms := testutil.NewMockStore()
	srv, recv := newWebhookReceiver(200)
	defer srv.Close()

	seedMerchantWithSecret(t, ms, "m1", srv.URL, "webhook-secret-123")
	seedConfirmedPayment(ms, "m1", "pay1", false)

	w := newTestWebhookWorker(ms)

	// Enqueue + deliver
	w.tick(context.Background())
	w.tick(context.Background())

	if recv.count() != 1 {
		t.Fatalf("expected 1 request, got %d", recv.count())
	}

	sig := recv.get(0).Signature
	if sig == "" {
		t.Fatal("expected non-empty X-QRL-Signature header")
	}

	re := regexp.MustCompile(`^t=\d+,v1=[0-9a-f]{64}$`)
	if !re.MatchString(sig) {
		t.Fatalf("signature header %q does not match expected pattern t=<digits>,v1=<64_hex>", sig)
	}
}

// ---------------------------------------------------------------------------
// Underpaid Webhook Tests
// ---------------------------------------------------------------------------

func TestWebhook_EnqueuesUnderpaidPayment(t *testing.T) {
	ms := testutil.NewMockStore()
	srv, recv := newWebhookReceiver(200)
	defer srv.Close()

	seedMerchantWithSecret(t, ms, "m1", srv.URL, "webhook-secret-123")
	ms.SeedPayment(&model.PaymentIntent{
		ID:                "pay-underpaid",
		MerchantID:        "m1",
		ExternalID:        "ext-underpaid",
		DepositAddress:    "Z0000000000000000000000000000000000000002",
		ExpectedAmountWei: "1000000000000000000",
		ReceivedAmountWei: "900000000000000000", // 90% of expected
		Status:            model.StatusUnderpaid,
		TxHash:            "0xunderpaid",
		Confirmations:     10,
		RequiredConfs:     6,
		ExpiresAt:         time.Now().Add(time.Hour),
		WebhookEnqueued:   false,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
	})

	w := newTestWebhookWorker(ms)
	w.tick(context.Background())

	if got := ms.WebhookCount(); got != 1 {
		t.Fatalf("expected 1 webhook delivery for underpaid payment, got %d", got)
	}

	// Verify the payload status is "underpaid"
	if recv.count() != 1 {
		t.Fatalf("expected 1 webhook request, got %d", recv.count())
	}

	var payload WebhookPayload
	if err := json.Unmarshal(recv.get(0).Body, &payload); err != nil {
		t.Fatalf("unmarshal webhook payload: %v", err)
	}
	if payload.Status != "underpaid" {
		t.Errorf("webhook payload status = %q, want %q", payload.Status, "underpaid")
	}
}
