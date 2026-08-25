package sqlite

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sw-dhruv/home-os/apps/api/internal/inventory"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

type Repository struct {
	db *sql.DB
}

func Open(path string) (*Repository, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("sqlite path is required")
	}
	if path != ":memory:" && !strings.HasPrefix(path, "file:") {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create sqlite directory: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("configure sqlite: %w", err)
	}
	if path != ":memory:" {
		if _, err := db.Exec("PRAGMA journal_mode = WAL;"); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("enable sqlite WAL: %w", err)
		}
	}
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate sqlite: %w", err)
	}
	if err := migratePercentages(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Repository{db: db}, nil
}

func (r *Repository) Close() error { return r.db.Close() }

func (r *Repository) ListItems(ctx context.Context, filter inventory.Filter) ([]inventory.Item, error) {
	query := `SELECT id, name, category, location, unit, tracking_mode, quantity, stock_level, level_percent, min_quantity, created_at, updated_at FROM items WHERE 1 = 1`
	args := make([]any, 0, 3)
	if value := strings.TrimSpace(filter.Query); value != "" {
		query += " AND (LOWER(name) LIKE LOWER(?) OR LOWER(category) LIKE LOWER(?) OR LOWER(location) LIKE LOWER(?))"
		like := "%" + value + "%"
		args = append(args, like, like, like)
	}
	if value := strings.TrimSpace(filter.Category); value != "" {
		query += " AND category = ?"
		args = append(args, value)
	}
	if filter.StockLevel != "" {
		query += " AND stock_level = ?"
		args = append(args, filter.StockLevel)
	}
	query += " ORDER BY CASE stock_level WHEN 'out' THEN 0 WHEN 'low' THEN 1 WHEN 'okay' THEN 2 ELSE 3 END, LOWER(name)"

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list inventory items: %w", err)
	}
	defer rows.Close()
	items := make([]inventory.Item, 0)
	for rows.Next() {
		item, scanErr := scanItem(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate inventory items: %w", err)
	}
	return items, nil
}

func (r *Repository) GetItem(ctx context.Context, id string) (inventory.Item, error) {
	row := r.db.QueryRowContext(ctx, `SELECT id, name, category, location, unit, tracking_mode, quantity, stock_level, level_percent, min_quantity, created_at, updated_at FROM items WHERE id = ?`, id)
	item, err := scanItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return inventory.Item{}, inventory.ErrNotFound
	}
	return item, err
}

