package inventory

import (
	"context"
	"time"
)

type Repository interface {
	Ping(context.Context) error
	ListItems(context.Context, Filter) ([]Item, error)
	GetItem(context.Context, string) (Item, error)
	CreateItem(context.Context, Item) (Item, error)
	UpdateItem(context.Context, Item) (Item, error)
	ArchiveItem(context.Context, string, time.Time) (Item, error)
	RestoreItem(context.Context, string, time.Time) (Item, error)
	ApplyEvent(context.Context, StockEvent, Item) (Item, error)
	ListEvents(context.Context, string, time.Time) ([]StockEvent, error)
}
