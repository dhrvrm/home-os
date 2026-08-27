"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Archive, ClockCounterClockwise, PencilSimple, SlidersHorizontal, X } from "@phosphor-icons/react";
import { quantityLabel, stockLabel } from "@/lib/format";
import type { InventoryItem, StockEvent } from "@/lib/inventory";

interface ItemDetailDialogProps {
  item: InventoryItem;
  events: StockEvent[];
  loading: boolean;
  error: string | null;
  readOnly?: boolean;
  onClose: () => void;
  onEdit: () => void;
  onAdjust: () => void;
  onArchive: () => void;
}

export function ItemDetailDialog({ item, events, loading, error, readOnly = false, onClose, onEdit, onAdjust, onArchive }: ItemDetailDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    const returnFocus = returnFocusRef.current;
    dialogRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  function handleDialogKeys(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="dialog item-detail" role="dialog" aria-modal="true" aria-labelledby="item-detail-title" onKeyDown={handleDialogKeys} tabIndex={-1}>
        <header className="dialog__header">
          <div><p className="dialog__context">{item.location}</p><h2 id="item-detail-title">{item.name}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={`Close details for ${item.name}`}><X size={20} aria-hidden="true" /></button>
        </header>
        <div className="item-detail__body">
          <dl className="item-detail__facts">
            <div><dt>Stock</dt><dd>{item.trackingMode === "simple" ? `${Math.round(item.levelPercent)}% · ${stockLabel(item.stockLevel)}` : quantityLabel(item)}</dd></div>
            <div><dt>Categories</dt><dd>{(item.categories?.length ? item.categories : [item.category]).join(", ")}</dd></div>
            <div><dt>Other names</dt><dd>{item.alternativeNames.length ? item.alternativeNames.join(", ") : "None"}</dd></div>
            {item.trackingMode === "exact" && <div><dt>Low threshold</dt><dd>{item.minQuantity} {item.unit}</dd></div>}
          </dl>
          <div className="item-detail__actions">
            <button className="button button--quiet" type="button" onClick={onEdit} disabled={readOnly}><PencilSimple size={16} aria-hidden="true" /> Edit item</button>
            <button className="button button--quiet" type="button" onClick={onAdjust} disabled={readOnly}><SlidersHorizontal size={16} aria-hidden="true" /> Adjust stock</button>
            <button className="button button--danger" type="button" onClick={onArchive} disabled={readOnly}><Archive size={16} aria-hidden="true" /> Archive item</button>
          </div>
          <section className="history-panel" aria-labelledby="history-title">
            <header><ClockCounterClockwise size={20} aria-hidden="true" /><div><h3 id="history-title">Stock history</h3><p>Recorded changes are kept when an item is archived.</p></div></header>
            {loading && <p className="history-panel__state">Loading history…</p>}
            {error && <p className="history-panel__state history-panel__state--error" role="alert">{error}</p>}
            {!loading && !error && events.length === 0 && <p className="history-panel__state">No stock changes yet.</p>}
            {!loading && events.length > 0 && (
              <ol className="history-list">
                {[...events].reverse().map((event) => (
                  <li key={event.id}>
                    <span className={`history-list__mark history-list__mark--${event.type}`} aria-hidden="true" />
                    <div><strong>{eventLabel(event, item)}</strong>{event.note && <p>{event.note}</p>}</div>
                    <time dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function eventLabel(event: StockEvent, item: InventoryItem): string {
  if (event.type === "mark_level") return `Adjusted to ${Math.round(event.levelPercent)}%`;
  const action = event.type === "consume" ? "Used" : "Restocked";
  if (item.trackingMode === "simple") return event.type === "consume" ? `Used ${Math.round(event.quantity)} points` : "Restocked to full";
  return `${action} ${event.quantity} ${item.unit}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
