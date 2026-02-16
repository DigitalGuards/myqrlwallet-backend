package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/lib/pq"

	"github.com/DigitalGuards/merchant-api/internal/config"
	"github.com/DigitalGuards/merchant-api/internal/handler"
	"github.com/DigitalGuards/merchant-api/internal/rpc"
	"github.com/DigitalGuards/merchant-api/internal/store"
	"github.com/DigitalGuards/merchant-api/internal/worker"
	"github.com/DigitalGuards/merchant-api/internal/zondscan"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	// Connect to PostgreSQL
	db, err := sql.Open("postgres", cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("database open: %v", err)
	}
	defer db.Close()

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := db.Ping(); err != nil {
		log.Fatalf("database ping: %v", err)
	}
	log.Println("database connected")

	// Initialize store (runs migrations)
	s, err := store.NewPostgresStore(db)
	if err != nil {
		log.Fatalf("store: %v", err)
	}

	// Initialize RPC client
	rpcClient := rpc.NewClient(cfg.ZondRPCEndpoint, 10*time.Second)

	// Build HTTP router
	router := handler.NewRouter(s, cfg.AdminAPIKey, cfg.MasterEncryptionKey, cfg.DefaultRequiredConfs, cfg.DefaultPaymentTTL, cfg.RateLimitRate, cfg.RateLimitBurst)

	// Create server
	addr := fmt.Sprintf(":%d", cfg.Port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Context for graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize zondscan client for block scanning
	zondscanClient := zondscan.NewClient(cfg.ZondscanURL, cfg.ZondscanTimeout)

	// Start on-chain monitor
	monitor := worker.NewMonitor(s, rpcClient, zondscanClient, cfg.MonitorInterval)
	go monitor.Run(ctx)

	// Start webhook worker
	webhookWorker := worker.NewWebhookWorker(s, cfg.MasterEncryptionKey, cfg.WebhookInterval, cfg.WebhookMaxRetries, cfg.WebhookTimeout)
	go webhookWorker.Run(ctx)

	// Graceful shutdown on SIGINT/SIGTERM
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		log.Printf("received %s, shutting down...", sig)

		cancel() // Stop workers

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("server shutdown: %v", err)
		}
	}()

	log.Printf("merchant-api starting on %s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
	log.Println("merchant-api stopped")
}
