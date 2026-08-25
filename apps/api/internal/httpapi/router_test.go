package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dhrvrm/home-os/apps/api/internal/inventory"
)

type fakeInventoryService struct {
	items       []inventory.Item
	listFilter  inventory.Filter
	created     inventory.CreateItemInput
	eventItemID string
	event       inventory.ApplyEventInput
	err         error
}

func (s *fakeInventoryService) ListItems(_ context.Context, filter inventory.Filter) ([]inventory.Item, error) {
	s.listFilter = filter
	return s.items, s.err
}

func (s *fakeInventoryService) CreateItem(_ context.Context, input inventory.CreateItemInput) (inventory.Item, error) {
	s.created = input
	if s.err != nil {
		return inventory.Item{}, s.err
	}
	item := inventory.Item{ID: "item-1", Name: input.Name, AlternativeNames: input.AlternativeNames, Category: input.Category, Categories: input.Categories}
	if len(item.Categories) > 0 {
		item.Category = item.Categories[0]
	}
	if input.LevelPercent != nil {
		item.LevelPercent = *input.LevelPercent
	}
	return item, nil
}

func (s *fakeInventoryService) ApplyEvent(_ context.Context, itemID string, input inventory.ApplyEventInput) (inventory.Item, error) {
	s.eventItemID = itemID
	s.event = input
	if s.err != nil {
		return inventory.Item{}, s.err
	}
	return inventory.Item{ID: itemID, StockLevel: inventory.StockLow}, nil
}

func TestHealth(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()
	NewRouter(&fakeInventoryService{}, Config{}).ServeHTTP(response, request)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"ok"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestListItemsParsesFilters(t *testing.T) {
	service := &fakeInventoryService{items: []inventory.Item{{ID: "item-1", Name: "Soap"}}}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/items?q=soap&category=Cleaning&stockLevel=low", nil)
	response := httptest.NewRecorder()
	NewRouter(service, Config{}).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if service.listFilter.Query != "soap" || service.listFilter.Category != "Cleaning" || service.listFilter.StockLevel != inventory.StockLow {
		t.Fatalf("filter = %#v", service.listFilter)
	}
	var envelope struct {
		Data struct {
			Items []inventory.Item `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || len(envelope.Data.Items) != 1 {
		t.Fatalf("decode response: %v, body = %s", err, response.Body.String())
	}
}

func TestCreateItem(t *testing.T) {
	service := &fakeInventoryService{}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/items", strings.NewReader(`{"name":"Dish soap","alternativeNames":["बर्तन धोने का साबुन","Soap"],"categories":["Cleaning","Kitchen"],"trackingMode":"simple","levelPercent":75}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	NewRouter(service, Config{}).ServeHTTP(response, request)

	if response.Code != http.StatusCreated || service.created.Name != "Dish soap" || service.created.LevelPercent == nil || *service.created.LevelPercent != 75 {
		t.Fatalf("response = %d %s, input = %#v", response.Code, response.Body.String(), service.created)
	}
	if len(service.created.AlternativeNames) != 2 || service.created.AlternativeNames[0] != "बर्तन धोने का साबुन" || len(service.created.Categories) != 2 || service.created.Categories[1] != "Kitchen" {
		t.Fatalf("decoded metadata = %#v", service.created)
	}
	for _, fragment := range []string{`"alternativeNames":["बर्तन धोने का साबुन","Soap"]`, `"categories":["Cleaning","Kitchen"]`, `"category":"Cleaning"`} {
		if !strings.Contains(response.Body.String(), fragment) {
			t.Fatalf("response missing %s: %s", fragment, response.Body.String())
		}
	}
	if !strings.Contains(response.Body.String(), `"levelPercent":75`) {
		t.Fatalf("response = %d %s, input = %#v", response.Code, response.Body.String(), service.created)
	}
}

func TestApplyEvent(t *testing.T) {
	service := &fakeInventoryService{}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/items/milk/events", strings.NewReader(`{"type":"consume","quantity":1}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	NewRouter(service, Config{}).ServeHTTP(response, request)

	if response.Code != http.StatusOK || service.eventItemID != "milk" || service.event.Type != inventory.EventConsume {
		t.Fatalf("response = %d %s, event = %#v", response.Code, response.Body.String(), service.event)
	}
}

func TestApplyEventAcceptsZeroPercentage(t *testing.T) {
	service := &fakeInventoryService{}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/items/soap/events", strings.NewReader(`{"type":"mark_level","levelPercent":0}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	NewRouter(service, Config{}).ServeHTTP(response, request)

	if response.Code != http.StatusOK || service.event.LevelPercent == nil || *service.event.LevelPercent != 0 {
		t.Fatalf("response = %d %s, event = %#v", response.Code, response.Body.String(), service.event)
	}
}

func TestInvalidJSONAndNotFoundErrors(t *testing.T) {
	t.Run("invalid json", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/items", strings.NewReader(`{"name":`))
		response := httptest.NewRecorder()
		NewRouter(&fakeInventoryService{}, Config{}).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "valid JSON") {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("not found", func(t *testing.T) {
		service := &fakeInventoryService{err: inventory.ErrNotFound}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/items/missing/events", strings.NewReader(`{"type":"consume"}`))
		response := httptest.NewRecorder()
		NewRouter(service, Config{}).ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("validation", func(t *testing.T) {
		service := &fakeInventoryService{err: inventory.ValidationError{Field: "name", Message: "enter an item name"}}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/items", strings.NewReader(`{"name":""}`))
		response := httptest.NewRecorder()
		NewRouter(service, Config{}).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || !errors.Is(service.err, inventory.ErrInvalid) {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})
}

func TestCORSPreflight(t *testing.T) {
	request := httptest.NewRequest(http.MethodOptions, "/api/v1/items", nil)
	request.Header.Set("Origin", "http://localhost:3000")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	response := httptest.NewRecorder()
	NewRouter(&fakeInventoryService{}, Config{AllowedOrigins: []string{"http://localhost:3000"}}).ServeHTTP(response, request)

	if response.Code != http.StatusNoContent || response.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Fatalf("response = %d headers = %#v", response.Code, response.Header())
	}
}

func TestCORSRejectsDisallowedOriginBeforeMutation(t *testing.T) {
	service := &fakeInventoryService{}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/items", strings.NewReader(`{"name":"Rice"}`))
	request.Header.Set("Content-Type", "text/plain")
	request.Header.Set("Origin", "https://untrusted.example")
	response := httptest.NewRecorder()
	NewRouter(service, Config{AllowedOrigins: []string{"http://localhost:3000"}}).ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if service.created.Name != "" {
		t.Fatalf("disallowed request reached service with input %#v", service.created)
	}
}
