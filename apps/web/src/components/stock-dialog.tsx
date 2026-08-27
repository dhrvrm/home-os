"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "@phosphor-icons/react";
import type { ApplyEventInput, EventType, InventoryItem } from "@/lib/inventory";

interface StockDialogProps {
  item: InventoryItem;
  action: Extract<EventType, "consume" | "restock" | "mark_level">;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: ApplyEventInput) => Promise<void>;
}

export function StockDialog({ item, action, pending, error, onClose, onSubmit }: StockDialogProps) {
  const [levelPercent, setLevelPercent] = useState(item.levelPercent);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const verb = action === "consume" ? "Use" : action === "restock" ? "Restock" : "Adjust";

  useEffect(() => {
    const returnFocus = returnFocusRef.current;
    return () => returnFocus?.focus();
  }, []);

  function handleDialogKeys(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !pending) {
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("*") ?? []).filter((element) => (
      element.matches('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')
    ));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const note = String(data.get("note") ?? "").trim();
    if (action === "mark_level") {
      await onSubmit({ type: action, levelPercent, note: note || undefined });
      return;
    }
    await onSubmit({ type: action, quantity: Number(data.get("quantity") ?? 0), note: note || undefined });
  }

  const defaultQuantity = action === "consume"
    ? Math.min(1, item.quantity)
    : Math.max(1, item.minQuantity || 1);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section ref={dialogRef} className="dialog dialog--compact" role="dialog" aria-modal="true" aria-labelledby="stock-dialog-title" onKeyDown={handleDialogKeys}>
        <header className="dialog__header">
          <div><p className="dialog__context">Stock update</p><h2 id="stock-dialog-title">{verb} {item.name}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={`Close ${verb.toLowerCase()} ${item.name}`} disabled={pending}><X size={20} aria-hidden="true" /></button>
        </header>
        <form className="item-form" onSubmit={submit}>
          {action === "mark_level" ? (
            <div className="field field--wide level-field">
              <span className="level-field__label"><label htmlFor="adjust-level">Current level</label><output htmlFor="adjust-level">{Math.round(levelPercent)}%</output></span>
              <input id="adjust-level" type="range" min="0" max="100" step="1" value={levelPercent} onChange={(event) => setLevelPercent(Number(event.target.value))} autoFocus />
              <span className="level-field__scale" aria-hidden="true"><span>Empty</span><span>Half</span><span>Full</span></span>
            </div>
          ) : (
            <label className="field field--wide">
              <span>Quantity ({item.unit})</span>
              <input name="quantity" type="number" min="0.01" max={action === "consume" ? item.quantity : undefined} step="0.01" defaultValue={defaultQuantity} autoFocus required />
            </label>
          )}
          <label className="field field--wide"><span>Note <small>(optional)</small></span><textarea name="note" maxLength={240} rows={3} placeholder="Why did this change?" /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <footer className="dialog__actions field--wide">
            <button className="button button--quiet" type="button" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={pending}>{pending ? "Saving..." : `${verb} stock`}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
