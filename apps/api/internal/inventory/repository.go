package inventory

import (
	"context"
	"time"
)

type Repository interface {
	ListItems(context.Context, Filter) ([]Item, error)
	GetItem(context.Context, string) (Item, error)
	CreateItem(context.Context, Item) (Item, error)
	ApplyEvent(context.Context, StockEvent, Item) (Item, error)
	ListEvents(context.Context, string, time.Time) ([]StockEvent, error)
}
