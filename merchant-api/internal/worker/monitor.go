package worker

import (
	"context"
	"log"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/DigitalGuards/merchant-api/internal/model"
	"github.com/DigitalGuards/merchant-api/internal/rpc"
	"github.com/DigitalGuards/merchant-api/internal/store"
)

// Monitor polls the Zond blockchain for deposits to pending payment addresses.
type Monitor struct {
	store    store.Store
	rpc      *rpc.Client
	interval time.Duration
}

// NewMonitor creates a new on-chain monitor.
func NewMonitor(s store.Store, rpc *rpc.Client, interval time.Duration) *Monitor {
	return &Monitor{
		store:    s,
		rpc:      rpc,
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

		txBlock := hexToUint64(receipt.BlockNumber)
		confirmations := int(currentBlock - txBlock)
		if confirmations < 0 {
			confirmations = 0
		}

		if confirmations >= p.RequiredConfs {
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

	// No tx hash yet — re-check balance and try to find confirmations
	// For now, use a simple heuristic: if balance is still there after
	// some blocks, consider it confirmed based on time elapsed
	balance, err := m.rpc.GetBalance(ctx, p.DepositAddress)
	if err != nil {
		log.Printf("monitor: get balance for %s: %v", p.DepositAddress, err)
		return
	}

	if balance.Cmp(big.NewInt(0)) <= 0 {
		return // Balance gone (shouldn't happen for deposit addresses)
	}

	// Estimate confirmations based on time since detection
	// Zond block time is ~16 seconds
	timeSinceUpdate := time.Since(p.UpdatedAt)
	estimatedConfs := int(timeSinceUpdate.Seconds() / 16)

	if estimatedConfs >= p.RequiredConfs {
		log.Printf("monitor: payment %s confirmed (estimated %d/%d confirmations, no tx hash)",
			p.ID, estimatedConfs, p.RequiredConfs)
		err = m.store.UpdatePaymentStatus(ctx, p.ID, model.StatusConfirmed, "", balance.String(), estimatedConfs)
	} else {
		err = m.store.UpdatePaymentStatus(ctx, p.ID, model.StatusDetected, "", balance.String(), estimatedConfs)
	}
	if err != nil {
		log.Printf("monitor: update payment %s: %v", p.ID, err)
	}
}

func hexToUint64(hex string) uint64 {
	hex = strings.TrimPrefix(hex, "0x")
	n, _ := strconv.ParseUint(hex, 16, 64)
	return n
}
