package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dhrvrm/home-os/apps/api/internal/inventory"
)

type fakeInventoryService struct {
	items       []inventory.Item
	listFilter  inventory.Filter
	created     inventory.CreateItemInput
	metadataID  string
	metadata    inventory.UpdateItemMetadataInput
	eventItemID string
	event       inventory.ApplyEventInput
	err         error
	events      []inventory.StockEvent
}

func (s *fakeInventoryService) Ping(context.Context) error { return s.err }

func (s *fakeInventoryService) ListItems(_ context.Context, filter inventory.Filter) ([]inventory.Item, error) {
	s.listFilter = filter
	return s.items, s.err
}

func (s *fakeInventoryService) GetItem(_ context.Context, itemID string) (inventory.Item, error) {
	if s.err != nil {
		return inventory.Item{}, s.err
	}
	for _, item := range s.items {
		if item.ID == itemID {
			return item, nil
		}
	}
	return inventory.Item{ID: itemID, Name: "Item"}, nil
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

func (s *fakeInventoryService) UpdateItem(_ context.Context, itemID string, input inventory.UpdateItemInput) (inventory.Item, error) {
	s.metadataID = itemID
	s.metadata = input
	if s.err != nil {
		return inventory.Item{}, s.err
	}
	item := inventory.Item{ID: itemID}
	if input.Name != nil {
		item.Name = *input.Name
	}
	if input.AlternativeNames != nil {
		item.AlternativeNames = *input.AlternativeNames
	}
	if input.Categories != nil {
		item.Categories = *input.Categories
		if len(item.Categories) > 0 {
			item.Category = item.Categories[0]
		}
	}
	return item, nil
}

func (s *fakeInventoryService) ListEvents(_ context.Context, itemID string, _ time.Time) ([]inventory.StockEvent, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.events, nil
}

func (s *fakeInventoryService) ArchiveItem(_ context.Context, itemID string) (inventory.Item, error) {
	if s.err != nil {
		return inventory.Item{}, s.err
	}
	now := time.Date(2026, 8, 27, 8, 0, 0, 0, time.UTC)
	return inventory.Item{ID: itemID, ArchivedAt: &now}, nil
}

func (s *fakeInventoryService) RestoreItem(_ context.Context, itemID string) (inventory.Item, error) {
	if s.err != nil {
		return inventory.Item{}, s.err
	}
	return inventory.Item{ID: itemID}, nil
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

func TestReadyChecksStorage(t *testing.T) {
	t.Run("ready", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewRouter(&fakeInventoryService{}, Config{}).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"ready"`) {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("storage unavailable", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewRouter(&fakeInventoryService{err: errors.New("database unavailable")}, Config{}).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"not_ready"`) {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})
}

func TestListItemsParsesFilters(t *testing.T) {
	service := &fakeInventoryService{items: []inventory.Item{{ID: "item-1", Name: "Soap"}}}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/items?q=soap&category=Cleaning&stockLevel=low&archived=only", nil)
	response := httptest.NewRecorder()
	NewRouter(service, Config{}).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if service.listFilter.Query != "soap" || service.listFilter.Category != "Cleaning" || service.listFilter.StockLevel != inventory.StockLow || service.listFilter.Archived != inventory.ArchivedOnly {
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

func TestItemLifecycleAndExportRoutes(t *testing.T) {
	event := inventory.StockEvent{ID: "event-1", ItemID: "rice", Type: inventory.EventConsume, Quantity: 1, Note: "Dinner"}
	service := &fakeInventoryService{items: []inventory.Item{{ID: "rice", Name: "Rice"}}, events: []inventory.StockEvent{event}}

	tests := []struct {
		name   string
		method string
		path   string
		body   string
		want   string
	}{
		{name: "get", method: http.MethodGet, path: "/api/v1/items/rice", want: `"id":"rice"`},
		{name: "history", method: http.MethodGet, path: "/api/v1/items/rice/events", want: `"note":"Dinner"`},
		{name: "archive", method: http.MethodDelete, path: "/api/v1/items/rice", want: `"archivedAt":"2026-08-27T08:00:00Z"`},
		{name: "restore", method: http.MethodPost, path: "/api/v1/items/rice/restore", want: `"archivedAt":null`},
		{name: "export", method: http.MethodGet, path: "/api/v1/export", want: `"version":1`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			NewRouter(service, Config{}).ServeHTTP(response, httptest.NewRequest(test.method, test.path, strings.NewReader(test.body)))
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), test.want) {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
		})
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

func TestUpdateItemMetadata(t *testing.T) {
	service := &fakeInventoryService{}
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/items/soap", strings.NewReader(`{"name":"Washing-up liquid","alternativeNames":["बर्तन धोने का साबुन"],"categories":["Cleaning","Kitchen"]}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	NewRouter(service, Config{}).ServeHTTP(response, request)

	if response.Code != http.StatusOK || service.metadataID != "soap" || service.metadata.Name == nil || *service.metadata.Name != "Washing-up liquid" {
		t.Fatalf("response = %d %s, metadata = %#v", response.Code, response.Body.String(), service.metadata)
	}
	if service.metadata.AlternativeNames == nil || len(*service.metadata.AlternativeNames) != 1 || service.metadata.Categories == nil || len(*service.metadata.Categories) != 2 {
		t.Fatalf("decoded metadata = %#v", service.metadata)
	}
	if !strings.Contains(response.Body.String(), `"category":"Cleaning"`) {
		t.Fatalf("response = %s", response.Body.String())
	}
}

func TestUpdateItemMetadataRejectsUnknownJSONAndMapsErrors(t *testing.T) {
	t.Run("unknown field", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPatch, "/api/v1/items/soap", strings.NewReader(`{"quantity":4}`))
		response := httptest.NewRecorder()
		NewRouter(&fakeInventoryService{}, Config{}).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "unknown field") {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("validation", func(t *testing.T) {
		service := &fakeInventoryService{err: inventory.ValidationError{Field: "categories", Message: "choose at least one category"}}
		request := httptest.NewRequest(http.MethodPatch, "/api/v1/items/soap", strings.NewReader(`{"categories":[]}`))
		response := httptest.NewRecorder()
		NewRouter(service, Config{}).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"field":"categories"`) {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("not found", func(t *testing.T) {
		service := &fakeInventoryService{err: inventory.ErrNotFound}
		request := httptest.NewRequest(http.MethodPatch, "/api/v1/items/missing", strings.NewReader(`{"name":"Rice"}`))
		response := httptest.NewRecorder()
		NewRouter(service, Config{}).ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})
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
	if !strings.Contains(response.Header().Get("Content-Type"), "application/json") || !strings.Contains(response.Body.String(), `"code":"origin_not_allowed"`) {
		t.Fatalf("CORS error is not structured JSON: headers=%#v body=%s", response.Header(), response.Body.String())
	}
	if service.created.Name != "" {
		t.Fatalf("disallowed request reached service with input %#v", service.created)
	}
}
