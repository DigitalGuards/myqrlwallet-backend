package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/google/uuid"

	"github.com/DigitalGuards/merchant-api/internal/crypto"
	"github.com/DigitalGuards/merchant-api/internal/model"
	"github.com/DigitalGuards/merchant-api/internal/store"
)

type createMerchantRequest struct {
	Name       string `json:"name"`
	WebhookURL string `json:"webhook_url"`
}

type createMerchantResponse struct {
	MerchantID    string `json:"merchant_id"`
	APIKey        string `json:"api_key"`
	WebhookSecret string `json:"webhook_secret"`
	CreatedAt     string `json:"created_at"`
}

func HandleCreateMerchant(s store.Store, masterKey [32]byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createMerchantRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		if req.Name == "" || req.WebhookURL == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name and webhook_url are required"})
			return
		}
		if err := validateWebhookURL(req.WebhookURL); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		// Generate API key
		apiKey, err := generateSecureToken("qrl_live_")
		if err != nil {
			log.Printf("ERROR: generate API key: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}

		// Generate webhook secret
		webhookSecret, err := generateSecureToken("whsec_")
		if err != nil {
			log.Printf("ERROR: generate webhook secret: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}

		// Encrypt webhook secret for storage
		secretEnc, secretNonce, err := crypto.Encrypt(masterKey, []byte(webhookSecret))
		if err != nil {
			log.Printf("ERROR: encrypt webhook secret: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}

		now := time.Now().UTC()
		merchant := &model.Merchant{
			ID:                 uuid.New().String(),
			Name:               req.Name,
			APIKeyHash:         hashAPIKey(apiKey),
			WebhookURL:         req.WebhookURL,
			WebhookSecretEnc:   secretEnc,
			WebhookSecretNonce: secretNonce,
			IsActive:           true,
			CreatedAt:          now,
			UpdatedAt:          now,
		}

		if err := s.CreateMerchant(r.Context(), merchant); err != nil {
			log.Printf("ERROR: create merchant: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create merchant"})
			return
		}

		writeJSON(w, http.StatusCreated, createMerchantResponse{
			MerchantID:    merchant.ID,
			APIKey:        apiKey,
			WebhookSecret: webhookSecret,
			CreatedAt:     now.Format(time.RFC3339),
		})
	}
}

// validateWebhookURL ensures the URL is HTTPS and not pointing at internal/private addresses.
func validateWebhookURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("webhook_url is not a valid URL")
	}
	if u.Scheme != "https" {
		return fmt.Errorf("webhook_url must use HTTPS")
	}
	host := u.Hostname()
	if host == "localhost" || host == "" {
		return fmt.Errorf("webhook_url must not target localhost")
	}
	ip := net.ParseIP(host)
	if ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()) {
		return fmt.Errorf("webhook_url must not target private/internal addresses")
	}
	return nil
}

func generateSecureToken(prefix string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate random bytes: %w", err)
	}
	return prefix + hex.EncodeToString(b), nil
}
