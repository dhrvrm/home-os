"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "@phosphor-icons/react";
import { CATEGORY_OPTIONS } from "@/lib/categories";
import type { CreateItemInput, TrackingMode } from "@/lib/inventory";

interface ItemFormProps {
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: CreateItemInput) => Promise<void>;
}

export function ItemForm({ pending, error, onClose, onSubmit }: ItemFormProps) {
  const [mode, setMode] = useState<TrackingMode>("simple");
  const [levelPercent, setLevelPercent] = useState(50);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

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
      element.matches('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')
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
    await onSubmit({
      name: String(data.get("name") ?? ""),
      alternativeNames: String(data.get("alternativeNames") ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
      categories: data.getAll("categories").map(String),
      location: String(data.get("location") ?? "Unassigned"),
      unit: String(data.get("unit") ?? "item"),
      trackingMode: mode,
      quantity: mode === "exact" ? Number(data.get("quantity") ?? 0) : 0,
      levelPercent: mode === "simple" ? levelPercent : undefined,
      minQuantity: mode === "exact" ? Number(data.get("minQuantity") ?? 0) : 0,
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-item-title" onKeyDown={handleDialogKeys}>
        <header className="dialog__header">
          <div>
            <p className="dialog__context">Household inventory</p>
            <h2 id="add-item-title">Add an item</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close add item" disabled={pending}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <form className="item-form" onSubmit={submit}>
          <label className="field field--wide">
            <span>Item name</span>
            <input name="name" autoFocus required maxLength={120} placeholder="Dish soap" />
          </label>

          <label className="field field--wide">
            <span>Alternative names</span>
            <input name="alternativeNames" aria-label="Alternative names" placeholder="साबुन, Soap" />
            <small className="field__help">Separate names with commas. Any language works.</small>
          </label>

          <fieldset className="mode-picker field--wide">
            <legend>How do you want to track it?</legend>
            <label className={mode === "simple" ? "mode-option is-active" : "mode-option"}>
              <input type="radio" name="mode" value="simple" checked={mode === "simple"} onChange={() => setMode("simple")} />
              <span><strong>Simple</strong><small>Estimate stock from 0 to 100</small></span>
            </label>
            <label className={mode === "exact" ? "mode-option is-active" : "mode-option"}>
              <input type="radio" name="mode" value="exact" checked={mode === "exact"} onChange={() => setMode("exact")} />
              <span><strong>Exact</strong><small>Track a numeric quantity</small></span>
            </label>
          </fieldset>

          {mode === "simple" && (
            <div className="field field--wide level-field">
              <span className="level-field__label"><label htmlFor="starting-level">Starting level</label><output htmlFor="starting-level">{levelPercent}%</output></span>
              <input id="starting-level" name="levelPercent" type="range" min="0" max="100" step="25" value={levelPercent} onChange={(event) => setLevelPercent(Number(event.target.value))} />
              <span className="level-field__scale" aria-hidden="true"><span>Empty</span><span>Half</span><span>Full</span></span>
            </div>
          )}

          <fieldset className="category-picker field--wide">
            <legend>Categories</legend>
            <div className="category-options">
              {CATEGORY_OPTIONS.map((option) => (
                <label className="category-option" key={option}>
                  <input type="checkbox" name="categories" value={option} defaultChecked={option === "Food"} />
                  <span>{option}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field field--wide">
            <span>Location</span>
            <input name="location" defaultValue="Pantry" maxLength={80} />
          </label>

          {mode === "exact" && (
            <>
              <label className="field">
                <span>Current quantity</span>
                <input name="quantity" type="number" min="0" step="0.1" defaultValue="1" required />
              </label>
              <label className="field">
                <span>Low-stock threshold</span>
                <input name="minQuantity" type="number" min="0" step="0.1" defaultValue="1" required />
              </label>
            </>
          )}

          <label className="field field--wide">
            <span>Unit</span>
            <input name="unit" defaultValue={mode === "exact" ? "item" : "item"} maxLength={30} />
          </label>

          {error && <p className="form-error" role="alert">{error}</p>}
          <footer className="dialog__actions field--wide">
            <button className="button button--quiet" type="button" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={pending}>{pending ? "Saving..." : "Save item"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
