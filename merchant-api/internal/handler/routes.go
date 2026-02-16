package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/DigitalGuards/merchant-api/internal/store"
)

// NewRouter creates the HTTP router with all routes and middleware.
func NewRouter(s store.Store, adminKey string, masterKey [32]byte, defaultConfs int, defaultTTL time.Duration, rateLimit float64, rateBurst int) http.Handler {
	mux := http.NewServeMux()
	rl := NewRateLimiter(rateLimit, rateBurst)

	// Public (exempt from rate limiting)
	mux.HandleFunc("GET /health", HandleHealth(s))

	// Admin-only (rate-limited)
	adminMux := http.NewServeMux()
	adminMux.HandleFunc("POST /v1/merchants", HandleCreateMerchant(s, masterKey))
	mux.Handle("/v1/merchants", rl.Limit(AdminAuth(adminKey)(adminMux)))

	// Merchant-authenticated (rate-limited)
	authMux := http.NewServeMux()
	authMux.HandleFunc("POST /v1/wallets", HandleCreateWallet(s, masterKey))
	authMux.HandleFunc("POST /v1/addresses", HandleAddAddresses(s))
	authMux.HandleFunc("GET /v1/addresses", HandleGetPoolStatus(s))
	authMux.HandleFunc("POST /v1/payments", HandleCreatePayment(s, defaultConfs, defaultTTL))
	authMux.HandleFunc("GET /v1/payments/{id}", HandleGetPayment(s))
	authMux.HandleFunc("PATCH /v1/payments/{id}/tx", HandleSubmitTxHash(s))
	authMux.HandleFunc("GET /v1/payments", HandleGetPayment(s))

	var authHandler http.Handler = authMux
	authHandler = rl.Limit(APIKeyAuth(s)(authHandler))

	mux.Handle("/v1/wallets", authHandler)
	mux.Handle("/v1/addresses", authHandler)
	mux.Handle("/v1/payments", authHandler)
	mux.Handle("/v1/payments/", authHandler)

	// Global middleware (logging + recovery only — rate limiting is per-route above)
	var handler http.Handler = mux
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
