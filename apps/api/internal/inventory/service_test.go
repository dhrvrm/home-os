package inventory

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type memoryRepository struct {
	mu        sync.Mutex
	items     map[string]Item
	events    map[string][]StockEvent
	readDelay time.Duration
}

func newMemoryRepository() *memoryRepository {
	return &memoryRepository{items: make(map[string]Item), events: make(map[string][]StockEvent)}
}

func (r *memoryRepository) ListItems(_ context.Context, filter Filter) ([]Item, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	items := make([]Item, 0, len(r.items))
	for _, item := range r.items {
		if filter.Category != "" && item.Category != filter.Category {
			continue
		}
		items = append(items, item)
	}
	return items, nil
}

func (r *memoryRepository) GetItem(_ context.Context, id string) (Item, error) {
	r.mu.Lock()
	item, ok := r.items[id]
	r.mu.Unlock()
	if r.readDelay > 0 {
		time.Sleep(r.readDelay)
	}
	if !ok {
		return Item{}, ErrNotFound
	}
	return item, nil
}

func (r *memoryRepository) CreateItem(_ context.Context, item Item) (Item, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[item.ID] = item
	return item, nil
}

func (r *memoryRepository) ApplyEvent(_ context.Context, event StockEvent, next Item) (Item, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[next.ID] = next
	r.events[next.ID] = append(r.events[next.ID], event)
	return next, nil
}

func (r *memoryRepository) ListEvents(_ context.Context, itemID string, _ time.Time) ([]StockEvent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]StockEvent(nil), r.events[itemID]...), nil
}

func TestServiceCreatesItemWithSafeDefaults(t *testing.T) {
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	service := NewService(newMemoryRepository(), WithClock(func() time.Time { return now }), WithIDGenerator(func() string { return "item-1" }))

	item, err := service.CreateItem(context.Background(), CreateItemInput{Name: "  Dish soap  ", Category: "Cleaning", Location: "Kitchen"})
	if err != nil {
		t.Fatalf("CreateItem() error = %v", err)
	}
	if item.ID != "item-1" || item.Name != "Dish soap" {
		t.Fatalf("unexpected identity: %#v", item)
	}
	if item.TrackingMode != TrackingSimple || item.StockLevel != StockOkay || item.LevelPercent != 50 || item.Unit != "item" {
		t.Fatalf("unexpected defaults: %#v", item)
	}
	if !item.CreatedAt.Equal(now) || !item.UpdatedAt.Equal(now) {
		t.Fatalf("unexpected timestamps: %#v", item)
	}
}

func TestServiceRejectsBlankName(t *testing.T) {
	service := NewService(newMemoryRepository())
	_, err := service.CreateItem(context.Background(), CreateItemInput{Name: "  "})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("CreateItem() error = %v, want ErrInvalid", err)
	}
}

func TestServiceConsumesExactStockAndMarksLow(t *testing.T) {
	repo := newMemoryRepository()
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	repo.items["milk"] = Item{ID: "milk", Name: "Milk", TrackingMode: TrackingExact, Quantity: 3, MinQuantity: 1, StockLevel: StockFull, Unit: "bottle", CreatedAt: now, UpdatedAt: now}
	service := NewService(repo, WithClock(func() time.Time { return now.Add(time.Hour) }), WithIDGenerator(func() string { return "event-1" }))

	item, err := service.ApplyEvent(context.Background(), "milk", ApplyEventInput{Type: EventConsume, Quantity: 2})
	if err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	if item.Quantity != 1 || item.StockLevel != StockLow {
		t.Fatalf("unexpected stock: %#v", item)
	}
}

func TestServiceAdvancesSimpleStockWithoutQuantityBookkeeping(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["soap"] = Item{ID: "soap", Name: "Soap", TrackingMode: TrackingSimple, StockLevel: StockOkay, LevelPercent: 50, Unit: "item"}
	service := NewService(repo, WithIDGenerator(func() string { return "event-1" }))

	item, err := service.ApplyEvent(context.Background(), "soap", ApplyEventInput{Type: EventConsume})
	if err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	if item.LevelPercent != 25 || item.StockLevel != StockLow {
		t.Fatalf("unexpected stock: %#v", item)
	}
}

func TestServiceUsesExplicitSimpleConsumptionPoints(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["soap"] = Item{ID: "soap", Name: "Soap", TrackingMode: TrackingSimple, StockLevel: StockFull, LevelPercent: 90, Unit: "item"}
	service := NewService(repo, WithIDGenerator(func() string { return "event-1" }))

	item, err := service.ApplyEvent(context.Background(), "soap", ApplyEventInput{Type: EventConsume, Quantity: 15})
	if err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	if item.LevelPercent != 75 || item.StockLevel != StockOkay {
		t.Fatalf("unexpected stock: %#v", item)
	}
}

func TestServiceRestocksSimpleLevelToOneHundred(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["soap"] = Item{ID: "soap", Name: "Soap", TrackingMode: TrackingSimple, StockLevel: StockLow, LevelPercent: 10, Unit: "item"}
	service := NewService(repo, WithIDGenerator(func() string { return "event-1" }))

	item, err := service.ApplyEvent(context.Background(), "soap", ApplyEventInput{Type: EventRestock})
	if err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	if item.LevelPercent != 100 || item.StockLevel != StockFull {
		t.Fatalf("unexpected stock: %#v", item)
	}
}

