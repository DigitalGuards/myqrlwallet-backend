package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/DigitalGuards/merchant-api/internal/crypto"
)

func main() {
	count := flag.Int("count", 10, "number of wallets to generate")
	outDir := flag.String("out", ".", "directory to write output files")
	apiURL := flag.String("api", "", "merchant API base URL to upload addresses (e.g. https://api.example.com)")
	apiKey := flag.String("key", "", "merchant API key for uploading addresses")
	flag.Parse()

	if *count < 1 || *count > 1000 {
		fmt.Fprintln(os.Stderr, "error: count must be between 1 and 1000")
		os.Exit(1)
	}

	// Ensure output directory exists
	if err := os.MkdirAll(*outDir, 0700); err != nil {
		fmt.Fprintf(os.Stderr, "error: create output dir: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Generating %d ML-DSA-87 wallets...\n", *count)

	type wallet struct {
		Address string
		Seed    string // hex-encoded extended seed
	}

	wallets := make([]wallet, 0, *count)
	addresses := make([]string, 0, *count)

	for i := 0; i < *count; i++ {
		result, err := crypto.GenerateWallet()
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: generate wallet %d: %v\n", i+1, err)
			os.Exit(1)
		}

		seedHex := fmt.Sprintf("%x", result.ExtendedSeed[:])
		wallets = append(wallets, wallet{Address: result.Address, Seed: seedHex})
		addresses = append(addresses, result.Address)
	}

	// Write secrets file (CSV: address,extended_seed_hex)
	ts := time.Now().UTC().Format("20060102-150405")
	secretsFile := filepath.Join(*outDir, fmt.Sprintf("wallets-SECRET-%s.csv", ts))
	addressesFile := filepath.Join(*outDir, fmt.Sprintf("addresses-%s.json", ts))

	f, err := os.OpenFile(secretsFile, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0600)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: create secrets file: %v\n", err)
		os.Exit(1)
	}
	w := csv.NewWriter(f)
	w.Write([]string{"address", "extended_seed_hex"})
	for _, wl := range wallets {
		w.Write([]string{wl.Address, wl.Seed})
	}
	w.Flush()
	f.Close()
	fmt.Printf("  Secrets saved to: %s\n", secretsFile)
	fmt.Println("  WARNING: Store this file securely offline. It contains your private keys.")

	// Write addresses-only file (JSON, for upload or reference)
	addrJSON, _ := json.MarshalIndent(map[string]interface{}{"addresses": addresses}, "", "  ")
	if err := os.WriteFile(addressesFile, addrJSON, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "error: write addresses file: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("  Addresses saved to: %s\n", addressesFile)

	// Upload to API if configured
	if *apiURL != "" && *apiKey != "" {
		fmt.Printf("\nUploading %d addresses to %s ...\n", len(addresses), *apiURL)
		if err := uploadAddresses(*apiURL, *apiKey, addresses); err != nil {
			fmt.Fprintf(os.Stderr, "error: upload failed: %v\n", err)
			fmt.Fprintln(os.Stderr, "Addresses saved locally — you can upload manually later with:")
			fmt.Fprintf(os.Stderr, "  curl -X POST %s/v1/addresses -H 'X-API-Key: %s' -H 'Content-Type: application/json' -d @%s\n", *apiURL, *apiKey, addressesFile)
			os.Exit(1)
		}
		fmt.Println("  Upload successful.")
	} else if *apiURL != "" || *apiKey != "" {
		fmt.Fprintln(os.Stderr, "\nWARNING: Both -api and -key are required for upload. Skipping upload.")
	} else {
		fmt.Println("\nTo upload addresses to your merchant API:")
		fmt.Printf("  curl -X POST <API_URL>/v1/addresses \\\n    -H 'X-API-Key: <YOUR_API_KEY>' \\\n    -H 'Content-Type: application/json' \\\n    -d @%s\n", addressesFile)
	}

	fmt.Printf("\nDone. Generated %d wallets.\n", len(wallets))
}

func uploadAddresses(baseURL, apiKey string, addresses []string) error {
	body, _ := json.Marshal(map[string]interface{}{"addresses": addresses})

	req, err := http.NewRequest("POST", baseURL+"/v1/addresses", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", apiKey)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("API returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Added             int `json:"added"`
		DuplicatesSkipped int `json:"duplicates_skipped"`
		PoolAvailable     int `json:"pool_available"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return fmt.Errorf("parse response: %w", err)
	}

	fmt.Printf("  Added: %d | Duplicates skipped: %d | Pool available: %d\n",
		result.Added, result.DuplicatesSkipped, result.PoolAvailable)
	return nil
}
