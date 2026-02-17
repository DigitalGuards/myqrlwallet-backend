package testutil

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/DigitalGuards/merchant-api/internal/model"
	"github.com/DigitalGuards/merchant-api/internal/store"
)

type poolEntry struct {
	Address   string
	Status    string // "available" or "assigned"
	PaymentID string
}

// MockStore is an in-memory implementation of store.Store for testing.
type MockStore struct {
	mu         sync.Mutex
	merchants  map[string]*model.Merchant // by ID
	apiKeyMap  map[string]*model.Merchant // by APIKeyHash
	pools      map[string][]poolEntry     // merchantID -> entries
	payments   map[string]*model.PaymentIntent
	extIDMap   map[string]string // "merchantID:externalID" -> paymentID
	state      map[string]string
	webhooks   map[string]*model.WebhookDelivery
	ErrorOn    map[string]error // method name -> forced error
	PingErr    error
}

func NewMockStore() *MockStore {
	return &MockStore{
		merchants: make(map[string]*model.Merchant),
		apiKeyMap: make(map[string]*model.Merchant),
		pools:     make(map[string][]poolEntry),
		payments:  make(map[string]*model.PaymentIntent),
		extIDMap:  make(map[string]string),
		state:     make(map[string]string),
		webhooks:  make(map[string]*model.WebhookDelivery),
		ErrorOn:   make(map[string]error),
	}
}

func (m *MockStore) err(method string) error {
	if e, ok := m.ErrorOn[method]; ok {
		return e
	}
	return nil
}

func (m *MockStore) Ping(_ context.Context) error {
	if m.PingErr != nil {
		return m.PingErr
	}
	return m.err("Ping")
}

func (m *MockStore) CreateMerchant(_ context.Context, merchant *model.Merchant) error {
	if e := m.err("CreateMerchant"); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.merchants[merchant.ID] = merchant
	m.apiKeyMap[merchant.APIKeyHash] = merchant
	return nil
}