func TestServiceMarksSimpleLevelAndAcceptsZero(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["soap"] = Item{ID: "soap", Name: "Soap", TrackingMode: TrackingSimple, StockLevel: StockOkay, LevelPercent: 50, Unit: "item"}
	service := NewService(repo, WithIDGenerator(func() string { return "event-1" }))
	zero := 0.0

	item, err := service.ApplyEvent(context.Background(), "soap", ApplyEventInput{Type: EventMarkLevel, LevelPercent: &zero})
	if err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	if item.LevelPercent != 0 || item.StockLevel != StockOut {
		t.Fatalf("unexpected stock: %#v", item)
	}
}

func TestServiceRejectsSimpleLevelOutsideRange(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["soap"] = Item{ID: "soap", Name: "Soap", TrackingMode: TrackingSimple, StockLevel: StockOkay, LevelPercent: 50, Unit: "item"}
	service := NewService(repo)
	overfull := 101.0

	_, err := service.ApplyEvent(context.Background(), "soap", ApplyEventInput{Type: EventMarkLevel, LevelPercent: &overfull})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("ApplyEvent() error = %v, want ErrInvalid", err)
	}
}

func TestServiceRestocksItem(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["rice"] = Item{ID: "rice", Name: "Rice", TrackingMode: TrackingExact, Quantity: 0, MinQuantity: 1, StockLevel: StockOut, Unit: "kg"}
	service := NewService(repo, WithIDGenerator(func() string { return "event-1" }))

	item, err := service.ApplyEvent(context.Background(), "rice", ApplyEventInput{Type: EventRestock, Quantity: 5})
	if err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	if item.Quantity != 5 || item.StockLevel != StockFull {
		t.Fatalf("unexpected stock: %#v", item)
	}
}

func TestServiceSerializesConcurrentStockEvents(t *testing.T) {
	repo := newMemoryRepository()
	repo.readDelay = 2 * time.Millisecond
	repo.items["rice"] = Item{ID: "rice", Name: "Rice", TrackingMode: TrackingExact, Quantity: 20, MinQuantity: 2, StockLevel: StockFull, Unit: "cup"}
	service := NewService(repo)

	var wait sync.WaitGroup
	errors := make(chan error, 20)
	for range 20 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := service.ApplyEvent(context.Background(), "rice", ApplyEventInput{Type: EventConsume, Quantity: 1})
			errors <- err
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("ApplyEvent() error = %v", err)
		}
	}

	item, err := repo.GetItem(context.Background(), "rice")
	if err != nil {
		t.Fatalf("GetItem() error = %v", err)
	}
	if item.Quantity != 0 || item.StockLevel != StockOut {
		t.Fatalf("unexpected stock after concurrent events: %#v", item)
	}
}

func TestForecastUsesRecentExactConsumption(t *testing.T) {
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	item := Item{ID: "coffee", TrackingMode: TrackingExact, Quantity: 6, Unit: "scoop"}
	events := []StockEvent{
		{Type: EventConsume, Quantity: 2, OccurredAt: now.Add(-4 * 24 * time.Hour)},
		{Type: EventConsume, Quantity: 2, OccurredAt: now.Add(-2 * 24 * time.Hour)},
	}

	forecast := CalculateForecast(item, events, now)
	if forecast == nil {
		t.Fatal("CalculateForecast() = nil")
	}
	if forecast.DailyUsage != 1 || forecast.DaysRemaining != 6 || forecast.Confidence != ConfidenceLow {
		t.Fatalf("unexpected forecast: %#v", forecast)
	}
}

func TestCalculateCadenceNeedsTwoConsumptionEvents(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	events := []StockEvent{{Type: EventConsume, OccurredAt: now.Add(-2 * 24 * time.Hour)}}
	if cadence := CalculateCadence(events, now); cadence != nil {
		t.Fatalf("CalculateCadence() = %#v, want nil", cadence)
	}
}

func TestCalculateCadenceUsesIntervalsBetweenSortedEvents(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	events := []StockEvent{
		{Type: EventConsume, OccurredAt: now.Add(-2 * 24 * time.Hour)},
		{Type: EventRestock, OccurredAt: now.Add(-3 * 24 * time.Hour)},
		{Type: EventConsume, OccurredAt: now.Add(24 * time.Hour)},
		{Type: EventConsume, OccurredAt: now.Add(-10 * 24 * time.Hour)},
		{Type: EventConsume, OccurredAt: now.Add(-6 * 24 * time.Hour)},
	}

	cadence := CalculateCadence(events, now)
	if cadence == nil {
		t.Fatal("CalculateCadence() = nil")
	}
	if cadence.AverageIntervalDays != 4 || cadence.EventsPerWeek != 1.8 || cadence.Confidence != ConfidenceLow {
		t.Fatalf("unexpected cadence: %#v", cadence)
	}
	if !cadence.LastConsumedAt.Equal(now.Add(-2 * 24 * time.Hour)) {
		t.Fatalf("LastConsumedAt = %v", cadence.LastConsumedAt)
	}
}

func TestCalculateCadenceConfidenceIncreasesWithSamples(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name       string
		count      int
		confidence Confidence
	}{
		{name: "medium", count: 4, confidence: ConfidenceMedium},
		{name: "high", count: 8, confidence: ConfidenceHigh},
	} {
		t.Run(test.name, func(t *testing.T) {
			events := make([]StockEvent, 0, test.count)
			for index := range test.count {
				events = append(events, StockEvent{Type: EventConsume, OccurredAt: now.Add(-time.Duration(test.count-index) * 24 * time.Hour)})
			}
			cadence := CalculateCadence(events, now)
			if cadence == nil || cadence.Confidence != test.confidence {
				t.Fatalf("CalculateCadence() = %#v, want confidence %q", cadence, test.confidence)
			}
		})
	}
}
