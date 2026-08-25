package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/dhrvrm/home-os/apps/api/internal/inventory"
)

const maxRequestBody = 1 << 20

type InventoryService interface {
	ListItems(context.Context, inventory.Filter) ([]inventory.Item, error)
	CreateItem(context.Context, inventory.CreateItemInput) (inventory.Item, error)
	UpdateItemMetadata(context.Context, string, inventory.UpdateItemMetadataInput) (inventory.Item, error)
	ApplyEvent(context.Context, string, inventory.ApplyEventInput) (inventory.Item, error)
}

type Config struct {
	AllowedOrigins []string
	Logger         *slog.Logger
}

type handler struct {
	service InventoryService
	logger  *slog.Logger
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
}

type envelope struct {
	Data  any       `json:"data"`
	Error *apiError `json:"error"`
}

func NewRouter(service InventoryService, config Config) http.Handler {
	logger := config.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	h := &handler{service: service, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.health)
	mux.HandleFunc("GET /api/v1/items", h.listItems)
	mux.HandleFunc("POST /api/v1/items", h.createItem)
	mux.HandleFunc("PATCH /api/v1/items/{id}", h.updateItemMetadata)
	mux.HandleFunc("POST /api/v1/items/{id}/events", h.applyEvent)
	return cors(config.AllowedOrigins, recoverPanics(logger, requestLog(logger, mux)))
}

func (h *handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, envelope{Data: map[string]string{"status": "ok"}})
}

func (h *handler) listItems(w http.ResponseWriter, r *http.Request) {
	stockLevel := inventory.StockLevel(strings.TrimSpace(r.URL.Query().Get("stockLevel")))
	if stockLevel != "" && !stockLevel.Valid() {
		writeError(w, inventory.ValidationError{Field: "stockLevel", Message: "must be full, okay, low, or out"}, h.logger)
		return
	}
	items, err := h.service.ListItems(r.Context(), inventory.Filter{
		Query:      r.URL.Query().Get("q"),
		Category:   r.URL.Query().Get("category"),
		StockLevel: stockLevel,
	})
	if err != nil {
		writeError(w, err, h.logger)
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"items": items}})
}

func (h *handler) createItem(w http.ResponseWriter, r *http.Request) {
	var input inventory.CreateItemInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeJSON(w, http.StatusBadRequest, envelope{Error: &apiError{Code: "invalid_json", Message: err.Error()}})
		return
	}
	item, err := h.service.CreateItem(r.Context(), input)
	if err != nil {
		writeError(w, err, h.logger)
		return
	}
	writeJSON(w, http.StatusCreated, envelope{Data: map[string]any{"item": item}})
}

func (h *handler) updateItemMetadata(w http.ResponseWriter, r *http.Request) {
	var input inventory.UpdateItemMetadataInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeJSON(w, http.StatusBadRequest, envelope{Error: &apiError{Code: "invalid_json", Message: err.Error()}})
		return
	}
	item, err := h.service.UpdateItemMetadata(r.Context(), r.PathValue("id"), input)
	if err != nil {
		writeError(w, err, h.logger)
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"item": item}})
}

func (h *handler) applyEvent(w http.ResponseWriter, r *http.Request) {
	var input inventory.ApplyEventInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeJSON(w, http.StatusBadRequest, envelope{Error: &apiError{Code: "invalid_json", Message: err.Error()}})
		return
	}
	item, err := h.service.ApplyEvent(r.Context(), r.PathValue("id"), input)
	if err != nil {
		writeError(w, err, h.logger)
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"item": item}})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("send valid JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("send one JSON object")
	}
	return nil
}

func writeError(w http.ResponseWriter, err error, logger *slog.Logger) {
	var validation inventory.ValidationError
	switch {
	case errors.As(err, &validation):
		writeJSON(w, http.StatusBadRequest, envelope{Error: &apiError{Code: "invalid_input", Message: validation.Message, Field: validation.Field}})
	case errors.Is(err, inventory.ErrNotFound):
		writeJSON(w, http.StatusNotFound, envelope{Error: &apiError{Code: "not_found", Message: "inventory item not found"}})
	default:
		logger.Error("request failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, envelope{Error: &apiError{Code: "internal_error", Message: "the request could not be completed"}})
	}
}

func writeJSON(w http.ResponseWriter, status int, value envelope) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func cors(allowed []string, next http.Handler) http.Handler {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, origin := range allowed {
		if trimmed := strings.TrimSpace(origin); trimmed != "" {
			allowedSet[trimmed] = struct{}{}
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		_, permitted := allowedSet[origin]
		if origin != "" && !permitted {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		if origin != "" && permitted {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requestLog(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		logger.Info("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(started))
	})
}

func recoverPanics(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Error("panic recovered", "value", recovered, "path", r.URL.Path)
				writeJSON(w, http.StatusInternalServerError, envelope{Error: &apiError{Code: "internal_error", Message: "the request could not be completed"}})
			}
		}()
		next.ServeHTTP(w, r)
	})
}
