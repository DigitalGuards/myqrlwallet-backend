package worker

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/DigitalGuards/merchant-api/internal/address"
	"github.com/DigitalGuards/merchant-api/internal/model"
	"github.com/DigitalGuards/merchant-api/internal/rpc"
	"github.com/DigitalGuards/merchant-api/internal/store"
	"github.com/DigitalGuards/merchant-api/internal/zondscan"
)

const lastScannedBlockKey = "last_scanned_block"

// Monitor polls the Zond blockchain for deposits to pending payment addresses.
type Monitor struct {
	store    store.Store
	rpc      *rpc.Client
	zondscan *zondscan.Client
	interval time.Duration
}

// NewMonitor creates a new on-chain monitor.
func NewMonitor(s store.Store, rpc *rpc.Client, zs *zondscan.Client, interval time.Duration) *Monitor {
	return &Monitor{
		store:    s,
		rpc:      rpc,
		zondscan: zs,
		interval: interval,
	}
}

// Run starts the monitor loop. Blocks until ctx is cancelled.
func (m *Monitor) Run(ctx context.Context) {
	log.Printf("monitor: starting (interval=%s)", m.interval)
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("monitor: shutting down")
			return
		case <-ticker.C:
			m.tick(ctx)
		}
	}
}

func (m *Monitor) tick(ctx context.Context) {
	// Scan new blocks for deposits (auto-detect tx hashes)
	m.scanBlocks(ctx)

	// Expire stale payments first
	expired, err := m.store.ExpireStalePayments(ctx)
	if err != nil {
		log.Printf("monitor: expire stale payments: %v", err)
	} else if expired > 0 {
		log.Printf("monitor: expired %d stale payments", expired)
	}

	// Get current block number for confirmation counting
	currentBlock, err := m.rpc.GetBlockNumber(ctx)
	if err != nil {
		log.Printf("monitor: get block number: %v", err)
		return
	}

	// Check all pending/detected payments
	payments, err := m.store.ListPendingPayments(ctx)
	if err != nil {
		log.Printf("monitor: list pending payments: %v", err)
		return
	}

	for _, p := range payments {
		m.checkPayment(ctx, p, currentBlock)
	}
}

// scanBlocks scans new blocks via zondscan for transactions to assigned pool addresses.
func (m *Monitor) scanBlocks(ctx context.Context) {
	// Get latest block from zondscan
	latestBlock, err := m.zondscan.GetLatestBlock(ctx)
	if err != nil {
		log.Printf("monitor: zondscan get latest block: %v", err)
		return
	}

	// Get last scanned block from DB
	lastScannedStr, err := m.store.GetState(ctx, lastScannedBlockKey)
	if err != nil {
		log.Printf("monitor: get last scanned block: %v", err)
		return
	}

	var lastScanned uint64
	if lastScannedStr == "" {
		// First run: start from current block (don't scan history)
		lastScanned = latestBlock
		if err := m.store.SetState(ctx, lastScannedBlockKey, fmt.Sprintf("%d", latestBlock)); err != nil {
			log.Printf("monitor: set initial scanned block: %v", err)
		}
		return
	}

	lastScanned, err = strconv.ParseUint(lastScannedStr, 10, 64)
	if err != nil {
		log.Printf("monitor: parse last scanned block %q: %v", lastScannedStr, err)
		return
	}

	if lastScanned >= latestBlock {
		return // No new blocks
	}

	// Load addresses waiting for tx hash discovery
	addrMap, err := m.store.GetAssignedAddressMap(ctx)
	if err != nil {
		log.Printf("monitor: get assigned address map: %v", err)
		return
	}

	if len(addrMap) == 0 {
		// No addresses to watch — just update cursor
		if err := m.store.SetState(ctx, lastScannedBlockKey, fmt.Sprintf("%d", latestBlock)); err != nil {
			log.Printf("monitor: set scanned block: %v", err)
		}
		return
	}

	// Scan up to 10 blocks per tick
	endBlock := latestBlock
	if endBlock-lastScanned > 10 {
		endBlock = lastScanned + 10
	}

	for blockNum := lastScanned + 1; blockNum <= endBlock; blockNum++ {
		block, err := m.zondscan.GetBlock(ctx, blockNum)
		if err != nil {
			log.Printf("monitor: zondscan get block %d: %v", blockNum, err)
			break // Don't skip blocks — retry next tick
		}

		for _, tx := range block.Transactions {
			if tx.To == "" || tx.Status != "0x1" {
				continue // Skip contract creations and failed txs
			}

			// Normalize address to Q-prefix for lookup
			normalizedTo := address.Normalize(tx.To)
			paymentID, found := addrMap[normalizedTo]
			if !found {
				continue
			}

			log.Printf("monitor: auto-detected tx %s for payment %s (address=%s, block=%d)",
				tx.Hash, paymentID, normalizedTo, blockNum)

			if err := m.store.SetPaymentTxHash(ctx, paymentID, tx.Hash); err != nil {
				log.Printf("monitor: set tx hash for payment %s: %v", paymentID, err)
			}

			// Remove from map so we don't process duplicates within this scan
			delete(addrMap, normalizedTo)
		}

		// Update cursor after each successfully scanned block
		if err := m.store.SetState(ctx, lastScannedBlockKey, fmt.Sprintf("%d", blockNum)); err != nil {
			log.Printf("monitor: set scanned block: %v", err)
		}
	}
}

