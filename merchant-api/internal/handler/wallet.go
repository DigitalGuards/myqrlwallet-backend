package handler

import (
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/DigitalGuards/merchant-api/internal/crypto"
	"github.com/DigitalGuards/merchant-api/internal/model"
	"github.com/DigitalGuards/merchant-api/internal/store"
)

type createWalletResponse struct {
	WalletID string `json:"wallet_id"`
	Address  string `json:"address"`
}

func HandleCreateWallet(s store.Store, masterKey [32]byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		merchant := MerchantFromContext(r.Context())
		if merchant == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		// Generate new ML-DSA-87 wallet
		result, err := crypto.GenerateWallet()
		if err != nil {
			log.Printf("ERROR: generate wallet: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to generate wallet"})
			return
		}

		// Encrypt seed for storage
		seedEnc, seedNonce, err := crypto.Encrypt(masterKey, result.ExtendedSeed[:])
		if err != nil {
			log.Printf("ERROR: encrypt seed: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}

		wallet := &model.DepositWallet{
			ID:            uuid.New().String(),
			MerchantID:    merchant.ID,
			Address:       result.Address,
			EncryptedSeed: seedEnc,
			SeedNonce:     seedNonce,
			CreatedAt:     time.Now().UTC(),
		}

		if err := s.CreateDepositWallet(r.Context(), wallet); err != nil {
			log.Printf("ERROR: store wallet: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to store wallet"})
			return
		}

		writeJSON(w, http.StatusCreated, createWalletResponse{
			WalletID: wallet.ID,
			Address:  wallet.Address,
		})
	}
}
