package handler

import (
	"net/http"
	"sync"
	"time"
)

// bucket holds the token state for a single key.
type bucket struct {
	tokens   float64
	lastTime time.Time
}

// RateLimiter implements an in-memory token bucket rate limiter.
// Each unique key (API key or IP) gets its own bucket.
type RateLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	rate     float64 // tokens added per second
	burst    int     // max tokens (bucket capacity)
	lastClean time.Time
}

// NewRateLimiter creates a rate limiter.
//   - rate: requests allowed per second (sustained)
//   - burst: max requests allowed in a burst (bucket size)
func NewRateLimiter(rate float64, burst int) *RateLimiter {
	return &RateLimiter{
		buckets:  make(map[string]*bucket),
		rate:     rate,
		burst:    burst,
		lastClean: time.Now(),
	}
}

// allow checks if a request for the given key is allowed.
func (rl *RateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()

	// Clean stale buckets every 5 minutes to prevent memory growth
	if now.Sub(rl.lastClean) > 5*time.Minute {
		for k, b := range rl.buckets {
			if now.Sub(b.lastTime) > 10*time.Minute {
				delete(rl.buckets, k)
			}
		}
		rl.lastClean = now
	}

	b, exists := rl.buckets[key]
	if !exists {
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

// Limit returns HTTP middleware that rate-limits by API key (falls back to IP).
func (rl *RateLimiter) Limit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("X-API-Key")
		if key == "" {
			key = r.RemoteAddr
		}

		if !rl.allow(key) {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limit exceeded"})
			return
		}

		next.ServeHTTP(w, r)
	})
}
