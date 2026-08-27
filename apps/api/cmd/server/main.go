package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/dhrvrm/home-os/apps/api/internal/httpapi"
	"github.com/dhrvrm/home-os/apps/api/internal/inventory"
	"github.com/dhrvrm/home-os/apps/api/internal/storage/sqlite"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	address := envOr("HOMEOS_ADDR", ":8080")
	databasePath := envOr("HOMEOS_DB_PATH", "./data/home-os.db")
	origins := splitCSV(envOr("HOMEOS_ALLOWED_ORIGINS", "http://localhost:3100,http://127.0.0.1:3100,http://localhost:8787"))

	repository, err := sqlite.Open(databasePath)
	if err != nil {
		logger.Error("open database", "error", err)
		os.Exit(1)
	}
	defer repository.Close()

	service := inventory.NewService(repository)
	server := &http.Server{
		Addr:              address,
		Handler:           httpapi.NewRouter(service, httpapi.Config{AllowedOrigins: origins, Logger: logger}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdownSignals, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-shutdownSignals.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			logger.Error("shutdown server", "error", err)
		}
	}()

	logger.Info("home os api listening", "address", address, "database", databasePath)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("serve api", "error", err)
		os.Exit(1)
	}
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}
