package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/dhrvrm/home-os/apps/api/internal/inventory"
)

func TestRepositoryPersistsItemsAcrossReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "inventory.db")
	repository, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	want := inventory.Item{
		ID: "item-1", Name: "Dish soap", Category: "Cleaning", Location: "Kitchen",
		Unit: "bottle", TrackingMode: inventory.TrackingExact, Quantity: 2,
		StockLevel: inventory.StockOkay, MinQuantity: 1, CreatedAt: now, UpdatedAt: now,
	}
	if _, err := repository.CreateItem(ctx, want); err != nil {
		t.Fatalf("CreateItem() error = %v", err)
	}
	if err := repository.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("Open() after close error = %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	got, err := reopened.GetItem(ctx, want.ID)
	if err != nil {
		t.Fatalf("GetItem() error = %v", err)
	}
	if got.Name != want.Name || got.Category != want.Category || got.Location != want.Location || got.Quantity != want.Quantity {
		t.Fatalf("GetItem() = %#v, want %#v", got, want)
	}
}

func TestRepositoryPersistsSimpleLevelAndEventPercentages(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "inventory.db")
	repository, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	item := inventory.Item{ID: "soap", Name: "Soap", Category: "Cleaning", Location: "Kitchen", Unit: "item", TrackingMode: inventory.TrackingSimple, StockLevel: inventory.StockOkay, LevelPercent: 60, CreatedAt: now, UpdatedAt: now}
	if _, err := repository.CreateItem(ctx, item); err != nil {
		t.Fatalf("CreateItem() error = %v", err)
	}
	next := item
	next.LevelPercent = 35
	next.UpdatedAt = now.Add(time.Hour)
	event := inventory.StockEvent{ID: "event-1", ItemID: item.ID, Type: inventory.EventConsume, Quantity: 25, StockLevel: inventory.StockOkay, LevelPercent: 35, OccurredAt: next.UpdatedAt}
	if _, err := repository.ApplyEvent(ctx, event, next); err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	if err := repository.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("Open() after close error = %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	got, err := reopened.GetItem(ctx, item.ID)
	if err != nil {
		t.Fatalf("GetItem() error = %v", err)
	}
	events, err := reopened.ListEvents(ctx, item.ID, time.Time{})
	if err != nil {
		t.Fatalf("ListEvents() error = %v", err)
	}
	if got.LevelPercent != 35 || len(events) != 1 || events[0].LevelPercent != 35 {
		t.Fatalf("item = %#v events = %#v", got, events)
	}
}

func TestRepositoryPersistsAndFiltersAlternativeNamesAndCategories(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "inventory.db")
	repository, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	item := inventory.Item{
		ID: "soap", Name: "Dish soap", AlternativeNames: []string{"बर्तन धोने का साबुन", "Soap", "ÉPONGE", "ΟΣ"},
		Category: "Cleaning", Categories: []string{"Cleaning", "Kitchen"}, Location: "Kitchen sink",
		Unit: "bottle", TrackingMode: inventory.TrackingSimple, StockLevel: inventory.StockOkay,
		LevelPercent: 50, CreatedAt: now, UpdatedAt: now,
	}
	if _, err := repository.CreateItem(ctx, item); err != nil {
		t.Fatalf("CreateItem() error = %v", err)
	}
	if err := repository.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("Open() after close error = %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	got, err := reopened.GetItem(ctx, item.ID)
	if err != nil {
		t.Fatalf("GetItem() error = %v", err)
	}
	if !reflect.DeepEqual(got.AlternativeNames, item.AlternativeNames) || !reflect.DeepEqual(got.Categories, item.Categories) {
		t.Fatalf("GetItem() metadata = %#v, want %#v", got, item)
	}
	for _, filter := range []inventory.Filter{{Query: "साबुन"}, {Query: "éponge"}, {Query: "ος"}, {Category: "Kitchen"}} {
		items, err := reopened.ListItems(ctx, filter)
		if err != nil {
			t.Fatalf("ListItems(%#v) error = %v", filter, err)
		}
		if len(items) != 1 || items[0].ID != item.ID {
			t.Fatalf("ListItems(%#v) = %#v", filter, items)
		}
	}
}

