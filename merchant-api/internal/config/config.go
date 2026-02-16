package config

import (
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Port                    int
	AdminAPIKey             string
	MasterEncryptionKey     [32]byte
	DatabaseURL             string
	ZondRPCEndpoint         string
	MonitorInterval         time.Duration
	DefaultRequiredConfs    int
	DefaultPaymentTTL       time.Duration
	WebhookMaxRetries       int
	WebhookTimeout          time.Duration
}

func Load() (*Config, error) {
	masterKeyHex := os.Getenv("MASTER_ENCRYPTION_KEY")
	if len(masterKeyHex) != 64 {
		return nil, fmt.Errorf("MASTER_ENCRYPTION_KEY must be 64 hex characters (32 bytes)")
	}
	masterKeyBytes, err := hex.DecodeString(masterKeyHex)
	if err != nil {
		return nil, fmt.Errorf("MASTER_ENCRYPTION_KEY is not valid hex: %w", err)
	}
	var masterKey [32]byte
	copy(masterKey[:], masterKeyBytes)

	adminKey := os.Getenv("ADMIN_API_KEY")
	if adminKey == "" {
		return nil, fmt.Errorf("ADMIN_API_KEY is required")
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	return &Config{
		Port:                    getEnvInt("PORT", 8080),
		AdminAPIKey:             adminKey,
		MasterEncryptionKey:     masterKey,
		DatabaseURL:             dbURL,
		ZondRPCEndpoint:         getEnvStr("ZOND_RPC_ENDPOINT", "http://localhost:8545"),
		MonitorInterval:         time.Duration(getEnvInt("MONITOR_INTERVAL_SECONDS", 15)) * time.Second,
		DefaultRequiredConfs:    getEnvInt("DEFAULT_REQUIRED_CONFIRMATIONS", 10),
		DefaultPaymentTTL:       time.Duration(getEnvInt("DEFAULT_PAYMENT_TTL_MINUTES", 60)) * time.Minute,
		WebhookMaxRetries:       getEnvInt("WEBHOOK_MAX_RETRIES", 5),
		WebhookTimeout:          time.Duration(getEnvInt("WEBHOOK_TIMEOUT_SECONDS", 10)) * time.Second,
	}, nil
}

func getEnvStr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}
