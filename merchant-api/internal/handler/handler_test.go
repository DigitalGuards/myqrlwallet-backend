package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalGuards/merchant-api/internal/crypto"
	"github.com/DigitalGuards/merchant-api/internal/model"
	"github.com/DigitalGuards/merchant-api/internal/testutil"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

func testMasterKey() [32]byte {
	var key [32]byte
	copy(key[:], []byte("test-master-key-exactly-32bytes!"))
	return key
}

func withMerchant(r *http.Request, m *model.Merchant) *http.Request {
	ctx := context.WithValue(r.Context(), merchantContextKey, m)
	return r.WithContext(ctx)
}

func testMerchant() *model.Merchant {
	return &model.Merchant{
		ID:       "merchant-1",
		Name:     "Test Merchant",
		IsActive: true,
	}
}

func jsonBody(v interface{}) *bytes.Reader {
	b, _ := json.Marshal(v)
	return bytes.NewReader(b)
}

func generateTestAddresses(t *testing.T, n int) []string {
	t.Helper()
	addrs := make([]string, n)
	for i := 0; i < n; i++ {
		w, err := crypto.GenerateWallet()
		if err != nil {
			t.Fatalf("generate wallet: %v", err)
		}
		addrs[i] = w.Address
	}
	return addrs
}

