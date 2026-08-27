package inventory

import (
	"context"
	"errors"
	"strings"
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

func (r *memoryRepository) Ping(context.Context) error { return nil }

func (r *memoryRepository) ListItems(_ context.Context, filter Filter) ([]Item, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	items := make([]Item, 0, len(r.items))
	for _, item := range r.items {
		switch filter.Archived {
		case ArchivedOnly:
			if item.ArchivedAt == nil {
				continue
			}
		case ArchivedInclude:
		default:
			if item.ArchivedAt != nil {
				continue
			}
		}
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

func (r *memoryRepository) UpdateItem(_ context.Context, item Item) (Item, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.items[item.ID]; !ok {
		return Item{}, ErrNotFound
	}
	r.items[item.ID] = item
	return item, nil
}

func (r *memoryRepository) ArchiveItem(_ context.Context, itemID string, archivedAt time.Time) (Item, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	item, ok := r.items[itemID]
	if !ok {
		return Item{}, ErrNotFound
	}
	item.ArchivedAt = &archivedAt
	item.UpdatedAt = archivedAt
	r.items[itemID] = item
	return item, nil
}

func (r *memoryRepository) RestoreItem(_ context.Context, itemID string, restoredAt time.Time) (Item, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	item, ok := r.items[itemID]
	if !ok {
		return Item{}, ErrNotFound
	}
	item.ArchivedAt = nil
	item.UpdatedAt = restoredAt
	r.items[itemID] = item
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

func TestServiceNormalizesAlternativeNamesAndCategories(t *testing.T) {
	service := NewService(newMemoryRepository(), WithIDGenerator(func() string { return "item-1" }))

	item, err := service.CreateItem(context.Background(), CreateItemInput{
		Name:             "Dish soap",
		AlternativeNames: []string{" साबुन ", "Soap", "soap", "Dish soap", ""},
		Categories:       []string{" Cleaning ", "Kitchen", "cleaning", ""},
	})
	if err != nil {
		t.Fatalf("CreateItem() error = %v", err)
	}
	if got := strings.Join(item.AlternativeNames, "|"); got != "साबुन|Soap" {
		t.Fatalf("AlternativeNames = %q", got)
	}
	if got := strings.Join(item.Categories, "|"); got != "Cleaning|Kitchen" {
		t.Fatalf("Categories = %q", got)
	}
	if item.Category != "Cleaning" {
		t.Fatalf("Category = %q, want compatibility category Cleaning", item.Category)
	}
}

func TestServiceDefaultsCategories(t *testing.T) {
	service := NewService(newMemoryRepository(), WithIDGenerator(func() string { return "item-1" }))

	item, err := service.CreateItem(context.Background(), CreateItemInput{Name: "Torch"})
	if err != nil {
		t.Fatalf("CreateItem() error = %v", err)
	}
	if len(item.Categories) != 1 || item.Categories[0] != "Other" || item.Category != "Other" {
		t.Fatalf("unexpected categories: %#v", item)
	}
}

func TestServiceRejectsInvalidAlternativeNamesAndCategories(t *testing.T) {
	service := NewService(newMemoryRepository())
	nineValues := []string{"one", "two", "three", "four", "five", "six", "seven", "eight", "nine"}
	tenValues := append(append([]string{}, nineValues...), "ten")

	if _, err := service.CreateItem(context.Background(), CreateItemInput{Name: "Soap", Categories: nineValues}); err != nil {
		t.Fatalf("CreateItem() with all nine supported categories error = %v", err)
	}

	for _, test := range []struct {
		name  string
		input CreateItemInput
		field string
	}{
		{name: "too many alternative names", input: CreateItemInput{Name: "Soap", AlternativeNames: nineValues}, field: "alternativeNames"},
		{name: "alternative name too long", input: CreateItemInput{Name: "Soap", AlternativeNames: []string{strings.Repeat("a", 121)}}, field: "alternativeNames"},
		{name: "too many categories", input: CreateItemInput{Name: "Soap", Categories: tenValues}, field: "categories"},
		{name: "category too long", input: CreateItemInput{Name: "Soap", Categories: []string{strings.Repeat("a", 61)}}, field: "categories"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.CreateItem(context.Background(), test.input)
			var validation ValidationError
			if !errors.As(err, &validation) || validation.Field != test.field {
				t.Fatalf("CreateItem() error = %#v, want field %q", err, test.field)
			}
		})
	}
}

func TestServiceUpdatesItemMetadataWithoutChangingStock(t *testing.T) {
	repo := newMemoryRepository()
	created := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	updatedAt := created.Add(24 * time.Hour)
	repo.items["soap"] = Item{
		ID: "soap", Name: "Dish soap", AlternativeNames: []string{"Soap"}, Category: "Cleaning",
		Categories: []string{"Cleaning"}, Location: "Kitchen", Unit: "bottle", TrackingMode: TrackingSimple,
		StockLevel: StockLow, LevelPercent: 25, CreatedAt: created, UpdatedAt: created,
	}
	service := NewService(repo, WithClock(func() time.Time { return updatedAt }))
	name := "Washing-up liquid"
	aliases := []string{" बर्तन धोने का साबुन ", "Soap", "soap", name}
	categories := []string{" Kitchen ", "Cleaning", "kitchen"}

	item, err := service.UpdateItemMetadata(context.Background(), "soap", UpdateItemMetadataInput{
		Name: &name, AlternativeNames: &aliases, Categories: &categories,
	})
	if err != nil {
		t.Fatalf("UpdateItemMetadata() error = %v", err)
	}
	if item.Name != name || strings.Join(item.AlternativeNames, "|") != "बर्तन धोने का साबुन|Soap" {
		t.Fatalf("unexpected names: %#v", item)
	}
	if strings.Join(item.Categories, "|") != "Kitchen|Cleaning" || item.Category != "Kitchen" {
		t.Fatalf("unexpected categories: %#v", item)
	}
	if item.StockLevel != StockLow || item.LevelPercent != 25 || item.Unit != "bottle" || !item.UpdatedAt.Equal(updatedAt) {
		t.Fatalf("stock metadata changed: %#v", item)
	}
}

func TestServiceMetadataUpdateKeepsOmittedFieldsAndAllowsEmptyAliases(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["rice"] = Item{ID: "rice", Name: "Rice", AlternativeNames: []string{"चावल"}, Category: "Food", Categories: []string{"Food", "Kitchen"}}
	service := NewService(repo)
	emptyAliases := []string{}

	item, err := service.UpdateItemMetadata(context.Background(), "rice", UpdateItemMetadataInput{AlternativeNames: &emptyAliases})
	if err != nil {
		t.Fatalf("UpdateItemMetadata() error = %v", err)
	}
	if item.Name != "Rice" || len(item.AlternativeNames) != 0 || strings.Join(item.Categories, "|") != "Food|Kitchen" {
		t.Fatalf("unexpected metadata: %#v", item)
	}
}

func TestServiceRejectsInvalidMetadataUpdate(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["rice"] = Item{ID: "rice", Name: "Rice", Category: "Food", Categories: []string{"Food"}}
	service := NewService(repo)
	blank := "  "
	emptyCategories := []string{}

	for _, test := range []struct {
		name  string
		input UpdateItemMetadataInput
		field string
	}{
		{name: "blank name", input: UpdateItemMetadataInput{Name: &blank}, field: "name"},
		{name: "empty categories", input: UpdateItemMetadataInput{Categories: &emptyCategories}, field: "categories"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.UpdateItemMetadata(context.Background(), "rice", test.input)
			var validation ValidationError
			if !errors.As(err, &validation) || validation.Field != test.field {
				t.Fatalf("UpdateItemMetadata() error = %#v, want field %q", err, test.field)
			}
		})
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

func TestServiceRestocksExactItemToDerivedLevel(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["rice"] = Item{ID: "rice", Name: "Rice", TrackingMode: TrackingExact, Quantity: 0, MinQuantity: 1, StockLevel: StockOut, Unit: "kg"}
	service := NewService(repo, WithIDGenerator(func() string { return "event-1" }))

	item, err := service.ApplyEvent(context.Background(), "rice", ApplyEventInput{Type: EventRestock, Quantity: 5})
	if err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	if item.Quantity != 5 || item.StockLevel != StockOkay {
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

func TestServiceRejectsOversizedCoreFieldsOnCreate(t *testing.T) {
	service := NewService(newMemoryRepository())
	for _, test := range []struct {
		name  string
		input CreateItemInput
		field string
	}{
		{name: "name", input: CreateItemInput{Name: strings.Repeat("界", 121)}, field: "name"},
		{name: "location", input: CreateItemInput{Name: "Rice", Location: strings.Repeat("界", 81)}, field: "location"},
		{name: "unit", input: CreateItemInput{Name: "Rice", Unit: strings.Repeat("界", 31)}, field: "unit"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.CreateItem(context.Background(), test.input)
			var validation ValidationError
			if !errors.As(err, &validation) || validation.Field != test.field {
				t.Fatalf("CreateItem() error = %#v, want field %q", err, test.field)
			}
		})
	}
}

func TestServiceUpdatesCompleteItemWithoutChangingStock(t *testing.T) {
	repo := newMemoryRepository()
	created := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	updatedAt := created.Add(time.Hour)
	repo.items["rice"] = Item{
		ID: "rice", Name: "Rice", Category: "Food", Categories: []string{"Food"}, Location: "Pantry",
		Unit: "kg", TrackingMode: TrackingExact, Quantity: 4, StockLevel: StockOkay, LevelPercent: 0,
		MinQuantity: 1, CreatedAt: created, UpdatedAt: created,
	}
	service := NewService(repo, WithClock(func() time.Time { return updatedAt }))
	name := "Basmati rice"
	aliases := []string{"चावल"}
	categories := []string{"Food", "Staples"}
	location := "Kitchen shelf"
	unit := "bag"
	minimum := 6.0

	item, err := service.UpdateItem(context.Background(), "rice", UpdateItemInput{
		Name: &name, AlternativeNames: &aliases, Categories: &categories, Location: &location, Unit: &unit, MinQuantity: &minimum,
	})
	if err != nil {
		t.Fatalf("UpdateItem() error = %v", err)
	}
	if item.Name != name || item.Location != location || item.Unit != unit || item.MinQuantity != minimum {
		t.Fatalf("metadata was not updated: %#v", item)
	}
	if item.Quantity != 4 || item.StockLevel != StockOkay || item.LevelPercent != 0 {
		t.Fatalf("stock changed outside an event: %#v", item)
	}
	if !item.UpdatedAt.Equal(updatedAt) || !item.CreatedAt.Equal(created) {
		t.Fatalf("unexpected timestamps: %#v", item)
	}
}

func TestServiceRejectsInvalidCompleteItemUpdate(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["rice"] = Item{ID: "rice", Name: "Rice", Category: "Food", Categories: []string{"Food"}, Location: "Pantry", Unit: "kg"}
	service := NewService(repo)
	negative := -1.0

	for _, test := range []struct {
		name  string
		input UpdateItemInput
		field string
	}{
		{name: "name", input: UpdateItemInput{Name: stringPointer(strings.Repeat("界", 121))}, field: "name"},
		{name: "location", input: UpdateItemInput{Location: stringPointer(strings.Repeat("界", 81))}, field: "location"},
		{name: "unit", input: UpdateItemInput{Unit: stringPointer(strings.Repeat("界", 31))}, field: "unit"},
		{name: "minimum", input: UpdateItemInput{MinQuantity: &negative}, field: "minQuantity"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.UpdateItem(context.Background(), "rice", test.input)
			var validation ValidationError
			if !errors.As(err, &validation) || validation.Field != test.field {
				t.Fatalf("UpdateItem() error = %#v, want field %q", err, test.field)
			}
		})
	}
}

func TestServiceExactRestockDerivesStateFromResultingQuantity(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["rice"] = Item{ID: "rice", Name: "Rice", TrackingMode: TrackingExact, Quantity: 0, MinQuantity: 10, StockLevel: StockOut}
	service := NewService(repo, WithIDGenerator(func() string { return "event-1" }))

	item, err := service.ApplyEvent(context.Background(), "rice", ApplyEventInput{Type: EventRestock, Quantity: 1})
	if err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	if item.Quantity != 1 || item.StockLevel != StockLow {
		t.Fatalf("restocked item = %#v, want quantity 1 and low", item)
	}
}

func TestServiceExactOverConsumptionRecordsActualAvailableQuantity(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["milk"] = Item{ID: "milk", Name: "Milk", TrackingMode: TrackingExact, Quantity: 3, MinQuantity: 1, StockLevel: StockOkay}
	service := NewService(repo, WithIDGenerator(func() string { return "event-1" }))

	item, err := service.ApplyEvent(context.Background(), "milk", ApplyEventInput{Type: EventConsume, Quantity: 8, Note: "Used for guests"})
	if err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	if item.Quantity != 0 || item.StockLevel != StockOut {
		t.Fatalf("consumed item = %#v", item)
	}
	events := repo.events["milk"]
	if len(events) != 1 || events[0].Quantity != 3 || events[0].Note != "Used for guests" {
		t.Fatalf("events = %#v, want actual quantity 3 with note", events)
	}
}

func TestServiceValidatesEventNoteLength(t *testing.T) {
	repo := newMemoryRepository()
	repo.items["soap"] = Item{ID: "soap", Name: "Soap", TrackingMode: TrackingSimple, LevelPercent: 50, StockLevel: StockOkay}
	service := NewService(repo)

	_, err := service.ApplyEvent(context.Background(), "soap", ApplyEventInput{Type: EventConsume, Note: strings.Repeat("界", 241)})
	var validation ValidationError
	if !errors.As(err, &validation) || validation.Field != "note" {
		t.Fatalf("ApplyEvent() error = %#v, want note validation", err)
	}
	if len(repo.events["soap"]) != 0 {
		t.Fatalf("invalid note recorded events: %#v", repo.events["soap"])
	}
}

func TestServiceArchivesAndRestoresWithoutLosingHistory(t *testing.T) {
	repo := newMemoryRepository()
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	repo.items["soap"] = Item{ID: "soap", Name: "Soap", Category: "Cleaning", Categories: []string{"Cleaning"}, TrackingMode: TrackingSimple, LevelPercent: 50, StockLevel: StockOkay}
	repo.events["soap"] = []StockEvent{{ID: "event-1", ItemID: "soap", Type: EventConsume, Quantity: 25, OccurredAt: now.Add(-time.Hour)}}
	service := NewService(repo, WithClock(func() time.Time { return now }))

	archived, err := service.ArchiveItem(context.Background(), "soap")
	if err != nil {
		t.Fatalf("ArchiveItem() error = %v", err)
	}
	if archived.ArchivedAt == nil || !archived.ArchivedAt.Equal(now) {
		t.Fatalf("archived item = %#v", archived)
	}
	active, err := service.ListItems(context.Background(), Filter{})
	if err != nil || len(active) != 0 {
		t.Fatalf("active items = %#v, error = %v", active, err)
	}
	archivedItems, err := service.ListItems(context.Background(), Filter{Archived: ArchivedOnly})
	if err != nil || len(archivedItems) != 1 {
		t.Fatalf("archived items = %#v, error = %v", archivedItems, err)
	}
	events, err := service.ListEvents(context.Background(), "soap", time.Time{})
	if err != nil || len(events) != 1 || events[0].ID != "event-1" {
		t.Fatalf("events after archive = %#v, error = %v", events, err)
	}
	restored, err := service.RestoreItem(context.Background(), "soap")
	if err != nil {
		t.Fatalf("RestoreItem() error = %v", err)
	}
	if restored.ArchivedAt != nil {
		t.Fatalf("restored item = %#v", restored)
	}
}

func stringPointer(value string) *string { return &value }
