package handler

import (
	"net/http"

	"github.com/DigitalGuards/merchant-api/internal/store"
)

func HandleHealth(s store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := s.Ping(r.Context()); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unhealthy", "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}
