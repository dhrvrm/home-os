package inventory

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"math"
	"sort"
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
		enrichItem(&items[index], events, now)
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
	enrichItem(&item, events, s.now())
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
	if level != "" && !level.Valid() {
		return Item{}, ValidationError{Field: "stockLevel", Message: "must be full, okay, low, or out"}
	}
	levelPercent := 0.0
	if mode == TrackingExact {
		level = exactLevel(input.Quantity, input.MinQuantity)
	} else {
		if input.LevelPercent != nil {
			levelPercent = *input.LevelPercent
		} else if level.Valid() {
			levelPercent = percentForLevel(level)
		} else {
			levelPercent = 50
		}
		if !validPercent(levelPercent) {
			return Item{}, ValidationError{Field: "levelPercent", Message: "must be between zero and 100"}
		}
		level = simpleLevel(levelPercent)
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
		LevelPercent: levelPercent,
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
			points := input.Quantity
			if points == 0 {
				points = 25
			}
			if points < 0 {
				return Item{}, ValidationError{Field: "quantity", Message: "must be zero or greater"}
			}
			next.LevelPercent = math.Max(0, item.LevelPercent-points)
			next.StockLevel = simpleLevel(next.LevelPercent)
		}
	case EventRestock:
		if item.TrackingMode == TrackingExact {
			if input.Quantity <= 0 {
				return Item{}, ValidationError{Field: "quantity", Message: "must be greater than zero"}
			}
			next.Quantity += input.Quantity
		} else {
			next.LevelPercent = 100
		}
		next.StockLevel = StockFull
	case EventMarkLevel:
		if item.TrackingMode == TrackingSimple {
			if input.LevelPercent == nil || !validPercent(*input.LevelPercent) {
				return Item{}, ValidationError{Field: "levelPercent", Message: "must be between zero and 100"}
			}
			next.LevelPercent = *input.LevelPercent
			next.StockLevel = simpleLevel(next.LevelPercent)
		} else {
			if !input.StockLevel.Valid() {
				return Item{}, ValidationError{Field: "stockLevel", Message: "must be full, okay, low, or out"}
			}
			next.StockLevel = input.StockLevel
			if input.StockLevel == StockOut {
				next.Quantity = 0
			}
		}
	}

	now := s.now()
	next.UpdatedAt = now
	event := StockEvent{
		ID:           s.newID(),
		ItemID:       item.ID,
		Type:         input.Type,
		Quantity:     input.Quantity,
		StockLevel:   next.StockLevel,
		LevelPercent: next.LevelPercent,
		OccurredAt:   now,
	}
	updated, err := s.repository.ApplyEvent(ctx, event, next)
	if err != nil {
		return Item{}, err
	}
	events, err := s.repository.ListEvents(ctx, item.ID, now.Add(-90*24*time.Hour))
	if err != nil {
		return Item{}, err
	}
	enrichItem(&updated, events, now)
	return updated, nil
}

func enrichItem(item *Item, events []StockEvent, now time.Time) {
	item.Forecast = CalculateForecast(*item, events, now)
	item.Cadence = CalculateCadence(events, now)
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
	return &Forecast{
		DailyUsage:    roundOne(dailyUsage),
		DaysRemaining: roundOne(item.Quantity / dailyUsage),
		Confidence:    confidenceFor(count),
	}
}

func CalculateCadence(events []StockEvent, now time.Time) *Cadence {
	timestamps := make([]time.Time, 0, len(events))
	for _, event := range events {
		if event.Type == EventConsume && !event.OccurredAt.After(now) {
			timestamps = append(timestamps, event.OccurredAt)
		}
	}
	if len(timestamps) < 2 {
		return nil
	}
	sort.Slice(timestamps, func(left, right int) bool { return timestamps[left].Before(timestamps[right]) })
	spanDays := timestamps[len(timestamps)-1].Sub(timestamps[0]).Hours() / 24
	if spanDays <= 0 {
		return nil
	}
	averageInterval := spanDays / float64(len(timestamps)-1)
	return &Cadence{
		AverageIntervalDays: roundOne(averageInterval),
		EventsPerWeek:       roundOne(7 / averageInterval),
		LastConsumedAt:      timestamps[len(timestamps)-1],
		Confidence:          confidenceFor(len(timestamps)),
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

func simpleLevel(percent float64) StockLevel {
	switch {
	case percent <= 0:
		return StockOut
	case percent <= 25:
		return StockLow
	case percent <= 75:
		return StockOkay
	default:
		return StockFull
	}
}

func validPercent(percent float64) bool { return percent >= 0 && percent <= 100 }

func percentForLevel(level StockLevel) float64 {
	switch level {
	case StockFull:
		return 100
	case StockLow:
		return 25
	case StockOut:
		return 0
	default:
		return 50
	}
}

func confidenceFor(count int) Confidence {
	if count >= 8 {
		return ConfidenceHigh
	}
	if count >= 4 {
		return ConfidenceMedium
	}
	return ConfidenceLow
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
