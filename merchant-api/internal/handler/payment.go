package handler

import (
	"encoding/json"
	"log"
	"math/big"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"

	"github.com/DigitalGuards/merchant-api/internal/crypto"
	"github.com/DigitalGuards/merchant-api/internal/model"
	"github.com/DigitalGuards/merchant-api/internal/store"
)

var hexHashRegex = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)

type createPaymentRequest struct {
	ExternalID    string `json:"external_id"`
	AmountWei     string `json:"amount_wei"`
	RequiredConfs int    `json:"required_confirmations,omitempty"`
	TTLMinutes    int    `json:"ttl_minutes,omitempty"`
}

func HandleCreatePayment(s store.Store, masterKey [32]byte, defaultConfs int, defaultTTL time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		merchant := MerchantFromContext(r.Context())
		if merchant == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		var req createPaymentRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		if req.ExternalID == "" || req.AmountWei == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "external_id and amount_wei are required"})
			return
		}

		// Validate amount_wei is a positive integer
		amount := new(big.Int)
		if _, ok := amount.SetString(req.AmountWei, 10); !ok || amount.Sign() <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "amount_wei must be a positive integer string"})
			return
		}

		// Idempotency: check if payment with this external_id already exists
		existing, err := s.GetPaymentIntentByExternalID(r.Context(), merchant.ID, req.ExternalID)
		if err != nil {
			log.Printf("ERROR: check existing payment: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		if existing != nil {
			writeJSON(w, http.StatusOK, existing)
			return
		}

		// Generate a new deposit wallet for this payment
		walletResult, err := crypto.GenerateWallet()
		if err != nil {
			log.Printf("ERROR: generate wallet for payment: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to generate deposit address"})
			return
		}

		seedEnc, seedNonce, err := crypto.Encrypt(masterKey, walletResult.ExtendedSeed[:])
		if err != nil {
			log.Printf("ERROR: encrypt seed: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}

		now := time.Now().UTC()
		paymentID := uuid.New().String()

		confs := defaultConfs
		if req.RequiredConfs > 0 {
			confs = req.RequiredConfs
		}
		ttl := defaultTTL
		if req.TTLMinutes > 0 {
			ttl = time.Duration(req.TTLMinutes) * time.Minute
		}

		// Store wallet and payment atomically
		wallet := &model.DepositWallet{
			ID:              uuid.New().String(),
			MerchantID:      merchant.ID,
			Address:         walletResult.Address,
			EncryptedSeed:   seedEnc,
			SeedNonce:       seedNonce,
			PaymentIntentID: paymentID,
			CreatedAt:       now,
		}

		payment := &model.PaymentIntent{
			ID:                paymentID,
			MerchantID:        merchant.ID,
			ExternalID:        req.ExternalID,
			DepositAddress:    walletResult.Address,
			ExpectedAmountWei: req.AmountWei,
			ReceivedAmountWei: "0",
			Status:            model.StatusPending,
			RequiredConfs:     confs,
			ExpiresAt:         now.Add(ttl),
			CreatedAt:         now,
			UpdatedAt:         now,
		}
		if err := s.CreatePaymentWithWallet(r.Context(), wallet, payment); err != nil {
			log.Printf("ERROR: store payment: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create payment"})
			return
		}

		writeJSON(w, http.StatusCreated, payment)
	}
}

func HandleGetPayment(s store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		merchant := MerchantFromContext(r.Context())
		if merchant == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		// Check for external_id query param first
		if extID := r.URL.Query().Get("external_id"); extID != "" {
			payment, err := s.GetPaymentIntentByExternalID(r.Context(), merchant.ID, extID)
			if err != nil {
				log.Printf("ERROR: get payment by external_id: %v", err)
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
				return
			}
			if payment == nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "payment not found"})
				return
			}
			writeJSON(w, http.StatusOK, payment)
			return
		}

		// Get by payment ID from path
		id := r.PathValue("id")
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "payment id is required"})
			return
		}

		payment, err := s.GetPaymentIntent(r.Context(), id)
		if err != nil {
			log.Printf("ERROR: get payment: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		if payment == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "payment not found"})
			return
		}

		// Ensure merchant can only see their own payments
		if payment.MerchantID != merchant.ID {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "payment not found"})
			return
		}

		writeJSON(w, http.StatusOK, payment)
	}
}

type submitTxHashRequest struct {
	TxHash string `json:"tx_hash"`
}

// HandleSubmitTxHash allows merchants to associate a transaction hash with a payment.
// This is required for the monitor to track confirmations on-chain.
func HandleSubmitTxHash(s store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		merchant := MerchantFromContext(r.Context())
		if merchant == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		id := r.PathValue("id")
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "payment id is required"})
			return
		}

		var req submitTxHashRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		if !hexHashRegex.MatchString(req.TxHash) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tx_hash must be a 0x-prefixed 64-character hex string"})
			return
		}

		payment, err := s.GetPaymentIntent(r.Context(), id)
		if err != nil {
			log.Printf("ERROR: get payment for tx submit: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		if payment == nil || payment.MerchantID != merchant.ID {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "payment not found"})
			return
		}

		if payment.Status != model.StatusDetected {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "tx_hash can only be submitted for payments in 'detected' status"})
			return
		}

		if err := s.SetPaymentTxHash(r.Context(), id, req.TxHash); err != nil {
			log.Printf("ERROR: set tx hash for payment %s: %v", id, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}

		payment.TxHash = req.TxHash
		writeJSON(w, http.StatusOK, payment)
	}
}
