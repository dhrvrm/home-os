"use client";

import { ArrowCounterClockwise, CheckCircle, ShoppingCartSimple } from "@phosphor-icons/react";
import { quantityLabel, stockLabel } from "@/lib/format";
import type { InventoryItem } from "@/lib/inventory";

interface ShoppingViewProps {
  items: InventoryItem[];
  pendingItem: string | null;
  disabled?: boolean;
  onRestock: (item: InventoryItem) => void;
}

export function ShoppingView({ items, pendingItem, disabled = false, onRestock }: ShoppingViewProps) {
  const shoppingItems = items.filter((item) => !item.archivedAt && (item.stockLevel === "low" || item.stockLevel === "out"));

  return (
    <section className="shopping-panel" aria-labelledby="shopping-title">
      <header className="shopping-panel__header">
        <span><ShoppingCartSimple size={24} weight="duotone" aria-hidden="true" /></span>
        <div><p>Generated from inventory</p><h2 id="shopping-title">Buy next</h2><small>Low and empty items stay here until they are restocked.</small></div>
      </header>
      {shoppingItems.length === 0 ? (
        <div className="shopping-empty"><CheckCircle size={34} weight="duotone" aria-hidden="true" /><h3>Nothing needs buying</h3><p>Low and empty inventory will appear here automatically.</p></div>
      ) : (
        <div className="shopping-list">
          {shoppingItems.map((item) => (
            <article key={item.id}>
              <span className={`status status--${item.stockLevel}`}>{stockLabel(item.stockLevel)}</span>
              <div><h3>{item.name}</h3><p>{item.location} · {item.trackingMode === "exact" ? quantityLabel(item) : `${Math.round(item.levelPercent)}% left`}</p></div>
              <button className="button button--restock" type="button" disabled={disabled || pendingItem === item.id} onClick={() => onRestock(item)} aria-label={`Restock ${item.name} from shopping list`}>
                <ArrowCounterClockwise size={16} weight="bold" aria-hidden="true" /> Restock
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
