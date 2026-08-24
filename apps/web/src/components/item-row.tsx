"use client";

import { ArrowCounterClockwise, Minus, Package, Warning } from "@phosphor-icons/react";
import { forecastLabel, quantityLabel, relativeUpdate, stockLabel } from "@/lib/format";
import type { ApplyEventInput, InventoryItem } from "@/lib/inventory";

interface ItemRowProps {
  item: InventoryItem;
  pending: boolean;
  onAction: (item: InventoryItem, input: ApplyEventInput) => Promise<void>;
}

export function ItemRow({ item, pending, onAction }: ItemRowProps) {
  const consumeQuantity = item.trackingMode === "exact" ? 1 : undefined;
  const restockQuantity = item.trackingMode === "exact" ? Math.max(1, item.minQuantity || 1) : undefined;
  return (
    <article className="item-row">
      <div className={`item-symbol item-symbol--${item.stockLevel}`} aria-hidden="true">
        {item.stockLevel === "low" || item.stockLevel === "out" ? <Warning size={20} weight="fill" /> : <Package size={20} weight="duotone" />}
      </div>
      <div className="item-identity">
        <h3>{item.name}</h3>
        <p>{item.category}<span aria-hidden="true">/</span>{item.location}</p>
      </div>
      <div className="item-stock">
        <span className={`status status--${item.stockLevel}`}>{stockLabel(item.stockLevel)}</span>
        <strong>{quantityLabel(item)}</strong>
      </div>
      <div className="item-pace">
        <strong>{forecastLabel(item.forecast)}</strong>
        <span>{relativeUpdate(item.updatedAt)}</span>
      </div>
      <div className="item-actions">
        <button className="button button--small button--quiet" type="button" disabled={pending || item.stockLevel === "out"} onClick={() => onAction(item, { type: "consume", quantity: consumeQuantity })} aria-label={`Use ${item.name}`}>
          <Minus size={16} weight="bold" aria-hidden="true" /> Use
        </button>
        <button className="button button--small button--restock" type="button" disabled={pending} onClick={() => onAction(item, { type: "restock", quantity: restockQuantity })} aria-label={`Restock ${item.name}`}>
          <ArrowCounterClockwise size={16} weight="bold" aria-hidden="true" /> Restock
        </button>
      </div>
    </article>
  );
}
