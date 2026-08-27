"use client";

import { ArrowCounterClockwise, Minus, Package, SlidersHorizontal, Warning } from "@phosphor-icons/react";
import { cadenceLabel, forecastLabel, quantityLabel, relativeUpdate, stockLabel } from "@/lib/format";
import type { ApplyEventInput, InventoryItem } from "@/lib/inventory";

interface ItemRowProps {
  item: InventoryItem;
  pending: boolean;
  disabled?: boolean;
  onAction: (item: InventoryItem, input: ApplyEventInput) => Promise<void>;
  onOpenStock: (item: InventoryItem, action: "consume" | "restock") => void;
  onDetails: (item: InventoryItem) => void;
}

export function ItemRow({ item, pending, disabled = false, onAction, onOpenStock, onDetails }: ItemRowProps) {
  const consumeQuantity = item.trackingMode === "exact" ? 1 : 25;
  const restockQuantity = item.trackingMode === "exact" ? Math.max(1, item.minQuantity || 1) : undefined;
  return (
    <article className="item-row">
      <div className={`item-symbol item-symbol--${item.stockLevel}`} aria-hidden="true">
        {item.stockLevel === "low" || item.stockLevel === "out" ? <Warning size={20} weight="fill" /> : <Package size={20} weight="duotone" />}
      </div>
      <div className="item-identity">
        <h3>{item.name}</h3>
        {item.alternativeNames?.length > 0 && <small>{item.alternativeNames.join(", ")}</small>}
        <p>{(item.categories?.length ? item.categories : [item.category]).join(", ")}<span aria-hidden="true">/</span>{item.location}</p>
      </div>
      <div className="item-stock">
        <span className={`status status--${item.stockLevel}`}>{stockLabel(item.stockLevel)}</span>
        {item.trackingMode === "simple" ? (
          <div className="stock-meter">
            <meter className={`stock-meter__bar stock-meter__bar--${item.stockLevel}`} min="0" max="100" value={item.levelPercent} aria-label={`${item.name} level`} />
            <strong>{Math.round(item.levelPercent)}%</strong>
          </div>
        ) : <strong>{quantityLabel(item)}</strong>}
      </div>
      <div className="item-pace">
        <strong>{cadenceLabel(item.cadence)}</strong>
        <span>{item.trackingMode === "exact" && item.forecast ? forecastLabel(item.forecast) : relativeUpdate(item.updatedAt)}</span>
      </div>
      <div className="item-actions">
        <button className="button button--small button--quiet" type="button" disabled={disabled || pending || item.stockLevel === "out"} onClick={() => item.trackingMode === "exact" ? onOpenStock(item, "consume") : onAction(item, { type: "consume", quantity: consumeQuantity })} aria-label={`Use ${item.name}`}>
          <Minus size={16} weight="bold" aria-hidden="true" /> Use
        </button>
        <button className="button button--small button--restock" type="button" disabled={disabled || pending} onClick={() => item.trackingMode === "exact" ? onOpenStock(item, "restock") : onAction(item, { type: "restock", quantity: restockQuantity })} aria-label={`Restock ${item.name}`}>
          <ArrowCounterClockwise size={16} weight="bold" aria-hidden="true" /> Restock
        </button>
        <button className="icon-button icon-button--small" type="button" disabled={pending} onClick={() => onDetails(item)} aria-label={`View details for ${item.name}`}>
          <SlidersHorizontal size={16} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