func (m *MockStore) GetMerchantByAPIKeyHash(_ context.Context, hash string) (*model.Merchant, error) {
	if e := m.err("GetMerchantByAPIKeyHash"); e != nil {
		return nil, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.apiKeyMap[hash], nil
}

func (m *MockStore) GetMerchantByID(_ context.Context, id string) (*model.Merchant, error) {
	if e := m.err("GetMerchantByID"); e != nil {
		return nil, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.merchants[id], nil
}

func (m *MockStore) AddPoolAddresses(_ context.Context, merchantID string, addresses []string) (int, error) {
	if e := m.err("AddPoolAddresses"); e != nil {
		return 0, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	existing := make(map[string]bool)
	for _, e := range m.pools[merchantID] {
		existing[e.Address] = true
	}

	added := 0
	for _, addr := range addresses {
		if existing[addr] {
			continue
		}
		m.pools[merchantID] = append(m.pools[merchantID], poolEntry{Address: addr, Status: "available"})
		existing[addr] = true
		added++
	}
	return added, nil
}

func (m *MockStore) GetPoolStatus(_ context.Context, merchantID string) (int, int, error) {
	if e := m.err("GetPoolStatus"); e != nil {
		return 0, 0, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	var avail, assigned int
	for _, e := range m.pools[merchantID] {
		if e.Status == "available" {
			avail++
		} else {
			assigned++
		}
	}
	return avail, assigned, nil
}

func (m *MockStore) AssignAddressAndCreatePayment(_ context.Context, p *model.PaymentIntent) error {
	if e := m.err("AssignAddressAndCreatePayment"); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	entries := m.pools[p.MerchantID]
	for i, e := range entries {
		if e.Status == "available" {
			entries[i].Status = "assigned"
			entries[i].PaymentID = p.ID
			p.DepositAddress = e.Address
			m.pools[p.MerchantID] = entries
			m.payments[p.ID] = p
			m.extIDMap[p.MerchantID+":"+p.ExternalID] = p.ID
			return nil
		}
	}
	return store.ErrNoAvailableAddresses
}

func (m *MockStore) GetAssignedAddressMap(_ context.Context) (map[string]string, error) {
	if e := m.err("GetAssignedAddressMap"); e != nil {
		return nil, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	result := make(map[string]string)
	for _, entries := range m.pools {
		for _, e := range entries {
			if e.Status != "assigned" || e.PaymentID == "" {
				continue
			}
			p, ok := m.payments[e.PaymentID]
			if !ok {
				continue
			}
			if (p.Status == model.StatusPending || p.Status == model.StatusDetected) && p.TxHash == "" {
				result[e.Address] = e.PaymentID
			}
		}
	}
	return result, nil
}

func (m *MockStore) GetState(_ context.Context, key string) (string, error) {
	if e := m.err("GetState"); e != nil {
		return "", e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state[key], nil
}

func (m *MockStore) SetState(_ context.Context, key, value string) error {
	if e := m.err("SetState"); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state[key] = value
	return nil
}

func (m *MockStore) CreatePaymentIntent(_ context.Context, p *model.PaymentIntent) error {
	if e := m.err("CreatePaymentIntent"); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.payments[p.ID] = p
	m.extIDMap[p.MerchantID+":"+p.ExternalID] = p.ID
	return nil
}

func (m *MockStore) GetPaymentIntent(_ context.Context, id string) (*model.PaymentIntent, error) {
	if e := m.err("GetPaymentIntent"); e != nil {
		return nil, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.payments[id]
	if p == nil {
		return nil, nil
	}
	// Return a copy to avoid data races
	cp := *p
	return &cp, nil
}

func (m *MockStore) GetPaymentIntentByExternalID(_ context.Context, merchantID, externalID string) (*model.PaymentIntent, error) {
	if e := m.err("GetPaymentIntentByExternalID"); e != nil {
		return nil, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	pid, ok := m.extIDMap[merchantID+":"+externalID]
	if !ok {
		return nil, nil
	}
	p := m.payments[pid]
	if p == nil {
		return nil, nil
	}
	cp := *p
	return &cp, nil
}

func (m *MockStore) ListPendingPayments(_ context.Context) ([]model.PaymentIntent, error) {
	if e := m.err("ListPendingPayments"); e != nil {
		return nil, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	var result []model.PaymentIntent
	for _, p := range m.payments {
		if p.Status == model.StatusPending || p.Status == model.StatusDetected {
			result = append(result, *p)
		}
	}
	return result, nil
}

func (m *MockStore) SetPaymentTxHash(_ context.Context, id string, txHash string) error {
	if e := m.err("SetPaymentTxHash"); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.payments[id]; ok {
		p.TxHash = txHash
		p.UpdatedAt = time.Now().UTC()
	}
	return nil
}

func (m *MockStore) UpdatePaymentStatus(_ context.Context, id string, status model.PaymentStatus, txHash string, received string, confirmations int) error {
	if e := m.err("UpdatePaymentStatus"); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.payments[id]; ok {
		p.Status = status
		if txHash != "" {
			p.TxHash = txHash
		}
		p.ReceivedAmountWei = received
		p.Confirmations = confirmations
		p.UpdatedAt = time.Now().UTC()
	}
	return nil
}

func (m *MockStore) ExpireStalePayments(_ context.Context) (int64, error) {
	if e := m.err("ExpireStalePayments"); e != nil {
		return 0, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now().UTC()
	var count int64
	for _, p := range m.payments {
		if p.Status == model.StatusPending && p.ExpiresAt.Before(now) {
			p.Status = model.StatusExpired
			p.UpdatedAt = now
			count++
		}
	}
	return count, nil
}

func (m *MockStore) ListUndeliveredConfirmed(_ context.Context) ([]model.PaymentIntent, error) {
	if e := m.err("ListUndeliveredConfirmed"); e != nil {
		return nil, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	var result []model.PaymentIntent
	for _, p := range m.payments {
		if (p.Status == model.StatusConfirmed || p.Status == model.StatusUnderpaid) && !p.WebhookEnqueued {
			result = append(result, *p)
		}
	}
	return result, nil
}

func (m *MockStore) MarkWebhookEnqueued(_ context.Context, paymentID string) error {
	if e := m.err("MarkWebhookEnqueued"); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.payments[paymentID]; ok {
		p.WebhookEnqueued = true
		p.UpdatedAt = time.Now().UTC()
	}
	return nil
}

func (m *MockStore) CreateWebhookDelivery(_ context.Context, d *model.WebhookDelivery) error {
	if e := m.err("CreateWebhookDelivery"); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *d
	m.webhooks[d.ID] = &cp
	return nil
}

func (m *MockStore) ListPendingWebhooks(_ context.Context) ([]model.WebhookDelivery, error) {
	if e := m.err("ListPendingWebhooks"); e != nil {
		return nil, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	var result []model.WebhookDelivery
	for _, d := range m.webhooks {
		if d.DeliveredAt != nil {
			continue
		}
		if d.NextRetryAt != nil && d.NextRetryAt.After(now) {
			continue
		}
		result = append(result, *d)
	}
	return result, nil
}

func (m *MockStore) UpdateWebhookDelivery(_ context.Context, id string, statusCode int, delivered bool, nextRetry *string) error {
	if e := m.err("UpdateWebhookDelivery"); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.webhooks[id]
	if !ok {
		return nil
	}
	d.StatusCode = statusCode
	if delivered {
		now := time.Now().UTC()
		d.DeliveredAt = &now
	} else {
		d.Attempt++
		if nextRetry != nil {
			t, err := time.Parse(time.RFC3339, *nextRetry)
			if err != nil {
				panic(fmt.Sprintf("mock store: invalid time format for nextRetry: %v", err))
			}
			d.NextRetryAt = &t
		}
	}
	return nil
}

// SeedMerchant is a test helper to pre-populate a merchant.
func (m *MockStore) SeedMerchant(merchant *model.Merchant) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.merchants[merchant.ID] = merchant
	m.apiKeyMap[merchant.APIKeyHash] = merchant
}

// SeedPayment is a test helper to pre-populate a payment.
func (m *MockStore) SeedPayment(p *model.PaymentIntent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.payments[p.ID] = p
	m.extIDMap[p.MerchantID+":"+p.ExternalID] = p.ID
}

// GetWebhook returns a webhook delivery by ID for test assertions.
func (m *MockStore) GetWebhook(id string) *model.WebhookDelivery {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.webhooks[id]
}

// WebhookCount returns the number of webhook deliveries.
func (m *MockStore) WebhookCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.webhooks)
}

// GetPayment returns a payment by ID for test assertions.
func (m *MockStore) GetPayment(id string) *model.PaymentIntent {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.payments[id]
	if p == nil {
		return nil
	}
	cp := *p
	return &cp
}
