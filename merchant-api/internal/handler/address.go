package handler

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/DigitalGuards/merchant-api/internal/address"
	"github.com/DigitalGuards/merchant-api/internal/store"
	"github.com/theQRL/go-qrllib/wallet/common"
)

type addAddressesRequest struct {
	Addresses []string `json:"addresses"`
}

type addAddressesResponse struct {
	Added             int `json:"added"`
	DuplicatesSkipped int `json:"duplicates_skipped"`
	PoolAvailable     int `json:"pool_available"`
}

type poolStatusResponse struct {
	Available int `json:"available"`
	Assigned  int `json:"assigned"`
	Total     int `json:"total"`
}

func HandleAddAddresses(s store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		merchant := MerchantFromContext(r.Context())
		if merchant == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		var req addAddressesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		if len(req.Addresses) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "addresses array is required and must not be empty"})
			return
		}
		if len(req.Addresses) > 1000 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "maximum 1000 addresses per request"})
			return
		}

		// Normalize and validate all addresses
		normalized := make([]string, 0, len(req.Addresses))
		var invalid []string
		for _, addr := range req.Addresses {
			norm := address.Normalize(addr)
			if !common.IsValidAddress(norm) {
				invalid = append(invalid, addr)
				continue
			}
			normalized = append(normalized, norm)
		}

		if len(invalid) > 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": fmt.Sprintf("invalid addresses: %s", strings.Join(invalid, ", ")),
			})
			return
		}

		added, err := s.AddPoolAddresses(r.Context(), merchant.ID, normalized)
		if err != nil {
			log.Printf("ERROR: add pool addresses: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}

		available, _, err := s.GetPoolStatus(r.Context(), merchant.ID)
		if err != nil {
			log.Printf("ERROR: get pool status: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}

		writeJSON(w, http.StatusOK, addAddressesResponse{
			Added:             added,
			DuplicatesSkipped: len(normalized) - added,
			PoolAvailable:     available,
		})
	}
}

func HandleGetPoolStatus(s store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		merchant := MerchantFromContext(r.Context())
		if merchant == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		available, assigned, err := s.GetPoolStatus(r.Context(), merchant.ID)
		if err != nil {
			log.Printf("ERROR: get pool status: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}

		writeJSON(w, http.StatusOK, poolStatusResponse{
			Available: available,
			Assigned:  assigned,
			Total:     available + assigned,
		})
	}
}
