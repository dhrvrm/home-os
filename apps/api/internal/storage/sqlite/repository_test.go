package sqlite

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/sw-dhruv/home-os/apps/api/internal/inventory"
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