func decodeJSON(t *testing.T, body io.Reader, v interface{}) {
	t.Helper()
	if err := json.NewDecoder(body).Decode(v); err != nil {
		t.Fatalf("decode JSON response: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

func TestHealth_OK(t *testing.T) {
	ms := testutil.NewMockStore()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	HandleHealth(ms)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ok") {
		t.Fatalf("body should contain 'ok', got %s", rec.Body.String())
	}
}

func TestHealth_Unhealthy(t *testing.T) {
	ms := testutil.NewMockStore()
	ms.PingErr = errors.New("db down")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	HandleHealth(ms)(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// CreateMerchant
// ---------------------------------------------------------------------------

func TestCreateMerchant_Success(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreateMerchant(ms, testMasterKey())

	body := jsonBody(map[string]string{
		"name":        "test",
		"webhook_url": "https://example.com/hook",
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/merchants", body)

	handler(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp createMerchantResponse
	decodeJSON(t, rec.Body, &resp)

	if resp.MerchantID == "" {
		t.Fatal("merchant_id should not be empty")
	}
	if !strings.HasPrefix(resp.APIKey, "qrl_live_") {
		t.Fatalf("api_key should start with 'qrl_live_', got %s", resp.APIKey)
	}
	if !strings.HasPrefix(resp.WebhookSecret, "whsec_") {
		t.Fatalf("webhook_secret should start with 'whsec_', got %s", resp.WebhookSecret)
	}
}

func TestCreateMerchant_MissingFields(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreateMerchant(ms, testMasterKey())

	body := jsonBody(map[string]string{"name": "", "webhook_url": "https://example.com/hook"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/merchants", body)

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestCreateMerchant_HTTPWebhook(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreateMerchant(ms, testMasterKey())

	body := jsonBody(map[string]string{"name": "test", "webhook_url": "http://example.com/hook"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/merchants", body)

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for http webhook, got %d", rec.Code)
	}
}

func TestCreateMerchant_LocalhostWebhook(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreateMerchant(ms, testMasterKey())

	body := jsonBody(map[string]string{"name": "test", "webhook_url": "https://localhost/hook"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/merchants", body)

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for localhost webhook, got %d", rec.Code)
	}
}

func TestCreateMerchant_PrivateIPWebhook(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreateMerchant(ms, testMasterKey())

	body := jsonBody(map[string]string{"name": "test", "webhook_url": "https://192.168.1.1/hook"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/merchants", body)

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for private IP webhook, got %d", rec.Code)
	}
}

func TestCreateMerchant_InvalidJSON(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreateMerchant(ms, testMasterKey())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/merchants", strings.NewReader("{bad"))

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid JSON, got %d", rec.Code)
	}
}

func TestCreateMerchant_StoreError(t *testing.T) {
	ms := testutil.NewMockStore()
	ms.ErrorOn["CreateMerchant"] = errors.New("db error")
	handler := HandleCreateMerchant(ms, testMasterKey())

	body := jsonBody(map[string]string{"name": "test", "webhook_url": "https://example.com/hook"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/merchants", body)

	handler(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for store error, got %d", rec.Code)
	}
}

func TestCreateMerchant_WithUnderpaymentThreshold(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreateMerchant(ms, testMasterKey())

	body := jsonBody(map[string]interface{}{
		"name":                       "tolerant merchant",
		"webhook_url":                "https://example.com/hook",
		"underpayment_threshold_bps": 500,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/merchants", body)

	handler(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreateMerchant_ThresholdTooHigh(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreateMerchant(ms, testMasterKey())

	body := jsonBody(map[string]interface{}{
		"name":                       "greedy merchant",
		"webhook_url":                "https://example.com/hook",
		"underpayment_threshold_bps": 1500, // 15% — over the 10% max
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/merchants", body)

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for threshold > 1000, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreateMerchant_NegativeThreshold(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreateMerchant(ms, testMasterKey())

	body := jsonBody(map[string]interface{}{
		"name":                       "negative merchant",
		"webhook_url":                "https://example.com/hook",
		"underpayment_threshold_bps": -1,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/merchants", body)

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for negative threshold, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// AddAddresses
// ---------------------------------------------------------------------------

func TestAddAddresses_Success(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleAddAddresses(ms)
	addrs := generateTestAddresses(t, 3)

	body := jsonBody(map[string]interface{}{"addresses": addrs})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/addresses", body)
	req = withMerchant(req, testMerchant())

	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp addAddressesResponse
	decodeJSON(t, rec.Body, &resp)

	if resp.Added <= 0 {
		t.Fatalf("expected added > 0, got %d", resp.Added)
	}
}

func TestAddAddresses_EmptyArray(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleAddAddresses(ms)

	body := jsonBody(map[string]interface{}{"addresses": []string{}})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/addresses", body)
	req = withMerchant(req, testMerchant())

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty addresses, got %d", rec.Code)
	}
}

func TestAddAddresses_NoAuth(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleAddAddresses(ms)

	body := jsonBody(map[string]interface{}{"addresses": []string{"Qdeadbeef"}})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/addresses", body)
	// No withMerchant call — no merchant in context

	handler(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for no auth, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// CreatePayment
// ---------------------------------------------------------------------------

func TestCreatePayment_Success(t *testing.T) {
	ms := testutil.NewMockStore()
	merchant := testMerchant()
	addrs := generateTestAddresses(t, 2)
	ms.AddPoolAddresses(context.Background(), merchant.ID, addrs)

	handler := HandleCreatePayment(ms, 6, 30*time.Minute)

	body := jsonBody(map[string]string{
		"external_id": "order-123",
		"amount_wei":  "1000000000000000000",
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments", body)
	req = withMerchant(req, merchant)

	handler(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp model.PaymentIntent
	decodeJSON(t, rec.Body, &resp)

	if resp.DepositAddress == "" {
		t.Fatal("deposit_address should not be empty")
	}
	if resp.Status != model.StatusPending {
		t.Fatalf("expected status pending, got %s", resp.Status)
	}
}

func TestCreatePayment_MissingFields(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreatePayment(ms, 6, 30*time.Minute)

	body := jsonBody(map[string]string{
		"external_id": "order-123",
		// missing amount_wei
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments", body)
	req = withMerchant(req, testMerchant())

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing fields, got %d", rec.Code)
	}
}

func TestCreatePayment_InvalidAmount(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreatePayment(ms, 6, 30*time.Minute)

	body := jsonBody(map[string]string{
		"external_id": "order-123",
		"amount_wei":  "abc",
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments", body)
	req = withMerchant(req, testMerchant())

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid amount, got %d", rec.Code)
	}
}

func TestCreatePayment_ZeroAmount(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreatePayment(ms, 6, 30*time.Minute)

	body := jsonBody(map[string]string{
		"external_id": "order-123",
		"amount_wei":  "0",
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments", body)
	req = withMerchant(req, testMerchant())

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for zero amount, got %d", rec.Code)
	}
}

func TestCreatePayment_NegativeAmount(t *testing.T) {
	ms := testutil.NewMockStore()
	handler := HandleCreatePayment(ms, 6, 30*time.Minute)

	body := jsonBody(map[string]string{
		"external_id": "order-123",
		"amount_wei":  "-100",
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments", body)
	req = withMerchant(req, testMerchant())

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for negative amount, got %d", rec.Code)
	}
}

func TestCreatePayment_Idempotent(t *testing.T) {
	ms := testutil.NewMockStore()
	merchant := testMerchant()
	addrs := generateTestAddresses(t, 2)
	ms.AddPoolAddresses(context.Background(), merchant.ID, addrs)

	handler := HandleCreatePayment(ms, 6, 30*time.Minute)

	makeReq := func() *httptest.ResponseRecorder {
		body := jsonBody(map[string]string{
			"external_id": "order-dup",
			"amount_wei":  "5000",
		})
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/payments", body)
		req = withMerchant(req, merchant)
		handler(rec, req)
		return rec
	}

	rec1 := makeReq()
	if rec1.Code != http.StatusCreated {
		t.Fatalf("first call expected 201, got %d", rec1.Code)
	}

	rec2 := makeReq()
	if rec2.Code != http.StatusOK {
		t.Fatalf("second call expected 200 (idempotent), got %d", rec2.Code)
	}

	var p1, p2 model.PaymentIntent
	decodeJSON(t, rec1.Body, &p1)
	decodeJSON(t, rec2.Body, &p2)

	if p1.ID != p2.ID {
		t.Fatalf("idempotent calls should return same payment ID: %s vs %s", p1.ID, p2.ID)
	}
}

func TestCreatePayment_NoAddresses(t *testing.T) {
	ms := testutil.NewMockStore()
	// Do NOT add any pool addresses
	handler := HandleCreatePayment(ms, 6, 30*time.Minute)

	body := jsonBody(map[string]string{
		"external_id": "order-nope",
		"amount_wei":  "1000",
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments", body)
	req = withMerchant(req, testMerchant())

	handler(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for no addresses, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreatePayment_ConfsTooHigh(t *testing.T) {
	ms := testutil.NewMockStore()
	ms.AddPoolAddresses(context.Background(), testMerchant().ID, []string{"Qdeadbeef00000000000000000000000000000000"})
	handler := HandleCreatePayment(ms, 6, 30*time.Minute)

	body := jsonBody(map[string]interface{}{
		"external_id":            "order-highconfs",
		"amount_wei":             "1000",
		"required_confirmations": 1001,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments", body)
	req = withMerchant(req, testMerchant())

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for confs > 1000, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreatePayment_TTLTooHigh(t *testing.T) {
	ms := testutil.NewMockStore()
	ms.AddPoolAddresses(context.Background(), testMerchant().ID, []string{"Qdeadbeef00000000000000000000000000000000"})
	handler := HandleCreatePayment(ms, 6, 30*time.Minute)

	body := jsonBody(map[string]interface{}{
		"external_id": "order-highttl",
		"amount_wei":  "1000",
		"ttl_minutes": 20000,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments", body)
	req = withMerchant(req, testMerchant())

	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for ttl > 10080, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// GetPayment
// ---------------------------------------------------------------------------

func TestGetPayment_ByID(t *testing.T) {
	ms := testutil.NewMockStore()
	merchant := testMerchant()
	payment := &model.PaymentIntent{
		ID:                "pay-1",
		MerchantID:        merchant.ID,
		ExternalID:        "ext-1",
		DepositAddress:    "Qdeadbeef00000000000000000000000000000000",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "0",
		Status:            model.StatusPending,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
		ExpiresAt:         time.Now().Add(30 * time.Minute).UTC(),
	}
	ms.SeedPayment(payment)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/payments/{id}", HandleGetPayment(ms))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/payments/pay-1", nil)
	req = withMerchant(req, merchant)

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp model.PaymentIntent
	decodeJSON(t, rec.Body, &resp)
	if resp.ID != "pay-1" {
		t.Fatalf("expected payment ID pay-1, got %s", resp.ID)
	}
}

func TestGetPayment_ByExternalID(t *testing.T) {
	ms := testutil.NewMockStore()
	merchant := testMerchant()
	payment := &model.PaymentIntent{
		ID:                "pay-2",
		MerchantID:        merchant.ID,
		ExternalID:        "ext-2",
		DepositAddress:    "Qdeadbeef00000000000000000000000000000000",
		ExpectedAmountWei: "2000",
		ReceivedAmountWei: "0",
		Status:            model.StatusPending,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
		ExpiresAt:         time.Now().Add(30 * time.Minute).UTC(),
	}
	ms.SeedPayment(payment)

	handler := HandleGetPayment(ms)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/payments?external_id=ext-2", nil)
	req = withMerchant(req, merchant)

	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp model.PaymentIntent
	decodeJSON(t, rec.Body, &resp)
	if resp.ID != "pay-2" {
		t.Fatalf("expected payment ID pay-2, got %s", resp.ID)
	}
}

func TestGetPayment_NotFound(t *testing.T) {
	ms := testutil.NewMockStore()
	merchant := testMerchant()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/payments/{id}", HandleGetPayment(ms))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/payments/nonexistent", nil)
	req = withMerchant(req, merchant)

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestGetPayment_MerchantIsolation(t *testing.T) {
	ms := testutil.NewMockStore()
	// Payment belongs to merchant-2
	payment := &model.PaymentIntent{
		ID:                "pay-isolated",
		MerchantID:        "merchant-2",
		ExternalID:        "ext-iso",
		DepositAddress:    "Qdeadbeef00000000000000000000000000000000",
		ExpectedAmountWei: "3000",
		ReceivedAmountWei: "0",
		Status:            model.StatusPending,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
		ExpiresAt:         time.Now().Add(30 * time.Minute).UTC(),
	}
	ms.SeedPayment(payment)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/payments/{id}", HandleGetPayment(ms))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/payments/pay-isolated", nil)
	// Request as merchant-1 (not the owner)
	req = withMerchant(req, testMerchant())

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for merchant isolation, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// SubmitTxHash
// ---------------------------------------------------------------------------

func validTxHash() string {
	return "0x" + strings.Repeat("ab", 32)
}

func TestSubmitTxHash_PendingStatus(t *testing.T) {
	ms := testutil.NewMockStore()
	merchant := testMerchant()
	payment := &model.PaymentIntent{
		ID:                "pay-tx-1",
		MerchantID:        merchant.ID,
		ExternalID:        "ext-tx-1",
		DepositAddress:    "Qdeadbeef00000000000000000000000000000000",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "0",
		Status:            model.StatusPending,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
		ExpiresAt:         time.Now().Add(30 * time.Minute).UTC(),
	}
	ms.SeedPayment(payment)

	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /v1/payments/{id}/tx", HandleSubmitTxHash(ms))

	body := jsonBody(map[string]string{"tx_hash": validTxHash()})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/payments/pay-tx-1/tx", body)
	req = withMerchant(req, merchant)

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSubmitTxHash_DetectedStatus(t *testing.T) {
	ms := testutil.NewMockStore()
	merchant := testMerchant()
	payment := &model.PaymentIntent{
		ID:                "pay-tx-2",
		MerchantID:        merchant.ID,
		ExternalID:        "ext-tx-2",
		DepositAddress:    "Qdeadbeef00000000000000000000000000000000",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "0",
		Status:            model.StatusDetected,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
		ExpiresAt:         time.Now().Add(30 * time.Minute).UTC(),
	}
	ms.SeedPayment(payment)

	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /v1/payments/{id}/tx", HandleSubmitTxHash(ms))

	body := jsonBody(map[string]string{"tx_hash": validTxHash()})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/payments/pay-tx-2/tx", body)
	req = withMerchant(req, merchant)

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSubmitTxHash_InvalidHash(t *testing.T) {
	ms := testutil.NewMockStore()
	merchant := testMerchant()
	payment := &model.PaymentIntent{
		ID:                "pay-tx-3",
		MerchantID:        merchant.ID,
		ExternalID:        "ext-tx-3",
		DepositAddress:    "Qdeadbeef00000000000000000000000000000000",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "0",
		Status:            model.StatusPending,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
		ExpiresAt:         time.Now().Add(30 * time.Minute).UTC(),
	}
	ms.SeedPayment(payment)

	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /v1/payments/{id}/tx", HandleSubmitTxHash(ms))

	body := jsonBody(map[string]string{"tx_hash": "not-a-hash"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/payments/pay-tx-3/tx", body)
	req = withMerchant(req, merchant)

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid hash, got %d", rec.Code)
	}
}

func TestSubmitTxHash_AlreadyConfirmed(t *testing.T) {
	ms := testutil.NewMockStore()
	merchant := testMerchant()
	payment := &model.PaymentIntent{
		ID:                "pay-tx-4",
		MerchantID:        merchant.ID,
		ExternalID:        "ext-tx-4",
		DepositAddress:    "Qdeadbeef00000000000000000000000000000000",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "1000",
		Status:            model.StatusConfirmed,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
		ExpiresAt:         time.Now().Add(30 * time.Minute).UTC(),
	}
	ms.SeedPayment(payment)

	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /v1/payments/{id}/tx", HandleSubmitTxHash(ms))

	body := jsonBody(map[string]string{"tx_hash": validTxHash()})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/payments/pay-tx-4/tx", body)
	req = withMerchant(req, merchant)

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for already confirmed, got %d", rec.Code)
	}
}

func TestSubmitTxHash_WrongMerchant(t *testing.T) {
	ms := testutil.NewMockStore()
	// Payment belongs to merchant-2
	payment := &model.PaymentIntent{
		ID:                "pay-tx-5",
		MerchantID:        "merchant-2",
		ExternalID:        "ext-tx-5",
		DepositAddress:    "Qdeadbeef00000000000000000000000000000000",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "0",
		Status:            model.StatusPending,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
		ExpiresAt:         time.Now().Add(30 * time.Minute).UTC(),
	}
	ms.SeedPayment(payment)

	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /v1/payments/{id}/tx", HandleSubmitTxHash(ms))

	body := jsonBody(map[string]string{"tx_hash": validTxHash()})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/payments/pay-tx-5/tx", body)
	// merchant-1 tries to access merchant-2's payment
	req = withMerchant(req, testMerchant())

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for wrong merchant, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// Middleware: APIKeyAuth
// ---------------------------------------------------------------------------

func TestAPIKeyAuth_ValidKey(t *testing.T) {
	ms := testutil.NewMockStore()
	apiKey := "test-api-key-123"
	hash := hashAPIKey(apiKey)
	ms.SeedMerchant(&model.Merchant{ID: "m1", APIKeyHash: hash, IsActive: true})

	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m := MerchantFromContext(r.Context())
		if m == nil {
			t.Fatal("expected merchant in context")
		}
		if m.ID != "m1" {
			t.Fatalf("expected merchant ID m1, got %s", m.ID)
		}
		called = true
		w.WriteHeader(http.StatusOK)
	})

	handler := APIKeyAuth(ms)(inner)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", apiKey)

	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("inner handler was not called")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestAPIKeyAuth_MissingHeader(t *testing.T) {
	ms := testutil.NewMockStore()

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("inner handler should not be called")
	})

	handler := APIKeyAuth(ms)(inner)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	// No X-API-Key header

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestAPIKeyAuth_InvalidKey(t *testing.T) {
	ms := testutil.NewMockStore()
	// Seed a merchant with a different key
	ms.SeedMerchant(&model.Merchant{ID: "m1", APIKeyHash: hashAPIKey("correct-key"), IsActive: true})

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("inner handler should not be called")
	})

	handler := APIKeyAuth(ms)(inner)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", "wrong-key")

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// Middleware: AdminAuth
// ---------------------------------------------------------------------------

func TestAdminAuth_ValidKey(t *testing.T) {
	adminKey := "super-secret-admin-key"

	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	handler := AdminAuth(adminKey)(inner)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", adminKey)

	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("inner handler was not called")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestAdminAuth_WrongKey(t *testing.T) {
	adminKey := "super-secret-admin-key"

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("inner handler should not be called")
	})

	handler := AdminAuth(adminKey)(inner)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", "wrong-admin-key")

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// Middleware: Recovery
// ---------------------------------------------------------------------------

func TestRecovery_PanicRecovery(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("test panic")
	})

	handler := Recovery(inner)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)

	// Should not crash
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 after panic, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

func TestRateLimiter_AllowsUpToBurst(t *testing.T) {
	rl := NewRateLimiter(10, 5)
	defer rl.Stop()

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := rl.Limit(inner)

	for i := 0; i < 5; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("X-API-Key", "rate-test-key")

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: expected 200, got %d", i+1, rec.Code)
		}
	}
}

func TestRateLimiter_BlocksAfterBurst(t *testing.T) {
	rl := NewRateLimiter(10, 5)
	defer rl.Stop()

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := rl.Limit(inner)

	// Consume all 5 burst tokens
	for i := 0; i < 5; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("X-API-Key", "burst-test-key")
		handler.ServeHTTP(rec, req)
	}

	// 6th request should be rate-limited
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", "burst-test-key")
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after burst, got %d", rec.Code)
	}
}

func TestRateLimiter_DifferentKeysIndependent(t *testing.T) {
	rl := NewRateLimiter(10, 2)
	defer rl.Stop()

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := rl.Limit(inner)

	// Exhaust burst for key-A
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("X-API-Key", "key-A")
		handler.ServeHTTP(rec, req)
	}

	// key-A is now rate-limited
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", "key-A")
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("key-A should be rate-limited, got %d", rec.Code)
	}

	// key-B should still work
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", "key-B")
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("key-B should not be rate-limited, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// Router Integration: Full Payment Flow
// ---------------------------------------------------------------------------

func TestRouter_FullPaymentFlow(t *testing.T) {
	ms := testutil.NewMockStore()
	adminKey := "test-admin-key-for-flow"
	masterKey := testMasterKey()

	router := NewRouter(ms, adminKey, masterKey, 6, 30*time.Minute, 1000, 1000)
	srv := httptest.NewServer(router)
	defer srv.Close()

	client := srv.Client()

	// Step 1: Create merchant via POST /v1/merchants with admin key
	createBody := jsonBody(map[string]string{
		"name":        "Flow Test Merchant",
		"webhook_url": "https://example.com/webhook",
	})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/merchants", createBody)
	req.Header.Set("X-API-Key", adminKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("create merchant request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("create merchant: expected 201, got %d: %s", resp.StatusCode, string(body))
	}

	var merchantResp createMerchantResponse
	decodeJSON(t, resp.Body, &merchantResp)
	apiKey := merchantResp.APIKey
	merchantID := merchantResp.MerchantID

	if apiKey == "" || merchantID == "" {
		t.Fatal("api_key and merchant_id must not be empty")
	}

	// Step 2: Generate valid addresses and upload via POST /v1/addresses
	addrs := generateTestAddresses(t, 3)
	addrBody := jsonBody(map[string]interface{}{"addresses": addrs})
	req, _ = http.NewRequest(http.MethodPost, srv.URL+"/v1/addresses", addrBody)
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("add addresses request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("add addresses: expected 200, got %d: %s", resp.StatusCode, string(body))
	}

	var addrResp addAddressesResponse
	decodeJSON(t, resp.Body, &addrResp)
	if addrResp.Added != 3 {
		t.Fatalf("expected 3 addresses added, got %d", addrResp.Added)
	}

	// Step 3: Create payment via POST /v1/payments
	payBody := jsonBody(map[string]string{
		"external_id": "flow-order-1",
		"amount_wei":  "1000000000000000000",
	})
	req, _ = http.NewRequest(http.MethodPost, srv.URL+"/v1/payments", payBody)
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("create payment request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("create payment: expected 201, got %d: %s", resp.StatusCode, string(body))
	}

	var paymentResp model.PaymentIntent
	decodeJSON(t, resp.Body, &paymentResp)

	if paymentResp.ID == "" {
		t.Fatal("payment ID must not be empty")
	}
	if paymentResp.DepositAddress == "" {
		t.Fatal("deposit_address must not be empty")
	}
	if paymentResp.Status != model.StatusPending {
		t.Fatalf("expected pending status, got %s", paymentResp.Status)
	}

	paymentID := paymentResp.ID

	// Step 4: Get payment via GET /v1/payments/{id}
	req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/payments/%s", srv.URL, paymentID), nil)
	req.Header.Set("X-API-Key", apiKey)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("get payment request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("get payment: expected 200, got %d: %s", resp.StatusCode, string(body))
	}

	var getResp model.PaymentIntent
	decodeJSON(t, resp.Body, &getResp)
	if getResp.ID != paymentID {
		t.Fatalf("expected payment ID %s, got %s", paymentID, getResp.ID)
	}

	// Step 5: Submit tx hash via PATCH /v1/payments/{id}/tx
	txHash := validTxHash()
	txBody := jsonBody(map[string]string{"tx_hash": txHash})
	req, _ = http.NewRequest(http.MethodPatch, fmt.Sprintf("%s/v1/payments/%s/tx", srv.URL, paymentID), txBody)
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("submit tx hash request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("submit tx hash: expected 200, got %d: %s", resp.StatusCode, string(body))
	}

	var txResp model.PaymentIntent
	decodeJSON(t, resp.Body, &txResp)
	if txResp.TxHash != txHash {
		t.Fatalf("expected tx_hash %s, got %s", txHash, txResp.TxHash)
	}
}
