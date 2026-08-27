"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "@phosphor-icons/react";
import { CATEGORY_OPTIONS } from "@/lib/categories";
import type { InventoryItem, UpdateItemInput } from "@/lib/inventory";

interface ItemEditDialogProps {
  item: InventoryItem;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: UpdateItemInput) => Promise<void>;
}

export function ItemEditDialog({ item, pending, error, onClose, onSubmit }: ItemEditDialogProps) {
  const initialCategories = item.categories?.length ? item.categories : [item.category];
  const [selectedCategories, setSelectedCategories] = useState(() => new Set(initialCategories.filter(isStandardCategory)));
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

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
      element.matches('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')
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
    const customCategories = splitValues(String(data.get("customCategories") ?? ""));
    const categories = unique([...selectedCategories, ...customCategories]);
    await onSubmit({
      name: String(data.get("name") ?? ""),
      alternativeNames: splitValues(String(data.get("alternativeNames") ?? "")),
      categories,
      location: String(data.get("location") ?? ""),
      unit: String(data.get("unit") ?? ""),
      minQuantity: item.trackingMode === "exact" ? Number(data.get("minQuantity") ?? 0) : undefined,
    });
  }

  const customCategories = initialCategories.filter((value) => !isStandardCategory(value)).join(", ");

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="edit-item-title" onKeyDown={handleDialogKeys}>
        <header className="dialog__header">
          <div><p className="dialog__context">Inventory details</p><h2 id="edit-item-title">Edit {item.name}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={`Close edit ${item.name}`} disabled={pending}><X size={20} aria-hidden="true" /></button>
        </header>
        <form className="item-form" onSubmit={submit}>
          <label className="field field--wide"><span>Item name</span><input name="name" defaultValue={item.name} autoFocus required maxLength={120} /></label>
          <label className="field field--wide"><span>Alternative names</span><input name="alternativeNames" defaultValue={item.alternativeNames.join(", ")} maxLength={976} /><small className="field__help">Separate names with commas. Any language works.</small></label>
          <fieldset className="category-picker field--wide">
            <legend>Categories</legend>
            <div className="category-options">
              {CATEGORY_OPTIONS.map((option) => (
                <label className="category-option" key={option}>
                  <input type="checkbox" checked={selectedCategories.has(option)} onChange={(event) => setSelectedCategories((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(option); else next.delete(option);
                    return next;
                  })} />
                  <span>{option}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field field--wide"><span>Custom categories</span><input name="customCategories" defaultValue={customCategories} placeholder="Staples, Festival supplies" /><small className="field__help">Separate custom categories with commas.</small></label>
          <label className="field"><span>Location</span><input name="location" defaultValue={item.location} required maxLength={80} /></label>
          <label className="field"><span>Unit</span><input name="unit" defaultValue={item.unit} required maxLength={30} /></label>
          {item.trackingMode === "exact" && <label className="field field--wide"><span>Low-stock threshold</span><input name="minQuantity" type="number" min="0" step="0.1" defaultValue={item.minQuantity} required /></label>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <footer className="dialog__actions field--wide">
            <button className="button button--quiet" type="button" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={pending}>{pending ? "Saving..." : "Save changes"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function splitValues(value: string): string[] {
  return unique(value.split(",").map((part) => part.trim()).filter(Boolean));
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isStandardCategory(value: string): boolean {
  return CATEGORY_OPTIONS.some((option) => option === value);
}