func (m *Monitor) checkPayment(ctx context.Context, p model.PaymentIntent, currentBlock uint64) {
	switch p.Status {
	case model.StatusPending:
		m.checkPendingPayment(ctx, p)
	case model.StatusDetected:
		m.checkDetectedPayment(ctx, p, currentBlock)
	}
}

// checkPendingPayment checks if a deposit has been received.
func (m *Monitor) checkPendingPayment(ctx context.Context, p model.PaymentIntent) {
	balance, err := m.rpc.GetBalance(ctx, p.DepositAddress)
	if err != nil {
		log.Printf("monitor: get balance for %s: %v", p.DepositAddress, err)
		return
	}

	if balance.Cmp(big.NewInt(0)) <= 0 {
		return // No deposit yet
	}

	// Validate received amount meets expected amount
	expected := new(big.Int)
	if _, ok := expected.SetString(p.ExpectedAmountWei, 10); !ok {
		log.Printf("monitor: invalid expected amount %q for payment %s", p.ExpectedAmountWei, p.ID)
		return
	}
	if balance.Cmp(expected) < 0 {
		log.Printf("monitor: partial deposit for payment %s (expected=%s, received=%s wei)",
			p.ID, p.ExpectedAmountWei, balance.String())
	}

	log.Printf("monitor: deposit detected for payment %s (address=%s, balance=%s wei)",
		p.ID, p.DepositAddress, balance.String())

	// Move to detected status
	err = m.store.UpdatePaymentStatus(ctx, p.ID, model.StatusDetected, "", balance.String(), 0)
	if err != nil {
		log.Printf("monitor: update payment %s to detected: %v", p.ID, err)
	}
}

// checkDetectedPayment counts confirmations and promotes to confirmed when ready.
func (m *Monitor) checkDetectedPayment(ctx context.Context, p model.PaymentIntent, currentBlock uint64) {
	// If we have a tx hash, check its receipt for block number
	if p.TxHash != "" {
		receipt, err := m.rpc.GetTransactionReceipt(ctx, p.TxHash)
		if err != nil {
			log.Printf("monitor: get receipt for %s: %v", p.TxHash, err)
			return
		}
		if receipt == nil {
			return // Not yet mined
		}

		txBlock, err := hexToUint64(receipt.BlockNumber)
		if err != nil {
			log.Printf("monitor: parse block number %q for %s: %v", receipt.BlockNumber, p.TxHash, err)
			return
		}
		confirmations := int(currentBlock - txBlock)
		if confirmations < 0 {
			confirmations = 0
		}

		// Validate amount before confirming
		expected := new(big.Int)
		if _, ok := expected.SetString(p.ExpectedAmountWei, 10); !ok {
			log.Printf("monitor: invalid expected amount %q for payment %s", p.ExpectedAmountWei, p.ID)
			return
		}
		received := new(big.Int)
		if _, ok := received.SetString(p.ReceivedAmountWei, 10); !ok {
			log.Printf("monitor: invalid received amount %q for payment %s", p.ReceivedAmountWei, p.ID)
			return
		}

		if confirmations >= p.RequiredConfs {
			if received.Cmp(expected) < 0 {
				log.Printf("monitor: payment %s has %d confirmations but underpaid (expected=%s, received=%s)",
					p.ID, confirmations, p.ExpectedAmountWei, p.ReceivedAmountWei)
			}
			log.Printf("monitor: payment %s confirmed (%d/%d confirmations)",
				p.ID, confirmations, p.RequiredConfs)
			err = m.store.UpdatePaymentStatus(ctx, p.ID, model.StatusConfirmed, p.TxHash, p.ReceivedAmountWei, confirmations)
		} else {
			err = m.store.UpdatePaymentStatus(ctx, p.ID, model.StatusDetected, p.TxHash, p.ReceivedAmountWei, confirmations)
		}
		if err != nil {
			log.Printf("monitor: update payment %s: %v", p.ID, err)
		}
		return
	}

	// No tx hash — re-check balance to track received amount.
	// Without a tx hash we cannot count real confirmations, so we only
	// update the received amount and wait for the block scanner to find the tx.
	balance, err := m.rpc.GetBalance(ctx, p.DepositAddress)
	if err != nil {
		log.Printf("monitor: get balance for %s: %v", p.DepositAddress, err)
		return
	}

	if balance.Cmp(big.NewInt(0)) <= 0 {
		return // Balance gone (shouldn't happen for deposit addresses)
	}

	// Update balance but do NOT confirm without a real tx hash
	err = m.store.UpdatePaymentStatus(ctx, p.ID, model.StatusDetected, "", balance.String(), 0)
	if err != nil {
		log.Printf("monitor: update payment %s: %v", p.ID, err)
	}
}

func hexToUint64(hex string) (uint64, error) {
	hex = strings.TrimPrefix(hex, "0x")
	return strconv.ParseUint(hex, 16, 64)
}
