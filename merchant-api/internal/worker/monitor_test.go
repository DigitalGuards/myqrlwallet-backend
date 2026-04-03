package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalGuards/merchant-api/internal/model"
	"github.com/DigitalGuards/merchant-api/internal/rpc"
	"github.com/DigitalGuards/merchant-api/internal/testutil"
	"github.com/DigitalGuards/merchant-api/internal/zondscan"
)

// ---------------------------------------------------------------------------
// Fake RPC server
// ---------------------------------------------------------------------------

type fakeRPCState struct {
	mu          sync.Mutex
	blockNumber uint64
	balances    map[string]*big.Int    // Q-prefix address -> balance
	receipts    map[string]interface{} // txHash -> *rpc.TxReceipt or nil
}

func rpcHandler(state *fakeRPCState) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
			ID     int               `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		state.mu.Lock()
		defer state.mu.Unlock()

		var result interface{}

		switch req.Method {
		case "qrl_blockNumber":
			result = fmt.Sprintf("0x%x", state.blockNumber)

		case "qrl_getBalance":
			var addr string
			if len(req.Params) > 0 {
				json.Unmarshal(req.Params[0], &addr)
			}
			bal, ok := state.balances[addr]
			if !ok || bal == nil {
				result = "0x0"
			} else {
				result = "0x" + bal.Text(16)
			}

		case "qrl_getTransactionReceipt":
			var txHash string
			if len(req.Params) > 0 {
				json.Unmarshal(req.Params[0], &txHash)
			}
			rcpt, ok := state.receipts[txHash]
			if !ok || rcpt == nil {
				// Return JSON-RPC null result
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]interface{}{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"result":  nil,
				})
				return
			}
			result = rcpt

		default:
			http.Error(w, "unknown method: "+req.Method, http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      req.ID,
			"result":  result,
		})
	})
}

// ---------------------------------------------------------------------------
// Fake Zondscan server
// ---------------------------------------------------------------------------

type fakeZondscanState struct {
	mu          sync.Mutex
	latestBlock uint64
	blocks      map[uint64]interface{} // blockNum -> block JSON-serialisable response
}

// zondscanBlockResponse mirrors the shape the real client expects.
type zondscanBlockResponse struct {
	Block struct {
		Result struct {
			Number       string                  `json:"number"`
			Transactions []zondscan.Transaction  `json:"transactions"`
		} `json:"result"`
	} `json:"block"`
}

func zondscanHandler(state *fakeZondscanState) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state.mu.Lock()
		defer state.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")

		path := r.URL.Path

		if path == "/latestblock" {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"latestBlock": int64(state.latestBlock),
			})
			return
		}

		if strings.HasPrefix(path, "/block/") {
			numStr := strings.TrimPrefix(path, "/block/")
			num, err := strconv.ParseUint(numStr, 10, 64)
			if err != nil {
				http.Error(w, "bad block number", http.StatusBadRequest)
				return
			}
			blk, ok := state.blocks[num]
			if !ok {
				// Return an empty block
				resp := zondscanBlockResponse{}
				resp.Block.Result.Number = fmt.Sprintf("0x%x", num)
				resp.Block.Result.Transactions = []zondscan.Transaction{}
				json.NewEncoder(w).Encode(resp)
				return
			}
			json.NewEncoder(w).Encode(blk)
			return
		}

		http.NotFound(w, r)
	})
}

// makeZondscanBlock builds a fake zondscan block response for the test server.
func makeZondscanBlock(number uint64, txs []zondscan.Transaction) zondscanBlockResponse {
	resp := zondscanBlockResponse{}
	resp.Block.Result.Number = fmt.Sprintf("0x%x", number)
	resp.Block.Result.Transactions = txs
	return resp
}

// ---------------------------------------------------------------------------
// Test helper: create Monitor wired to fake servers
// ---------------------------------------------------------------------------

func newTestMonitor(t *testing.T, ms *testutil.MockStore) (*Monitor, *fakeRPCState, *fakeZondscanState) {
	t.Helper()

	rpcState := &fakeRPCState{
		balances: make(map[string]*big.Int),
		receipts: make(map[string]interface{}),
	}
	rpcSrv := httptest.NewServer(rpcHandler(rpcState))
	t.Cleanup(rpcSrv.Close)

	zsState := &fakeZondscanState{
		blocks: make(map[uint64]interface{}),
	}
	zsSrv := httptest.NewServer(zondscanHandler(zsState))
	t.Cleanup(zsSrv.Close)

	rpcClient := rpc.NewClient(rpcSrv.URL, 5*time.Second)
	zsClient := zondscan.NewClient(zsSrv.URL, 5*time.Second)

	return NewMonitor(ms, rpcClient, zsClient, time.Second), rpcState, zsState
}

// seedPaymentWithPool seeds a payment AND creates a matching pool entry so
// GetAssignedAddressMap can find it when needed.
func seedPaymentWithPool(t *testing.T, ms *testutil.MockStore, p *model.PaymentIntent) {
	t.Helper()
	ctx := context.Background()

	// Add the address to the pool, then assign it via the standard path.
	if _, err := ms.AddPoolAddresses(ctx, p.MerchantID, []string{p.DepositAddress}); err != nil {
		t.Fatalf("add pool address: %v", err)
	}

	// Create a temporary payment to trigger the assignment.
	assigned := &model.PaymentIntent{
		ID:                p.ID,
		MerchantID:        p.MerchantID,
		ExternalID:        p.ExternalID,
		ExpectedAmountWei: p.ExpectedAmountWei,
		RequiredConfs:     p.RequiredConfs,
		ExpiresAt:         p.ExpiresAt,
		CreatedAt:         p.CreatedAt,
		UpdatedAt:         p.UpdatedAt,
		Status:            p.Status,
		TxHash:            p.TxHash,
		ReceivedAmountWei: p.ReceivedAmountWei,
		Confirmations:     p.Confirmations,
	}
	if err := ms.AssignAddressAndCreatePayment(ctx, assigned); err != nil {
		t.Fatalf("assign address: %v", err)
	}
	// The mock assigns the first available address, which is the one we just added.
	if assigned.DepositAddress != p.DepositAddress {
		t.Fatalf("unexpected assigned address: got %q, want %q", assigned.DepositAddress, p.DepositAddress)
	}
}

// ---------------------------------------------------------------------------
// Deposit Detection Tests
// ---------------------------------------------------------------------------

func TestMonitor_DetectsDeposit(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	// Seed a pending payment with a known deposit address.
	p := &model.PaymentIntent{
		ID:                "pay1",
		MerchantID:        "m1",
		ExternalID:        "ext1",
		DepositAddress:    "Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ExpectedAmountWei: "1000",
		Status:            model.StatusPending,
		RequiredConfs:     3,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	ms.SeedPayment(p)

	// Balance keyed by Q-prefix address (v2 RPC uses Q-prefix directly).
	rpcState.mu.Lock()
	rpcState.balances["Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] = big.NewInt(1000)
	rpcState.blockNumber = 50
	rpcState.mu.Unlock()

	// Make scanBlocks a no-op by setting lastScannedBlock = latestBlock.
	zsState.mu.Lock()
	zsState.latestBlock = 50
	zsState.mu.Unlock()
	ms.SetState(ctx, "last_scanned_block", "50")

	mon.tick(ctx)

	got := ms.GetPayment("pay1")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.Status != model.StatusDetected {
		t.Errorf("status = %q, want %q", got.Status, model.StatusDetected)
	}
	if got.ReceivedAmountWei != "1000" {
		t.Errorf("ReceivedAmountWei = %q, want %q", got.ReceivedAmountWei, "1000")
	}
}

func TestMonitor_IgnoresZeroBalance(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	p := &model.PaymentIntent{
		ID:                "pay2",
		MerchantID:        "m1",
		ExternalID:        "ext2",
		DepositAddress:    "Qbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		ExpectedAmountWei: "1000",
		Status:            model.StatusPending,
		RequiredConfs:     3,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	ms.SeedPayment(p)

	// Zero balance (default map miss returns 0x0).
	rpcState.mu.Lock()
	rpcState.blockNumber = 50
	rpcState.mu.Unlock()

	zsState.mu.Lock()
	zsState.latestBlock = 50
	zsState.mu.Unlock()
	ms.SetState(ctx, "last_scanned_block", "50")

	mon.tick(ctx)

	got := ms.GetPayment("pay2")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.Status != model.StatusPending {
		t.Errorf("status = %q, want %q", got.Status, model.StatusPending)
	}
}

// ---------------------------------------------------------------------------
// Confirmation Tracking Tests
// ---------------------------------------------------------------------------

func TestMonitor_ConfirmsPayment(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	p := &model.PaymentIntent{
		ID:                "pay3",
		MerchantID:        "m1",
		ExternalID:        "ext3",
		DepositAddress:    "Qcccccccccccccccccccccccccccccccccccccccc",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "1000",
		Status:            model.StatusDetected,
		TxHash:            "0xdeadbeef",
		RequiredConfs:     3,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	ms.SeedPayment(p)

	// Receipt in block 10, current block 15 => 5 confirmations (>= 3 required).
	rpcState.mu.Lock()
	rpcState.blockNumber = 15
	rpcState.receipts["0xdeadbeef"] = &rpc.TxReceipt{
		TransactionHash: "0xdeadbeef",
		BlockNumber:     "0xa", // 10
		Status:          "0x1",
		From:            "Qsender",
		To:              "Qcccccccccccccccccccccccccccccccccccccccc",
	}
	rpcState.mu.Unlock()

	zsState.mu.Lock()
	zsState.latestBlock = 15
	zsState.mu.Unlock()
	ms.SetState(ctx, "last_scanned_block", "15")

	mon.tick(ctx)

	got := ms.GetPayment("pay3")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.Status != model.StatusConfirmed {
		t.Errorf("status = %q, want %q", got.Status, model.StatusConfirmed)
	}
	if got.Confirmations < 3 {
		t.Errorf("confirmations = %d, want >= 3", got.Confirmations)
	}
}

func TestMonitor_UnderpaidStaysDetected(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	p := &model.PaymentIntent{
		ID:                "pay4",
		MerchantID:        "m1",
		ExternalID:        "ext4",
		DepositAddress:    "Qdddddddddddddddddddddddddddddddddddddd",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "500", // Underpaid
		Status:            model.StatusDetected,
		TxHash:            "0xbadcafe",
		RequiredConfs:     3,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	ms.SeedPayment(p)

	rpcState.mu.Lock()
	rpcState.blockNumber = 20
	rpcState.receipts["0xbadcafe"] = &rpc.TxReceipt{
		TransactionHash: "0xbadcafe",
		BlockNumber:     "0xa", // block 10, so 10 confirmations — more than enough
		Status:          "0x1",
		From:            "Qsender",
		To:              "Qdddddddddddddddddddddddddddddddddddddd",
	}
	rpcState.mu.Unlock()

	zsState.mu.Lock()
	zsState.latestBlock = 20
	zsState.mu.Unlock()
	ms.SetState(ctx, "last_scanned_block", "20")

	mon.tick(ctx)

	got := ms.GetPayment("pay4")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.Status != model.StatusUnderpaid {
		t.Errorf("status = %q, want %q (underpaid should move to underpaid status)", got.Status, model.StatusUnderpaid)
	}
}

func TestMonitor_UnderpaidWithinThresholdAutoConfirms(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	// Merchant with 5% (500 bps) underpayment tolerance
	ms.SeedMerchant(&model.Merchant{
		ID:                       "m-threshold",
		Name:                     "Tolerant Merchant",
		UnderpaymentThresholdBPS: 500, // 5%
	})

	p := &model.PaymentIntent{
		ID:                "pay-within",
		MerchantID:        "m-threshold",
		ExternalID:        "ext-within",
		DepositAddress:    "Qwithin1111111111111111111111111111111111",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "960", // 4% short — within 5% threshold
		Status:            model.StatusDetected,
		TxHash:            "0xwithin",
		RequiredConfs:     1,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	ms.SeedPayment(p)

	rpcState.mu.Lock()
	rpcState.blockNumber = 20
	rpcState.receipts["0xwithin"] = &rpc.TxReceipt{
		TransactionHash: "0xwithin",
		BlockNumber:     "0xa",
		Status:          "0x1",
		From:            "Qsender",
		To:              "Qwithin",
	}
	rpcState.mu.Unlock()

	zsState.mu.Lock()
	zsState.latestBlock = 20
	zsState.mu.Unlock()
	ms.SetState(ctx, "last_scanned_block", "20")

	mon.tick(ctx)

	got := ms.GetPayment("pay-within")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.Status != model.StatusConfirmed {
		t.Errorf("status = %q, want %q (underpaid within threshold should auto-confirm)", got.Status, model.StatusConfirmed)
	}
}

func TestMonitor_UnderpaidBeyondThresholdMarksUnderpaid(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	// Merchant with 2% (200 bps) underpayment tolerance
	ms.SeedMerchant(&model.Merchant{
		ID:                       "m-strict",
		Name:                     "Strict Merchant",
		UnderpaymentThresholdBPS: 200, // 2%
	})

	p := &model.PaymentIntent{
		ID:                "pay-beyond",
		MerchantID:        "m-strict",
		ExternalID:        "ext-beyond",
		DepositAddress:    "Qbeyond1111111111111111111111111111111111",
		ExpectedAmountWei: "10000",
		ReceivedAmountWei: "9500", // 5% short — beyond 2% threshold
		Status:            model.StatusDetected,
		TxHash:            "0xbeyond",
		RequiredConfs:     1,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	ms.SeedPayment(p)

	rpcState.mu.Lock()
	rpcState.blockNumber = 20
	rpcState.receipts["0xbeyond"] = &rpc.TxReceipt{
		TransactionHash: "0xbeyond",
		BlockNumber:     "0xa",
		Status:          "0x1",
		From:            "Qsender",
		To:              "Qbeyond",
	}
	rpcState.mu.Unlock()

	zsState.mu.Lock()
	zsState.latestBlock = 20
	zsState.mu.Unlock()
	ms.SetState(ctx, "last_scanned_block", "20")

	mon.tick(ctx)

	got := ms.GetPayment("pay-beyond")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.Status != model.StatusUnderpaid {
		t.Errorf("status = %q, want %q (underpaid beyond threshold should not auto-confirm)", got.Status, model.StatusUnderpaid)
	}
}

func TestMonitor_UnderpaidExactlyAtThresholdAutoConfirms(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	// Merchant with 5% (500 bps) tolerance
	ms.SeedMerchant(&model.Merchant{
		ID:                       "m-exact",
		Name:                     "Exact Merchant",
		UnderpaymentThresholdBPS: 500,
	})

	p := &model.PaymentIntent{
		ID:                "pay-exact",
		MerchantID:        "m-exact",
		ExternalID:        "ext-exact",
		DepositAddress:    "Qexact11111111111111111111111111111111111",
		ExpectedAmountWei: "10000",
		ReceivedAmountWei: "9500", // Exactly 5% short — at boundary
		Status:            model.StatusDetected,
		TxHash:            "0xexact",
		RequiredConfs:     1,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	ms.SeedPayment(p)

	rpcState.mu.Lock()
	rpcState.blockNumber = 20
	rpcState.receipts["0xexact"] = &rpc.TxReceipt{
		TransactionHash: "0xexact",
		BlockNumber:     "0xa",
		Status:          "0x1",
		From:            "Qsender",
		To:              "Qexact",
	}
	rpcState.mu.Unlock()

	zsState.mu.Lock()
	zsState.latestBlock = 20
	zsState.mu.Unlock()
	ms.SetState(ctx, "last_scanned_block", "20")

	mon.tick(ctx)

	got := ms.GetPayment("pay-exact")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.Status != model.StatusConfirmed {
		t.Errorf("status = %q, want %q (shortfall exactly at threshold should auto-confirm)", got.Status, model.StatusConfirmed)
	}
}

func TestMonitor_ReceiptNotMined(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	p := &model.PaymentIntent{
		ID:                "pay5",
		MerchantID:        "m1",
		ExternalID:        "ext5",
		DepositAddress:    "Qeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "1000",
		Status:            model.StatusDetected,
		TxHash:            "0xpending",
		RequiredConfs:     3,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	ms.SeedPayment(p)

	// No receipt registered => returns null
	rpcState.mu.Lock()
	rpcState.blockNumber = 50
	rpcState.mu.Unlock()

	zsState.mu.Lock()
	zsState.latestBlock = 50
	zsState.mu.Unlock()
	ms.SetState(ctx, "last_scanned_block", "50")

	mon.tick(ctx)

	got := ms.GetPayment("pay5")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	// Status should remain detected — no state change when receipt is nil.
	if got.Status != model.StatusDetected {
		t.Errorf("status = %q, want %q", got.Status, model.StatusDetected)
	}
	// Confirmations should not have been updated.
	if got.Confirmations != 0 {
		t.Errorf("confirmations = %d, want 0", got.Confirmations)
	}
}

func TestMonitor_NoTxHashReChecksBalance(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	p := &model.PaymentIntent{
		ID:                "pay6",
		MerchantID:        "m1",
		ExternalID:        "ext6",
		DepositAddress:    "Qfffffffffffffffffffffffffffffffffffffffr",
		ExpectedAmountWei: "1000",
		ReceivedAmountWei: "1000",
		Status:            model.StatusDetected,
		TxHash:            "", // No tx hash yet
		RequiredConfs:     3,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	ms.SeedPayment(p)

	// Balance is 2000 — should update ReceivedAmountWei but stay detected.
	rpcState.mu.Lock()
	rpcState.balances["Qfffffffffffffffffffffffffffffffffffffffr"] = big.NewInt(2000)
	rpcState.blockNumber = 50
	rpcState.mu.Unlock()

	zsState.mu.Lock()
	zsState.latestBlock = 50
	zsState.mu.Unlock()
	ms.SetState(ctx, "last_scanned_block", "50")

	mon.tick(ctx)

	got := ms.GetPayment("pay6")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.Status != model.StatusDetected {
		t.Errorf("status = %q, want %q", got.Status, model.StatusDetected)
	}
	if got.ReceivedAmountWei != "2000" {
		t.Errorf("ReceivedAmountWei = %q, want %q", got.ReceivedAmountWei, "2000")
	}
}

// ---------------------------------------------------------------------------
// Block Scanning Tests
// ---------------------------------------------------------------------------

func TestMonitor_ScanBlocks_FirstRun(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	// No last_scanned_block state set => first run.
	zsState.mu.Lock()
	zsState.latestBlock = 100
	zsState.mu.Unlock()

	rpcState.mu.Lock()
	rpcState.blockNumber = 100
	rpcState.mu.Unlock()

	mon.tick(ctx)

	val, err := ms.GetState(ctx, "last_scanned_block")
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if val != "100" {
		t.Errorf("last_scanned_block = %q, want %q", val, "100")
	}
}

func TestMonitor_ScanBlocks_DetectsTx(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	// Create a pending payment with an assigned pool address.
	p := &model.PaymentIntent{
		ID:                "pay7",
		MerchantID:        "m1",
		ExternalID:        "ext7",
		DepositAddress:    "Qaaaa11111111111111111111111111111111111a",
		ExpectedAmountWei: "5000",
		Status:            model.StatusPending,
		RequiredConfs:     3,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	// Seed via pool so GetAssignedAddressMap works.
	seedPaymentWithPool(t, ms, p)

	// Set up block scan state: lastScanned=99, latestBlock=100.
	ms.SetState(ctx, "last_scanned_block", "99")

	zsState.mu.Lock()
	zsState.latestBlock = 100
	// Block 100 has a tx to our address (Q-prefix address).
	zsState.blocks[100] = makeZondscanBlock(100, []zondscan.Transaction{
		{
			Hash:   "0xabc123def456",
			From:   "Qsender000000000000000000000000000000000",
			To:     "Qaaaa11111111111111111111111111111111111a", // Q-prefix of our address
			Value:  "5000",
			Status: "0x1",
		},
	})
	zsState.mu.Unlock()

	rpcState.mu.Lock()
	rpcState.blockNumber = 100
	// Set a non-zero balance so checkPendingPayment also detects it.
	rpcState.balances["Qaaaa11111111111111111111111111111111111a"] = big.NewInt(5000)
	rpcState.mu.Unlock()

	mon.tick(ctx)

	got := ms.GetPayment("pay7")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.TxHash != "0xabc123def456" {
		t.Errorf("TxHash = %q, want %q", got.TxHash, "0xabc123def456")
	}

	// Verify cursor advanced.
	val, _ := ms.GetState(ctx, "last_scanned_block")
	if val != "100" {
		t.Errorf("last_scanned_block = %q, want %q", val, "100")
	}
}

func TestMonitor_ScanBlocks_SkipsFailedTx(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	p := &model.PaymentIntent{
		ID:                "pay8",
		MerchantID:        "m1",
		ExternalID:        "ext8",
		DepositAddress:    "Qbbbb22222222222222222222222222222222222b",
		ExpectedAmountWei: "5000",
		Status:            model.StatusPending,
		RequiredConfs:     3,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	seedPaymentWithPool(t, ms, p)

	ms.SetState(ctx, "last_scanned_block", "99")

	zsState.mu.Lock()
	zsState.latestBlock = 100
	zsState.blocks[100] = makeZondscanBlock(100, []zondscan.Transaction{
		{
			Hash:   "0xfailedtx",
			From:   "Qsender000000000000000000000000000000000",
			To:     "Qbbbb22222222222222222222222222222222222b",
			Value:  "5000",
			Status: "0x0", // Failed transaction
		},
	})
	zsState.mu.Unlock()

	rpcState.mu.Lock()
	rpcState.blockNumber = 100
	rpcState.mu.Unlock()

	mon.tick(ctx)

	got := ms.GetPayment("pay8")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.TxHash != "" {
		t.Errorf("TxHash = %q, want empty (failed tx should be skipped)", got.TxHash)
	}
}

func TestMonitor_ScanBlocks_MaxBlocksPerTick(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	// Need at least one assigned address so scanBlocks doesn't short-circuit.
	p := &model.PaymentIntent{
		ID:                "pay9",
		MerchantID:        "m1",
		ExternalID:        "ext9",
		DepositAddress:    "Qcccc33333333333333333333333333333333333c",
		ExpectedAmountWei: "1000",
		Status:            model.StatusPending,
		RequiredConfs:     3,
		ExpiresAt:         time.Now().Add(time.Hour),
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	seedPaymentWithPool(t, ms, p)

	ms.SetState(ctx, "last_scanned_block", "0")

	zsState.mu.Lock()
	zsState.latestBlock = 20
	zsState.mu.Unlock()

	rpcState.mu.Lock()
	rpcState.blockNumber = 20
	rpcState.mu.Unlock()

	mon.tick(ctx)

	val, _ := ms.GetState(ctx, "last_scanned_block")
	// maxBlocksPerTick=10, so from 0 we scan blocks 1..10 => lastScanned=10.
	if val != "10" {
		t.Errorf("last_scanned_block = %q, want %q (maxBlocksPerTick=10)", val, "10")
	}
}

// ---------------------------------------------------------------------------
// Expiry Tests
// ---------------------------------------------------------------------------

func TestMonitor_ExpiresStalePayments(t *testing.T) {
	ms := testutil.NewMockStore()
	mon, rpcState, zsState := newTestMonitor(t, ms)
	ctx := context.Background()

	p := &model.PaymentIntent{
		ID:                "pay10",
		MerchantID:        "m1",
		ExternalID:        "ext10",
		DepositAddress:    "Qdddd44444444444444444444444444444444444d",
		ExpectedAmountWei: "1000",
		Status:            model.StatusPending,
		RequiredConfs:     3,
		ExpiresAt:         time.Now().Add(-time.Hour), // Already expired
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}
	ms.SeedPayment(p)

	rpcState.mu.Lock()
	rpcState.blockNumber = 50
	rpcState.mu.Unlock()

	zsState.mu.Lock()
	zsState.latestBlock = 50
	zsState.mu.Unlock()
	ms.SetState(ctx, "last_scanned_block", "50")

	mon.tick(ctx)

	got := ms.GetPayment("pay10")
	if got == nil {
		t.Fatal("payment not found after tick")
	}
	if got.Status != model.StatusExpired {
		t.Errorf("status = %q, want %q", got.Status, model.StatusExpired)
	}
}