func TestRepositoryReplacesItemMetadataWithoutChangingStock(t *testing.T) {
	ctx := context.Background()
	repository, err := Open(filepath.Join(t.TempDir(), "inventory.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = repository.Close() })
	created := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	item := inventory.Item{
		ID: "soap", Name: "Dish soap", AlternativeNames: []string{"Soap"}, Category: "Cleaning", Categories: []string{"Cleaning"},
		Location: "Kitchen", Unit: "bottle", TrackingMode: inventory.TrackingSimple, StockLevel: inventory.StockLow,
		LevelPercent: 25, CreatedAt: created, UpdatedAt: created,
	}
	if _, err := repository.CreateItem(ctx, item); err != nil {
		t.Fatalf("CreateItem() error = %v", err)
	}
	item.Name = "Washing-up liquid"
	item.AlternativeNames = []string{"बर्तन धोने का साबुन", "Soap"}
	item.Category = "Kitchen"
	item.Categories = []string{"Kitchen", "Cleaning"}
	item.UpdatedAt = created.Add(time.Hour)
	if _, err := repository.UpdateItemMetadata(ctx, item); err != nil {
		t.Fatalf("UpdateItemMetadata() error = %v", err)
	}

	got, err := repository.GetItem(ctx, item.ID)
	if err != nil {
		t.Fatalf("GetItem() error = %v", err)
	}
	if got.Name != item.Name || !reflect.DeepEqual(got.AlternativeNames, item.AlternativeNames) || !reflect.DeepEqual(got.Categories, item.Categories) {
		t.Fatalf("metadata = %#v, want %#v", got, item)
	}
	if got.Quantity != item.Quantity || got.StockLevel != inventory.StockLow || got.LevelPercent != 25 || got.Location != "Kitchen" || !got.CreatedAt.Equal(created) {
		t.Fatalf("stock fields changed: %#v", got)
	}
	missing := item
	missing.ID = "missing"
	if _, err := repository.UpdateItemMetadata(ctx, missing); !errors.Is(err, inventory.ErrNotFound) {
		t.Fatalf("UpdateItemMetadata(missing) error = %v, want ErrNotFound", err)
	}
}

func TestOpenMigratesLegacyPercentageColumns(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	legacySchema := `
CREATE TABLE items (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, location TEXT NOT NULL,
    unit TEXT NOT NULL, tracking_mode TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0,
    stock_level TEXT NOT NULL, min_quantity REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE stock_events (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), event_type TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0, stock_level TEXT NOT NULL, occurred_at TEXT NOT NULL
);`
	if _, err := database.Exec(legacySchema); err != nil {
		t.Fatalf("create legacy schema: %v", err)
	}
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	if _, err := database.Exec(`INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, "soap", "Soap", "Cleaning", "Kitchen", "item", "simple", 0, "low", 0, formatTime(now), formatTime(now)); err != nil {
		t.Fatalf("insert legacy item: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO stock_events VALUES (?, ?, ?, ?, ?, ?)`, "event-1", "soap", "consume", 0, "low", formatTime(now)); err != nil {
		t.Fatalf("insert legacy event: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	repository, err := Open(path)
	if err != nil {
		t.Fatalf("Open() legacy database error = %v", err)
	}
	t.Cleanup(func() { _ = repository.Close() })
	item, err := repository.GetItem(ctx, "soap")
	if err != nil {
		t.Fatalf("GetItem() error = %v", err)
	}
	events, err := repository.ListEvents(ctx, "soap", time.Time{})
	if err != nil {
		t.Fatalf("ListEvents() error = %v", err)
	}
	if item.LevelPercent != 25 || !reflect.DeepEqual(item.Categories, []string{"Cleaning"}) || len(events) != 1 || events[0].LevelPercent != 25 {
		t.Fatalf("migrated item = %#v events = %#v", item, events)
	}
}

func TestRepositoryAppliesEventAtomically(t *testing.T) {
	ctx := context.Background()
	repository, err := Open(filepath.Join(t.TempDir(), "inventory.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = repository.Close() })
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	item := inventory.Item{ID: "milk", Name: "Milk", Category: "Food", Location: "Fridge", Unit: "bottle", TrackingMode: inventory.TrackingExact, Quantity: 3, StockLevel: inventory.StockFull, MinQuantity: 1, CreatedAt: now, UpdatedAt: now}
	if _, err := repository.CreateItem(ctx, item); err != nil {
		t.Fatalf("CreateItem() error = %v", err)
	}
	next := item
	next.Quantity = 2
	next.StockLevel = inventory.StockOkay
	next.UpdatedAt = now.Add(time.Hour)
	event := inventory.StockEvent{ID: "event-1", ItemID: item.ID, Type: inventory.EventConsume, Quantity: 1, StockLevel: inventory.StockOkay, OccurredAt: next.UpdatedAt}
	if _, err := repository.ApplyEvent(ctx, event, next); err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}

	got, err := repository.GetItem(ctx, item.ID)
	if err != nil {
		t.Fatalf("GetItem() error = %v", err)
	}
	events, err := repository.ListEvents(ctx, item.ID, time.Time{})
	if err != nil {
		t.Fatalf("ListEvents() error = %v", err)
	}
	if got.Quantity != 2 || len(events) != 1 || events[0].ID != event.ID {
		t.Fatalf("state = %#v events = %#v", got, events)
	}
}

func TestRepositoryFiltersAndReturnsNotFound(t *testing.T) {
	ctx := context.Background()
	repository, err := Open(filepath.Join(t.TempDir(), "inventory.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = repository.Close() })
	now := time.Now().UTC()
	items := []inventory.Item{
		{ID: "one", Name: "Rice", Category: "Food", Location: "Pantry", Unit: "kg", TrackingMode: inventory.TrackingExact, Quantity: 2, StockLevel: inventory.StockOkay, CreatedAt: now, UpdatedAt: now},
		{ID: "two", Name: "Soap", Category: "Cleaning", Location: "Bathroom", Unit: "item", TrackingMode: inventory.TrackingSimple, StockLevel: inventory.StockLow, CreatedAt: now, UpdatedAt: now},
	}
	for _, item := range items {
		if _, err := repository.CreateItem(ctx, item); err != nil {
			t.Fatalf("CreateItem() error = %v", err)
		}
	}

	got, err := repository.ListItems(ctx, inventory.Filter{Query: "so", Category: "Cleaning", StockLevel: inventory.StockLow})
	if err != nil {
		t.Fatalf("ListItems() error = %v", err)
	}
	if len(got) != 1 || got[0].ID != "two" {
		t.Fatalf("ListItems() = %#v", got)
	}
	_, err = repository.GetItem(ctx, "missing")
	if !errors.Is(err, inventory.ErrNotFound) {
		t.Fatalf("GetItem() error = %v, want ErrNotFound", err)
	}
}

func TestRepositoryPingAndCompleteItemUpdate(t *testing.T) {
	ctx := context.Background()
	repository, err := Open(filepath.Join(t.TempDir(), "inventory.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = repository.Close() })
	if err := repository.Ping(ctx); err != nil {
		t.Fatalf("Ping() error = %v", err)
	}
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	item := inventory.Item{
		ID: "rice", Name: "Rice", Category: "Food", Categories: []string{"Food"}, Location: "Pantry", Unit: "kg",
		TrackingMode: inventory.TrackingExact, Quantity: 4, StockLevel: inventory.StockOkay, MinQuantity: 1,
		CreatedAt: now, UpdatedAt: now,
	}
	if _, err := repository.CreateItem(ctx, item); err != nil {
		t.Fatalf("CreateItem() error = %v", err)
	}
	item.Name = "Basmati rice"
	item.AlternativeNames = []string{"चावल"}
	item.Categories = []string{"Food", "Staples"}
	item.Location = "Kitchen shelf"
	item.Unit = "bag"
	item.MinQuantity = 6
	item.UpdatedAt = now.Add(time.Hour)
	if _, err := repository.UpdateItem(ctx, item); err != nil {
		t.Fatalf("UpdateItem() error = %v", err)
	}

	got, err := repository.GetItem(ctx, item.ID)
	if err != nil {
		t.Fatalf("GetItem() error = %v", err)
	}
	if got.Name != item.Name || got.Location != item.Location || got.Unit != item.Unit || got.MinQuantity != 6 || !reflect.DeepEqual(got.Categories, item.Categories) {
		t.Fatalf("updated item = %#v, want %#v", got, item)
	}
	if got.Quantity != 4 || got.StockLevel != inventory.StockOkay {
		t.Fatalf("stock changed during item update: %#v", got)
	}
}

func TestRepositoryArchiveRestoreAndHistorySurviveReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "inventory.db")
	repository, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	item := inventory.Item{ID: "soap", Name: "Soap", Category: "Cleaning", Categories: []string{"Cleaning"}, Location: "Kitchen", Unit: "item", TrackingMode: inventory.TrackingSimple, StockLevel: inventory.StockOkay, LevelPercent: 50, CreatedAt: now, UpdatedAt: now}
	if _, err := repository.CreateItem(ctx, item); err != nil {
		t.Fatalf("CreateItem() error = %v", err)
	}
	eventAt := now.Add(time.Hour)
	event := inventory.StockEvent{ID: "event-1", ItemID: item.ID, Type: inventory.EventConsume, Quantity: 25, StockLevel: inventory.StockLow, LevelPercent: 25, Note: "Weekly clean", OccurredAt: eventAt}
	next := item
	next.StockLevel = inventory.StockLow
	next.LevelPercent = 25
	next.UpdatedAt = eventAt
	if _, err := repository.ApplyEvent(ctx, event, next); err != nil {
		t.Fatalf("ApplyEvent() error = %v", err)
	}
	archiveAt := now.Add(2 * time.Hour)
	archived, err := repository.ArchiveItem(ctx, item.ID, archiveAt)
	if err != nil {
		t.Fatalf("ArchiveItem() error = %v", err)
	}
	if archived.ArchivedAt == nil || !archived.ArchivedAt.Equal(archiveAt) {
		t.Fatalf("archived item = %#v", archived)
	}
	if err := repository.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("Open() after archive error = %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	active, err := reopened.ListItems(ctx, inventory.Filter{})
	if err != nil || len(active) != 0 {
		t.Fatalf("active items = %#v, error = %v", active, err)
	}
	archivedItems, err := reopened.ListItems(ctx, inventory.Filter{Archived: inventory.ArchivedOnly})
	if err != nil || len(archivedItems) != 1 || archivedItems[0].ID != item.ID {
		t.Fatalf("archived items = %#v, error = %v", archivedItems, err)
	}
	allItems, err := reopened.ListItems(ctx, inventory.Filter{Archived: inventory.ArchivedInclude})
	if err != nil || len(allItems) != 1 {
		t.Fatalf("all items = %#v, error = %v", allItems, err)
	}
	events, err := reopened.ListEvents(ctx, item.ID, time.Time{})
	if err != nil || len(events) != 1 || events[0].Note != event.Note {
		t.Fatalf("events after reopen = %#v, error = %v", events, err)
	}
	restoredAt := archiveAt.Add(time.Hour)
	restored, err := reopened.RestoreItem(ctx, item.ID, restoredAt)
	if err != nil {
		t.Fatalf("RestoreItem() error = %v", err)
	}
	if restored.ArchivedAt != nil || !restored.UpdatedAt.Equal(restoredAt) {
		t.Fatalf("restored item = %#v", restored)
	}
}

func TestOpenMigratesArchiveAndNoteColumnsIdempotently(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy-lifecycle.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	legacySchema := `
CREATE TABLE items (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, location TEXT NOT NULL,
    unit TEXT NOT NULL, tracking_mode TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0,
    stock_level TEXT NOT NULL, level_percent REAL NOT NULL DEFAULT 0, min_quantity REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE stock_events (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), event_type TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0, stock_level TEXT NOT NULL, level_percent REAL NOT NULL DEFAULT 0,
    occurred_at TEXT NOT NULL
);`
	if _, err := database.Exec(legacySchema); err != nil {
		t.Fatalf("create legacy schema: %v", err)
	}
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	if _, err := database.Exec(`INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, "soap", "Soap", "Cleaning", "Kitchen", "item", "simple", 0, "low", 25, 0, formatTime(now), formatTime(now)); err != nil {
		t.Fatalf("insert legacy item: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO stock_events VALUES (?, ?, ?, ?, ?, ?, ?)`, "event-1", "soap", "consume", 25, "low", 25, formatTime(now)); err != nil {
		t.Fatalf("insert legacy event: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	for attempt := range 2 {
		repository, err := Open(path)
		if err != nil {
			t.Fatalf("Open() migration attempt %d error = %v", attempt+1, err)
		}
		item, err := repository.GetItem(ctx, "soap")
		if err != nil {
			t.Fatalf("GetItem() error = %v", err)
		}
		events, err := repository.ListEvents(ctx, "soap", time.Time{})
		if err != nil {
			t.Fatalf("ListEvents() error = %v", err)
		}
		if item.ArchivedAt != nil || len(events) != 1 || events[0].Note != "" {
			t.Fatalf("migrated item = %#v events = %#v", item, events)
		}
		if err := repository.Close(); err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	}
}
