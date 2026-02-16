package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/DigitalGuards/merchant-api/internal/store"
)

// NewRouter creates the HTTP router with all routes and middleware.
func NewRouter(s store.Store, adminKey string, masterKey [32]byte, defaultConfs int, defaultTTL time.Duration) http.Handler {
	mux := http.NewServeMux()

	// Public
	mux.HandleFunc("GET /health", HandleHealth(s))

	// Admin-only
	adminMux := http.NewServeMux()
	adminMux.HandleFunc("POST /v1/merchants", HandleCreateMerchant(s, masterKey))
	mux.Handle("/v1/merchants", AdminAuth(adminKey)(adminMux))

	// Merchant-authenticated
	authMux := http.NewServeMux()
	authMux.HandleFunc("POST /v1/wallets", HandleCreateWallet(s, masterKey))
	authMux.HandleFunc("POST /v1/addresses", HandleAddAddresses(s))
	authMux.HandleFunc("GET /v1/addresses", HandleGetPoolStatus(s))
	authMux.HandleFunc("POST /v1/payments", HandleCreatePayment(s, defaultConfs, defaultTTL))
	authMux.HandleFunc("GET /v1/payments/{id}", HandleGetPayment(s))
	authMux.HandleFunc("PATCH /v1/payments/{id}/tx", HandleSubmitTxHash(s))
	authMux.HandleFunc("GET /v1/payments", HandleGetPayment(s))

	mux.Handle("/v1/wallets", APIKeyAuth(s)(authMux))
	mux.Handle("/v1/addresses", APIKeyAuth(s)(authMux))
	mux.Handle("/v1/payments", APIKeyAuth(s)(authMux))
	mux.Handle("/v1/payments/", APIKeyAuth(s)(authMux))

	// Rate limiter: 10 requests/sec sustained, burst of 30
	rl := NewRateLimiter(10, 30)

	// Wrap with global middleware
	var handler http.Handler = mux
	handler = rl.Limit(handler)
	handler = RequestLogger(handler)
	handler = Recovery(handler)

	return handler
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("ERROR: writeJSON encode: %v", err)
	}
}
