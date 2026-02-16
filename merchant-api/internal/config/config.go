package config

import (
	"encoding/hex"
	"fmt"
	"log"
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
	ZondscanURL             string
	MonitorInterval         time.Duration
	DefaultRequiredConfs    int
	DefaultPaymentTTL       time.Duration
	WebhookInterval         time.Duration
	WebhookMaxRetries       int
	WebhookTimeout          time.Duration
	RateLimitRate           float64
	RateLimitBurst          int
	ZondscanTimeout         time.Duration
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

	monitorSecs := getEnvInt("MONITOR_INTERVAL_SECONDS", 15)
	if monitorSecs < 1 {
		return nil, fmt.Errorf("MONITOR_INTERVAL_SECONDS must be >= 1, got %d", monitorSecs)
	}

	webhookInterval := getEnvInt("WEBHOOK_INTERVAL_SECONDS", 15)
	if webhookInterval < 1 {
		return nil, fmt.Errorf("WEBHOOK_INTERVAL_SECONDS must be >= 1, got %d", webhookInterval)
	}

	webhookTimeout := getEnvInt("WEBHOOK_TIMEOUT_SECONDS", 10)
	if webhookTimeout < 1 {
		return nil, fmt.Errorf("WEBHOOK_TIMEOUT_SECONDS must be >= 1, got %d", webhookTimeout)
	}

	paymentTTL := getEnvInt("DEFAULT_PAYMENT_TTL_MINUTES", 60)
	if paymentTTL < 1 {
		return nil, fmt.Errorf("DEFAULT_PAYMENT_TTL_MINUTES must be >= 1, got %d", paymentTTL)
	}

	return &Config{
		Port:                    getEnvInt("PORT", 8080),
		AdminAPIKey:             adminKey,
		MasterEncryptionKey:     masterKey,
		DatabaseURL:             dbURL,
		ZondRPCEndpoint:         getEnvStr("ZOND_RPC_ENDPOINT", "http://localhost:8545"),
		ZondscanURL:             getEnvStr("ZONDSCAN_URL", "https://zondscan.com/api"),
		MonitorInterval:         time.Duration(monitorSecs) * time.Second,
		DefaultRequiredConfs:    getEnvInt("DEFAULT_REQUIRED_CONFIRMATIONS", 10),
		DefaultPaymentTTL:       time.Duration(paymentTTL) * time.Minute,
		WebhookInterval:         time.Duration(webhookInterval) * time.Second,
		WebhookMaxRetries:       getEnvInt("WEBHOOK_MAX_RETRIES", 5),
		WebhookTimeout:          time.Duration(webhookTimeout) * time.Second,
		RateLimitRate:           float64(getEnvInt("RATE_LIMIT_RPS", 10)),
		RateLimitBurst:          getEnvInt("RATE_LIMIT_BURST", 30),
		ZondscanTimeout:         time.Duration(getEnvInt("ZONDSCAN_TIMEOUT_SECONDS", 10)) * time.Second,
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
		i, err := strconv.Atoi(v)
		if err != nil {
			log.Printf("WARNING: %s=%q is not a valid integer, using default %d", key, v, fallback)
			return fallback
		}
		return i
	}
	return fallback
}
