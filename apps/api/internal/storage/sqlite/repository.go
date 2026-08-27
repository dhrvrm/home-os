package sqlite

import (
	"context"
	"database/sql"
	"database/sql/driver"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dhrvrm/home-os/apps/api/internal/inventory"
	sqliteDriver "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

func init() {
	sqliteDriver.MustRegisterDeterministicScalarFunction("homeos_contains_fold", 2, func(_ *sqliteDriver.FunctionContext, args []driver.Value) (driver.Value, error) {
		if len(args) != 2 || args[0] == nil || args[1] == nil {
			return int64(0), nil
		}
		haystack, ok := args[0].(string)
		if !ok {
			return nil, fmt.Errorf("homeos_contains_fold expects text, got %T", args[0])
		}
		needle, ok := args[1].(string)
		if !ok {
			return nil, fmt.Errorf("homeos_contains_fold expects text, got %T", args[1])
		}
		if containsFold(haystack, needle) {
			return int64(1), nil
		}
		return int64(0), nil
	})
}

func containsFold(haystack, needle string) bool {
	if needle == "" {
		return true
	}
	for start := 0; start < len(haystack); {
		for end := start; end < len(haystack); {
			_, size := utf8.DecodeRuneInString(haystack[end:])
			end += size
			if strings.EqualFold(haystack[start:end], needle) {
				return true
			}
		}
		_, size := utf8.DecodeRuneInString(haystack[start:])
		start += size
	}
	return false
}

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
	if err := migrateLifecycle(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := migrateItemMetadata(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Repository{db: db}, nil
}

func (r *Repository) Close() error { return r.db.Close() }

func (r *Repository) Ping(ctx context.Context) error {
	var value int
	if err := r.db.QueryRowContext(ctx, `SELECT 1`).Scan(&value); err != nil {
		return fmt.Errorf("ping sqlite: %w", err)
	}
	return nil
}

func (r *Repository) ListItems(ctx context.Context, filter inventory.Filter) ([]inventory.Item, error) {
	if !filter.Archived.Valid() {
		return nil, inventory.ValidationError{Field: "archived", Message: "must be only or include"}
	}
	query := `SELECT id, name, category, location, unit, tracking_mode, quantity, stock_level, level_percent, min_quantity, created_at, updated_at, archived_at FROM items WHERE 1 = 1`
	args := make([]any, 0, 7)
	switch filter.Archived {
	case inventory.ArchivedOnly:
		query += " AND archived_at IS NOT NULL"
	case inventory.ArchivedInclude:
	default:
		query += " AND archived_at IS NULL"
	}
	if value := strings.TrimSpace(filter.Query); value != "" {
		query += ` AND (
            homeos_contains_fold(name, ?) OR homeos_contains_fold(category, ?) OR homeos_contains_fold(location, ?) OR
            EXISTS (SELECT 1 FROM item_alternative_names WHERE item_id = items.id AND homeos_contains_fold(name, ?)) OR
            EXISTS (SELECT 1 FROM item_categories WHERE item_id = items.id AND homeos_contains_fold(category, ?))
        )`
		args = append(args, value, value, value, value, value)
	}
	if value := strings.TrimSpace(filter.Category); value != "" {
		query += " AND EXISTS (SELECT 1 FROM item_categories WHERE item_id = items.id AND category = ?)"
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
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close inventory items: %w", err)
	}
	for index := range items {
		if err := hydrateItemMetadata(ctx, r.db, &items[index]); err != nil {
			return nil, err
		}
	}
	return items, nil
}

func (r *Repository) GetItem(ctx context.Context, id string) (inventory.Item, error) {
	row := r.db.QueryRowContext(ctx, `SELECT id, name, category, location, unit, tracking_mode, quantity, stock_level, level_percent, min_quantity, created_at, updated_at, archived_at FROM items WHERE id = ?`, id)
	item, err := scanItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return inventory.Item{}, inventory.ErrNotFound
	}
	if err != nil {
		return inventory.Item{}, err
	}
	if err := hydrateItemMetadata(ctx, r.db, &item); err != nil {
		return inventory.Item{}, err
	}
	return item, nil
}

func (r *Repository) CreateItem(ctx context.Context, item inventory.Item) (inventory.Item, error) {
	if len(item.Categories) == 0 {
		item.Categories = []string{item.Category}
	}
	if strings.TrimSpace(item.Categories[0]) == "" {
		item.Categories[0] = "Other"
	}
	item.Category = item.Categories[0]
	if item.AlternativeNames == nil {
		item.AlternativeNames = []string{}
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return inventory.Item{}, fmt.Errorf("begin inventory item: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var archivedAt any
	if item.ArchivedAt != nil {
		archivedAt = formatTime(*item.ArchivedAt)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO items (id, name, category, location, unit, tracking_mode, quantity, stock_level, level_percent, min_quantity, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		item.ID, item.Name, item.Category, item.Location, item.Unit, item.TrackingMode, item.Quantity, item.StockLevel, item.LevelPercent, item.MinQuantity, formatTime(item.CreatedAt), formatTime(item.UpdatedAt), archivedAt)
	if err != nil {
		return inventory.Item{}, fmt.Errorf("create inventory item: %w", err)
	}
	if err := insertItemMetadata(ctx, tx, item); err != nil {
		return inventory.Item{}, err
	}
	if err := tx.Commit(); err != nil {
		return inventory.Item{}, fmt.Errorf("commit inventory item: %w", err)
	}
	return item, nil
}

func (r *Repository) UpdateItem(ctx context.Context, item inventory.Item) (inventory.Item, error) {
	if len(item.Categories) == 0 {
		item.Categories = []string{item.Category}
	}
	if strings.TrimSpace(item.Categories[0]) == "" {
		item.Categories[0] = "Other"
	}
	item.Category = item.Categories[0]
	if item.AlternativeNames == nil {
		item.AlternativeNames = []string{}
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return inventory.Item{}, fmt.Errorf("begin item metadata update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.ExecContext(ctx, `UPDATE items SET name = ?, category = ?, location = ?, unit = ?, min_quantity = ?, updated_at = ? WHERE id = ?`,
		item.Name, item.Category, item.Location, item.Unit, item.MinQuantity, formatTime(item.UpdatedAt), item.ID)
	if err != nil {
		return inventory.Item{}, fmt.Errorf("update item metadata: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return inventory.Item{}, fmt.Errorf("check item metadata update: %w", err)
	}
	if rows == 0 {
		return inventory.Item{}, inventory.ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM item_alternative_names WHERE item_id = ?`, item.ID); err != nil {
		return inventory.Item{}, fmt.Errorf("replace alternative names: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM item_categories WHERE item_id = ?`, item.ID); err != nil {
		return inventory.Item{}, fmt.Errorf("replace item categories: %w", err)
	}
	if err := insertItemMetadata(ctx, tx, item); err != nil {
		return inventory.Item{}, err
	}
	if err := tx.Commit(); err != nil {
		return inventory.Item{}, fmt.Errorf("commit item metadata update: %w", err)
	}
	return item, nil
}

func (r *Repository) UpdateItemMetadata(ctx context.Context, item inventory.Item) (inventory.Item, error) {
	return r.UpdateItem(ctx, item)
}

func (r *Repository) ArchiveItem(ctx context.Context, itemID string, archivedAt time.Time) (inventory.Item, error) {
	return r.setArchived(ctx, itemID, archivedAt, true)
}

func (r *Repository) RestoreItem(ctx context.Context, itemID string, restoredAt time.Time) (inventory.Item, error) {
	return r.setArchived(ctx, itemID, restoredAt, false)
}

func (r *Repository) setArchived(ctx context.Context, itemID string, changedAt time.Time, archived bool) (inventory.Item, error) {
	var (
		result sql.Result
		err    error
	)
	if archived {
		result, err = r.db.ExecContext(ctx, `UPDATE items SET archived_at = ?, updated_at = ? WHERE id = ?`, formatTime(changedAt), formatTime(changedAt), itemID)
	} else {
		result, err = r.db.ExecContext(ctx, `UPDATE items SET archived_at = NULL, updated_at = ? WHERE id = ?`, formatTime(changedAt), itemID)
	}
	if err != nil {
		return inventory.Item{}, fmt.Errorf("update item archive state: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return inventory.Item{}, fmt.Errorf("check item archive update: %w", err)
	}
	if rows == 0 {
		return inventory.Item{}, inventory.ErrNotFound
	}
	return r.GetItem(ctx, itemID)
}

func (r *Repository) ApplyEvent(ctx context.Context, event inventory.StockEvent, next inventory.Item) (inventory.Item, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return inventory.Item{}, fmt.Errorf("begin inventory event: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.ExecContext(ctx, `UPDATE items SET quantity = ?, stock_level = ?, level_percent = ?, updated_at = ? WHERE id = ?`,
		next.Quantity, next.StockLevel, next.LevelPercent, formatTime(next.UpdatedAt), next.ID)
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
	_, err = tx.ExecContext(ctx, `INSERT INTO stock_events (id, item_id, event_type, quantity, stock_level, level_percent, note, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		event.ID, event.ItemID, event.Type, event.Quantity, event.StockLevel, event.LevelPercent, event.Note, formatTime(event.OccurredAt))
	if err != nil {
		return inventory.Item{}, fmt.Errorf("record inventory event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return inventory.Item{}, fmt.Errorf("commit inventory event: %w", err)
	}
	return next, nil
}

func (r *Repository) ListEvents(ctx context.Context, itemID string, since time.Time) ([]inventory.StockEvent, error) {
	query := `SELECT id, item_id, event_type, quantity, stock_level, level_percent, note, occurred_at FROM stock_events WHERE item_id = ?`
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
		if err := rows.Scan(&event.ID, &event.ItemID, &event.Type, &event.Quantity, &event.StockLevel, &event.LevelPercent, &event.Note, &occurredAt); err != nil {
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
	var archivedAt sql.NullString
	if err := row.Scan(&item.ID, &item.Name, &item.Category, &item.Location, &item.Unit, &item.TrackingMode, &item.Quantity, &item.StockLevel, &item.LevelPercent, &item.MinQuantity, &createdAt, &updatedAt, &archivedAt); err != nil {
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
	if archivedAt.Valid {
		archived, err := parseTime(archivedAt.String)
		if err != nil {
			return inventory.Item{}, err
		}
		item.ArchivedAt = &archived
	}
	return item, nil
}

type metadataQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func hydrateItemMetadata(ctx context.Context, queryer metadataQueryer, item *inventory.Item) error {
	item.AlternativeNames = make([]string, 0)
	rows, err := queryer.QueryContext(ctx, `SELECT name FROM item_alternative_names WHERE item_id = ? ORDER BY position, name`, item.ID)
	if err != nil {
		return fmt.Errorf("list alternative names: %w", err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan alternative name: %w", err)
		}
		item.AlternativeNames = append(item.AlternativeNames, name)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close alternative names: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate alternative names: %w", err)
	}

	item.Categories = make([]string, 0)
	rows, err = queryer.QueryContext(ctx, `SELECT category FROM item_categories WHERE item_id = ? ORDER BY position, category`, item.ID)
	if err != nil {
		return fmt.Errorf("list item categories: %w", err)
	}
	for rows.Next() {
		var category string
		if err := rows.Scan(&category); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan item category: %w", err)
		}
		item.Categories = append(item.Categories, category)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close item categories: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate item categories: %w", err)
	}
	if len(item.Categories) == 0 {
		item.Categories = []string{item.Category}
	}
	item.Category = item.Categories[0]
	return nil
}

func insertItemMetadata(ctx context.Context, tx *sql.Tx, item inventory.Item) error {
	for position, name := range item.AlternativeNames {
		if _, err := tx.ExecContext(ctx, `INSERT INTO item_alternative_names (item_id, position, name) VALUES (?, ?, ?)`, item.ID, position, name); err != nil {
			return fmt.Errorf("create alternative name: %w", err)
		}
	}
	for position, category := range item.Categories {
		if _, err := tx.ExecContext(ctx, `INSERT INTO item_categories (item_id, position, category) VALUES (?, ?, ?)`, item.ID, position, category); err != nil {
			return fmt.Errorf("create item category: %w", err)
		}
	}
	return nil
}

func migrateItemMetadata(db *sql.DB) error {
	if _, err := db.Exec(`INSERT OR IGNORE INTO item_categories (item_id, position, category) SELECT id, 0, category FROM items`); err != nil {
		return fmt.Errorf("backfill item categories: %w", err)
	}
	return nil
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

func migrateLifecycle(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin lifecycle migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := ensureColumn(tx, "items", "archived_at", `ALTER TABLE items ADD COLUMN archived_at TEXT`); err != nil {
		return err
	}
	if _, err := ensureColumn(tx, "stock_events", "note", `ALTER TABLE stock_events ADD COLUMN note TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit lifecycle migration: %w", err)
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
