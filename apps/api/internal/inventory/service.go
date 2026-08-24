package inventory

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"math"
	"strings"
	"sync"
	"time"
)

type Service struct {
	repository Repository
	now        func() time.Time
	newID      func() string
	mutationMu sync.Mutex
}

type ServiceOption func(*Service)

func WithClock(now func() time.Time) ServiceOption {
	return func(service *Service) { service.now = now }
}

func WithIDGenerator(generator func() string) ServiceOption {
	return func(service *Service) { service.newID = generator }
}

func NewService(repository Repository, options ...ServiceOption) *Service {
	service := &Service{
		repository: repository,
		now:        func() time.Time { return time.Now().UTC() },
		newID:      randomID,
	}
	for _, option := range options {
		option(service)
	}
	return service
}

func (s *Service) ListItems(ctx context.Context, filter Filter) ([]Item, error) {
	items, err := s.repository.ListItems(ctx, filter)
	if err != nil {
		return nil, err
	}

	now := s.now()
	for index := range items {
		events, eventErr := s.repository.ListEvents(ctx, items[index].ID, now.Add(-90*24*time.Hour))
		if eventErr != nil {
			return nil, eventErr
		}
		items[index].Forecast = CalculateForecast(items[index], events, now)
	}
	return items, nil
}

func (s *Service) GetItem(ctx context.Context, id string) (Item, error) {
	item, err := s.repository.GetItem(ctx, strings.TrimSpace(id))
	if err != nil {
		return Item{}, err
	}
	events, err := s.repository.ListEvents(ctx, item.ID, s.now().Add(-90*24*time.Hour))
	if err != nil {
		return Item{}, err
	}
	item.Forecast = CalculateForecast(item, events, s.now())
	return item, nil
}

func (s *Service) CreateItem(ctx context.Context, input CreateItemInput) (Item, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return Item{}, ValidationError{Field: "name", Message: "enter an item name"}
	}
	if input.Quantity < 0 {
		return Item{}, ValidationError{Field: "quantity", Message: "must be zero or greater"}
	}
	if input.MinQuantity < 0 {
		return Item{}, ValidationError{Field: "minQuantity", Message: "must be zero or greater"}
	}

	mode := input.TrackingMode
	if mode == "" {
		mode = TrackingSimple
	}
	if !mode.Valid() {
		return Item{}, ValidationError{Field: "trackingMode", Message: "must be simple or exact"}
	}

	level := input.StockLevel
	if level == "" {
		if mode == TrackingExact {
			level = exactLevel(input.Quantity, input.MinQuantity)
		} else {
			level = StockOkay
		}
	}
	if !level.Valid() {
		return Item{}, ValidationError{Field: "stockLevel", Message: "must be full, okay, low, or out"}
	}

	unit := strings.TrimSpace(input.Unit)
	if unit == "" {
		unit = "item"
	}
	now := s.now()
	item := Item{
		ID:           s.newID(),
		Name:         name,
		Category:     fallback(strings.TrimSpace(input.Category), "Other"),
		Location:     fallback(strings.TrimSpace(input.Location), "Unassigned"),
		Unit:         unit,
		TrackingMode: mode,
		Quantity:     input.Quantity,
		StockLevel:   level,
		MinQuantity:  input.MinQuantity,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	return s.repository.CreateItem(ctx, item)
}

func (s *Service) ApplyEvent(ctx context.Context, itemID string, input ApplyEventInput) (Item, error) {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()

	if !input.Type.Valid() {
		return Item{}, ValidationError{Field: "type", Message: "must be consume, restock, or mark_level"}
	}
	item, err := s.repository.GetItem(ctx, strings.TrimSpace(itemID))
	if err != nil {
		return Item{}, err
	}

	next := item
	switch input.Type {
	case EventConsume:
		if item.TrackingMode == TrackingExact {
			if input.Quantity <= 0 {
				return Item{}, ValidationError{Field: "quantity", Message: "must be greater than zero"}
			}
			next.Quantity = math.Max(0, item.Quantity-input.Quantity)
			next.StockLevel = exactLevel(next.Quantity, item.MinQuantity)
		} else {
			next.StockLevel = nextSimpleLevel(item.StockLevel)
		}
	case EventRestock:
		if item.TrackingMode == TrackingExact {
			if input.Quantity <= 0 {
				return Item{}, ValidationError{Field: "quantity", Message: "must be greater than zero"}
			}
			next.Quantity += input.Quantity
		}
		next.StockLevel = StockFull
	case EventMarkLevel:
		if !input.StockLevel.Valid() {
			return Item{}, ValidationError{Field: "stockLevel", Message: "must be full, okay, low, or out"}
		}
		next.StockLevel = input.StockLevel
		if item.TrackingMode == TrackingExact && input.StockLevel == StockOut {
			next.Quantity = 0
		}
	}

	now := s.now()
	next.UpdatedAt = now
	event := StockEvent{
		ID:         s.newID(),
		ItemID:     item.ID,
		Type:       input.Type,
		Quantity:   input.Quantity,
		StockLevel: next.StockLevel,
		OccurredAt: now,
	}
	updated, err := s.repository.ApplyEvent(ctx, event, next)
	if err != nil {
		return Item{}, err
	}
	events, err := s.repository.ListEvents(ctx, item.ID, now.Add(-90*24*time.Hour))
	if err != nil {
		return Item{}, err
	}
	updated.Forecast = CalculateForecast(updated, events, now)
	return updated, nil
}

func CalculateForecast(item Item, events []StockEvent, now time.Time) *Forecast {
	if item.TrackingMode != TrackingExact || item.Quantity <= 0 {
		return nil
	}
	var total float64
	var earliest time.Time
	count := 0
	for _, event := range events {
		if event.Type != EventConsume || event.Quantity <= 0 || event.OccurredAt.After(now) {
			continue
		}
		total += event.Quantity
		count++
		if earliest.IsZero() || event.OccurredAt.Before(earliest) {
			earliest = event.OccurredAt
		}
	}
	if count < 2 || total <= 0 {
		return nil
	}
	days := now.Sub(earliest).Hours() / 24
	if days < 1 {
		days = 1
	}
	dailyUsage := total / days
	if dailyUsage <= 0 {
		return nil
	}
	confidence := ConfidenceLow
	if count >= 8 {
		confidence = ConfidenceHigh
	} else if count >= 4 {
		confidence = ConfidenceMedium
	}
	return &Forecast{
		DailyUsage:    roundOne(dailyUsage),
		DaysRemaining: roundOne(item.Quantity / dailyUsage),
		Confidence:    confidence,
	}
}

func exactLevel(quantity, minimum float64) StockLevel {
	if quantity <= 0 {
		return StockOut
	}
	if quantity <= minimum {
		return StockLow
	}
	return StockOkay
}

func nextSimpleLevel(level StockLevel) StockLevel {
	switch level {
	case StockFull:
		return StockOkay
	case StockOkay:
		return StockLow
	default:
		return StockOut
	}
}

func fallback(value, defaultValue string) string {
	if value == "" {
		return defaultValue
	}
	return value
}

func roundOne(value float64) float64 { return math.Round(value*10) / 10 }

func randomID() string {
	bytes := make([]byte, 12)
	if _, err := rand.Read(bytes); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(bytes)
}
