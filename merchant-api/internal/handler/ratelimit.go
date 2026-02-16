package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"sync"
	"time"
)

const maxBuckets = 100_000 // cap on bucket map to prevent memory exhaustion

// bucket holds the token state for a single key.
type bucket struct {
	tokens   float64
	lastTime time.Time
}

// RateLimiter implements an in-memory token bucket rate limiter.
// Each unique key (API key hash or IP) gets its own bucket.
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64 // tokens added per second
	burst   int     // max tokens (bucket capacity)
	cancel  context.CancelFunc
}

// NewRateLimiter creates a rate limiter and starts a background cleanup goroutine.
// Call Stop() to release the cleanup goroutine on shutdown.
//   - rate: requests allowed per second (sustained)
//   - burst: max requests allowed in a burst (bucket size)
func NewRateLimiter(rate float64, burst int) *RateLimiter {
	ctx, cancel := context.WithCancel(context.Background())
	rl := &RateLimiter{
		buckets: make(map[string]*bucket),
		rate:    rate,
		burst:   burst,
		cancel:  cancel,
	}
	go rl.cleanup(ctx)
	return rl
}

// Stop shuts down the background cleanup goroutine.
func (rl *RateLimiter) Stop() {
	rl.cancel()
}

// cleanup removes stale buckets every 5 minutes in a background goroutine.
func (rl *RateLimiter) cleanup(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rl.mu.Lock()
			now := time.Now()
			for k, b := range rl.buckets {
				if now.Sub(b.lastTime) > 10*time.Minute {
					delete(rl.buckets, k)
				}
			}
			rl.mu.Unlock()
		}
	}
}

// allow checks if a request for the given key is allowed.
func (rl *RateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()

	b, exists := rl.buckets[key]
	if !exists {
		// Enforce max bucket count to prevent memory exhaustion
		if len(rl.buckets) >= maxBuckets {
			return false
		}
		rl.buckets[key] = &bucket{
			tokens:   float64(rl.burst) - 1, // consume one token
			lastTime: now,
		}
		return true
	}

	// Refill tokens based on elapsed time
	elapsed := now.Sub(b.lastTime).Seconds()
	b.tokens += elapsed * rl.rate
	if b.tokens > float64(rl.burst) {
		b.tokens = float64(rl.burst)
	}
	b.lastTime = now

	if b.tokens < 1 {
		return false
	}

	b.tokens--
	return true
}

// clientKey extracts a stable key from the request: hashed API key or IP without port.
func clientKey(r *http.Request) string {
	if apiKey := r.Header.Get("X-API-Key"); apiKey != "" {
		h := sha256.Sum256([]byte(apiKey))
		return "key:" + hex.EncodeToString(h[:8]) // 8 bytes is enough for bucketing
	}
	// Strip port from RemoteAddr
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return "ip:" + host
}

// Limit returns HTTP middleware that rate-limits by API key hash (falls back to IP).
func (rl *RateLimiter) Limit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !rl.allow(clientKey(r)) {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limit exceeded"})
			return
		}

		next.ServeHTTP(w, r)
	})
}