func (r *Repository) CreateItem(ctx context.Context, item inventory.Item) (inventory.Item, error) {
	_, err := r.db.ExecContext(ctx, `INSERT INTO items (id, name, category, location, unit, tracking_mode, quantity, stock_level, level_percent, min_quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		item.ID, item.Name, item.Category, item.Location, item.Unit, item.TrackingMode, item.Quantity, item.StockLevel, item.LevelPercent, item.MinQuantity, formatTime(item.CreatedAt), formatTime(item.UpdatedAt))
	if err != nil {
		return inventory.Item{}, fmt.Errorf("create inventory item: %w", err)
	}
	return item, nil
}

func (r *Repository) ApplyEvent(ctx context.Context, event inventory.StockEvent, next inventory.Item) (inventory.Item, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return inventory.Item{}, fmt.Errorf("begin inventory event: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.ExecContext(ctx, `UPDATE items SET name = ?, category = ?, location = ?, unit = ?, tracking_mode = ?, quantity = ?, stock_level = ?, level_percent = ?, min_quantity = ?, updated_at = ? WHERE id = ?`,
		next.Name, next.Category, next.Location, next.Unit, next.TrackingMode, next.Quantity, next.StockLevel, next.LevelPercent, next.MinQuantity, formatTime(next.UpdatedAt), next.ID)
	if err != nil {
		return inventory.Item{}, fmt.Errorf("update inventory item: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return inventory.Item{}, fmt.Errorf("check inventory update: %w", err)
	}
	if rows == 0 {
		return inventory.Item{}, inventory.ErrNotFound
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO stock_events (id, item_id, event_type, quantity, stock_level, level_percent, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		event.ID, event.ItemID, event.Type, event.Quantity, event.StockLevel, event.LevelPercent, formatTime(event.OccurredAt))
	if err != nil {
		return inventory.Item{}, fmt.Errorf("record inventory event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return inventory.Item{}, fmt.Errorf("commit inventory event: %w", err)
	}
	return next, nil
}

func (r *Repository) ListEvents(ctx context.Context, itemID string, since time.Time) ([]inventory.StockEvent, error) {
	query := `SELECT id, item_id, event_type, quantity, stock_level, level_percent, occurred_at FROM stock_events WHERE item_id = ?`
	args := []any{itemID}
	if !since.IsZero() {
		query += " AND occurred_at >= ?"
		args = append(args, formatTime(since))
	}
	query += " ORDER BY occurred_at ASC"
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list inventory events: %w", err)
	}
	defer rows.Close()
	events := make([]inventory.StockEvent, 0)
	for rows.Next() {
		var event inventory.StockEvent
		var occurredAt string
		if err := rows.Scan(&event.ID, &event.ItemID, &event.Type, &event.Quantity, &event.StockLevel, &event.LevelPercent, &occurredAt); err != nil {
			return nil, fmt.Errorf("scan inventory event: %w", err)
		}
		parsed, err := parseTime(occurredAt)
		if err != nil {
			return nil, err
		}
		event.OccurredAt = parsed
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate inventory events: %w", err)
	}
	return events, nil
}

type rowScanner interface {
	Scan(...any) error
}

func scanItem(row rowScanner) (inventory.Item, error) {
	var item inventory.Item
	var createdAt, updatedAt string
	if err := row.Scan(&item.ID, &item.Name, &item.Category, &item.Location, &item.Unit, &item.TrackingMode, &item.Quantity, &item.StockLevel, &item.LevelPercent, &item.MinQuantity, &createdAt, &updatedAt); err != nil {
		return inventory.Item{}, err
	}
	created, err := parseTime(createdAt)
	if err != nil {
		return inventory.Item{}, err
	}
	updated, err := parseTime(updatedAt)
	if err != nil {
		return inventory.Item{}, err
	}
	item.CreatedAt = created
	item.UpdatedAt = updated
	return item, nil
}

func migratePercentages(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin percentage migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	itemAdded, err := ensureColumn(tx, "items", "level_percent", `ALTER TABLE items ADD COLUMN level_percent REAL NOT NULL DEFAULT 0 CHECK (level_percent >= 0 AND level_percent <= 100)`)
	if err != nil {
		return err
	}
	if itemAdded {
		if _, err := tx.Exec(`UPDATE items SET level_percent = CASE stock_level WHEN 'full' THEN 100 WHEN 'okay' THEN 50 WHEN 'low' THEN 25 ELSE 0 END WHERE tracking_mode = 'simple'`); err != nil {
			return fmt.Errorf("backfill item percentages: %w", err)
		}
	}

	eventAdded, err := ensureColumn(tx, "stock_events", "level_percent", `ALTER TABLE stock_events ADD COLUMN level_percent REAL NOT NULL DEFAULT 0 CHECK (level_percent >= 0 AND level_percent <= 100)`)
	if err != nil {
		return err
	}
	if eventAdded {
		if _, err := tx.Exec(`UPDATE stock_events SET level_percent = CASE stock_level WHEN 'full' THEN 100 WHEN 'okay' THEN 50 WHEN 'low' THEN 25 ELSE 0 END`); err != nil {
			return fmt.Errorf("backfill event percentages: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit percentage migration: %w", err)
	}
	return nil
}

func ensureColumn(tx *sql.Tx, table, column, statement string) (bool, error) {
	rows, err := tx.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false, fmt.Errorf("inspect %s columns: %w", table, err)
	}
	found := false
	for rows.Next() {
		var id int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue sql.NullString
		if err := rows.Scan(&id, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			_ = rows.Close()
			return false, fmt.Errorf("scan %s columns: %w", table, err)
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Close(); err != nil {
		return false, fmt.Errorf("close %s columns: %w", table, err)
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate %s columns: %w", table, err)
	}
	if found {
		return false, nil
	}
	if _, err := tx.Exec(statement); err != nil {
		return false, fmt.Errorf("add %s.%s: %w", table, column, err)
	}
	return true, nil
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func parseTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse sqlite timestamp: %w", err)
	}
	return parsed, nil
}
