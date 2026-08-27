"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  Archive,
  Basket,
  DownloadSimple,
  House,
  MagnifyingGlass,
  Package,
  Plus,
  ShoppingCartSimple,
  Sparkle,
  WarningCircle,
  WifiSlash,
} from "@phosphor-icons/react";
import {
  exportInventory,
  listItemEvents,
} from "@/lib/api";
import { BrowserAssistant } from "@/lib/browser-assistant";
import type { AssistantProposal } from "@/lib/inventory-assistant";
import type { ApplyEventInput, CreateItemInput, InventoryItem, StockEvent, UpdateItemInput } from "@/lib/inventory";
import { homeOSDatabase } from "@/offline/db";
import { useInventory } from "@/offline/use-inventory";
import { EmptyState } from "./empty-state";
import { InventoryAssistant } from "./inventory-assistant";
import { ItemDetailDialog } from "./item-detail-dialog";
import { ItemEditDialog } from "./item-edit-dialog";
import { ItemForm } from "./item-form";
import { ItemRow } from "./item-row";
import { ShoppingView } from "./shopping-view";
import { StockDialog } from "./stock-dialog";

type PrimaryView = "inventory" | "shopping";
type StockDialogState = { item: InventoryItem; action: "consume" | "restock" | "mark_level" };

export function InventoryApp({ householdId = "home", actorId = "local-owner" }: {
  householdId?: string;
  actorId?: string;
}) {
  const inventory = useInventory(householdId, actorId);
  const items = useMemo(() => sortItems(inventory.items), [inventory.items]);
  const archivedItems = useMemo(() => sortItems(inventory.archivedItems), [inventory.archivedItems]);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [view, setView] = useState<PrimaryView>("inventory");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [stockDialog, setStockDialog] = useState<StockDialogState | null>(null);
  const [events, setEvents] = useState<StockEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingItem, setPendingItem] = useState<string | null>(null);
  const [assistant] = useState(() => new BrowserAssistant());

  useEffect(() => {
    return () => { void assistant.dispose(); };
  }, [assistant]);

  const categories = useMemo(() => ["All", ...Array.from(new Set(items.flatMap(itemCategories))).sort()], [items]);
  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesCategory = category === "All" || itemCategories(item).includes(category);
      const matchesQuery = !needle || [item.name, ...(item.alternativeNames ?? []), ...itemCategories(item), item.location]
        .some((value) => value.toLowerCase().includes(needle));
      return matchesCategory && matchesQuery;
    });
  }, [category, items, query]);
  const attentionCount = items.filter((item) => item.stockLevel === "low" || item.stockLevel === "out").length;
  const locations = new Set(items.map((item) => item.location)).size;

  async function addItem(input: CreateItemInput) {
    setSaving(true);
    setMutationError(null);
    try {
      await inventory.add(input);
      setShowForm(false);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "The item could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function runAction(item: InventoryItem, input: ApplyEventInput) {
    setPendingItem(item.id);
    setMutationError(null);
    try {
      const updated = await inventory.applyStock(item.id, input);
      setSelectedItem((current) => current?.id === updated.id ? updated : current);
      if (selectedItem?.id === updated.id) {
        try {
          setEvents(await localEvents(updated.id, householdId));
        } catch (historyError) {
          setEventsError(historyError instanceof Error ? historyError.message : "History could not be refreshed.");
        }
      }
      setStockDialog(null);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Stock could not be updated.");
    } finally {
      setPendingItem(null);
    }
  }

  async function applyAssistantProposal(proposal: AssistantProposal) {
    try {
      await inventory.update(proposal.itemID, proposal.changes);
    } catch (error) {
      throw error;
    }
  }

  async function saveItemEdit(input: UpdateItemInput) {
    if (!editingItem) return;
    setPendingItem(editingItem.id);
    setMutationError(null);
    try {
      const updated = await inventory.update(editingItem.id, input);
      setSelectedItem((current) => current?.id === updated.id ? updated : current);
      setEditingItem(null);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "The item could not be updated.");
    } finally {
      setPendingItem(null);
    }
  }

  async function openDetails(item: InventoryItem) {
    setSelectedItem(item);
    setEvents([]);
    setEventsError(null);
    setEventsLoading(true);
    try {
      const local = await localEvents(item.id, householdId);
      setEvents(local);
      if (inventory.syncStatus !== "offline") {
        try {
          const remote = await listItemEvents(item.id);
          if (remote.length) setEvents(remote);
        } catch {
          // The local immutable history remains usable when connectivity changes.
        }
      }
    } catch (error) {
      setEventsError(error instanceof Error ? error.message : "History could not be loaded.");
    } finally {
      setEventsLoading(false);
    }
  }

  async function archiveSelected() {
    if (!selectedItem || !window.confirm(`Archive ${selectedItem.name}? Its history will be kept.`)) return;
    setPendingItem(selectedItem.id);
    setMutationError(null);
    try {
      await inventory.archive(selectedItem.id);
      setSelectedItem(null);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "The item could not be archived.");
    } finally {
      setPendingItem(null);
    }
  }

  async function restoreArchived(item: InventoryItem) {
    setPendingItem(item.id);
    setMutationError(null);
    try {
      await inventory.restore(item.id);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "The item could not be restored.");
    } finally {
      setPendingItem(null);
    }
  }

  async function toggleArchived() {
    setShowArchived((current) => !current);
  }

  async function downloadBackup() {
    setMutationError(null);
    try {
      let backup;
      try {
        backup = await exportInventory();
      } catch {
        const allItems = [...items, ...archivedItems];
        backup = {
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          items: await Promise.all(allItems.map(async (item) => ({ item, events: await localEvents(item.id, householdId) }))),
        };
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `home-os-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "The backup could not be created.");
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#main" aria-label="Home OS inventory home">
          <span className="brand__mark"><House size={19} weight="fill" aria-hidden="true" /></span>
          <span>Home OS</span>
        </a>
        <nav className="primary-nav" aria-label="Primary navigation">
          <button className={view === "inventory" ? "nav-link is-active" : "nav-link"} type="button" onClick={() => setView("inventory")}><Package size={19} weight="duotone" aria-hidden="true" />Inventory</button>
          <button className={view === "shopping" ? "nav-link is-active" : "nav-link"} type="button" onClick={() => setView("shopping")}><ShoppingCartSimple size={19} aria-hidden="true" />Shopping</button>
        </nav>
        <div className="sidebar__home">
          <span className="home-avatar">H</span>
          <div><strong>Our home</strong><small>{items.length} tracked items</small></div>
        </div>
      </aside>

      <main id="main" className="main-content">
        <header className="topbar">
          <div>
            <p className="topbar__context">Our home</p>
            <h1>{view === "inventory" ? "Inventory" : "Shopping"}</h1>
          </div>
          <div className="topbar__actions">
            {view === "inventory" && <button className="button button--quiet topbar__assistant" type="button" onClick={() => setShowAssistant(true)}>
              <Sparkle size={17} weight="fill" aria-hidden="true" /> Ask Home
            </button>}
            {view === "inventory" && <button className="button button--primary topbar__add" type="button" onClick={() => setShowForm(true)}>
              <Plus size={18} weight="bold" aria-hidden="true" /> Add item
            </button>}
          </div>
        </header>

        {inventory.syncStatus !== "synced" && inventory.syncStatus !== "starting" && <div className="offline-banner" role="status"><WifiSlash size={19} weight="fill" aria-hidden="true" /><span>{syncMessage(inventory.syncStatus)}</span><button className="button button--small button--quiet" type="button" onClick={() => void inventory.refresh()}>Sync now</button></div>}

        {view === "inventory" && <section className="overview" aria-label="Inventory summary">
          <div className="overview__intro">
            <span className="overview__icon"><Basket size={24} weight="duotone" aria-hidden="true" /></span>
            <div><p>Household inventory</p><h2>Know what is here before you buy.</h2></div>
          </div>
          <dl className="overview__stats">
            <div><dt>Tracked</dt><dd>{items.length}</dd></div>
            <div><dt>Need attention</dt><dd>{attentionCount}</dd></div>
            <div><dt>Locations</dt><dd>{locations}</dd></div>
          </dl>
        </section>}

        {view === "inventory" ? <section id="inventory" className="inventory-panel">
          <header className="inventory-panel__header">
            <div><h2>{showArchived ? "Archived items" : "Everything at home"}</h2><p>{showArchived ? `${archivedItems.length} archived` : `${visibleItems.length} of ${items.length} items`}</p></div>
            <div className="inventory-panel__tools">
              <button className="button button--quiet inventory-panel__assistant" type="button" onClick={() => setShowAssistant(true)} disabled={showArchived}>
                <Sparkle size={16} weight="fill" aria-hidden="true" /> Ask Home
              </button>
              <button className="button button--small button--quiet" type="button" onClick={() => void toggleArchived()}><Archive size={16} aria-hidden="true" /> {showArchived ? "Active" : "Archived"}</button>
              <button className="icon-button" type="button" onClick={() => void downloadBackup()} aria-label="Download inventory backup"><DownloadSimple size={18} aria-hidden="true" /></button>
              {!showArchived && <label className="search-field">
                <MagnifyingGlass size={18} aria-hidden="true" />
                <span className="sr-only">Search inventory</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search inventory" placeholder="Search items or rooms" />
              </label>}
            </div>
          </header>

          {!showArchived && items.length > 0 && (
            <div className="filter-strip" aria-label="Filter by category">
              {categories.map((value) => (
                <button key={value} className={category === value ? "filter is-active" : "filter"} type="button" onClick={() => setCategory(value)}>{value}</button>
              ))}
            </div>
          )}

          {mutationError && (
            <div className="inline-error" role="alert"><WarningCircle size={19} weight="fill" aria-hidden="true" /><span>{mutationError}</span><button type="button" onClick={() => setMutationError(null)}>Dismiss</button></div>
          )}

          {!showArchived && inventory.loadState === "loading" && <LoadingState />}
          {!showArchived && inventory.loadState === "error" && <ErrorState message={inventory.loadError} onRetry={inventory.refresh} />}
          {!showArchived && inventory.loadState === "ready" && items.length === 0 && <EmptyState onAdd={() => setShowForm(true)} disabled={false} />}
          {!showArchived && inventory.loadState === "ready" && items.length > 0 && visibleItems.length === 0 && (
            <div className="no-results"><MagnifyingGlass size={24} aria-hidden="true" /><h3>No matching items</h3><p>Try another search or category.</p></div>
          )}
          {!showArchived && inventory.loadState === "ready" && visibleItems.length > 0 && (
            <div className="item-list">
              <div className="item-list__labels" aria-hidden="true"><span>Item</span><span>Stock</span><span>Consumption</span><span>Actions</span></div>
              {visibleItems.map((item) => <ItemRow key={item.id} item={item} pending={pendingItem === item.id} disabled={false} onAction={runAction} onOpenStock={(target, action) => setStockDialog({ item: target, action })} onDetails={(target) => void openDetails(target)} />)}
            </div>
          )}
          {showArchived && archivedItems.length === 0 && <div className="no-results"><Archive size={26} aria-hidden="true" /><h3>No archived items</h3><p>Items you archive will stay recoverable here.</p></div>}
          {showArchived && archivedItems.length > 0 && <div className="archived-list">{archivedItems.map((item) => <article key={item.id}><div><h3>{item.name}</h3><p>{item.location} · archived {item.archivedAt ? formatSavedAt(item.archivedAt) : "recently"}</p></div><button className="button button--small button--quiet" type="button" disabled={pendingItem === item.id} onClick={() => void restoreArchived(item)}>Restore</button></article>)}</div>}
        </section> : <ShoppingView items={items} pendingItem={pendingItem} disabled={false} onRestock={(item) => item.trackingMode === "exact" ? setStockDialog({ item, action: "restock" }) : void runAction(item, { type: "restock" })} />}
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <button className={view === "inventory" ? "is-active mobile-nav__section" : "mobile-nav__section"} type="button" onClick={() => setView("inventory")}><Package size={20} weight="fill" aria-hidden="true" /><span>Inventory</span></button>
        <button type="button" onClick={() => setShowForm(true)} aria-label="Add item"><Plus size={22} weight="bold" aria-hidden="true" /></button>
        <button className={view === "shopping" ? "is-active mobile-nav__section" : "mobile-nav__section"} type="button" onClick={() => setView("shopping")}><ShoppingCartSimple size={20} aria-hidden="true" /><span>Shopping</span></button>
      </nav>

      {showForm && <ItemForm pending={saving} error={mutationError} onClose={() => { setShowForm(false); setMutationError(null); }} onSubmit={addItem} />}
      {showAssistant && <InventoryAssistant assistant={assistant} items={items} onApply={applyAssistantProposal} onClose={() => setShowAssistant(false)} />}
      {selectedItem && !editingItem && !stockDialog && <ItemDetailDialog item={selectedItem} events={events} loading={eventsLoading} error={eventsError} readOnly={false} onClose={() => setSelectedItem(null)} onEdit={() => setEditingItem(selectedItem)} onAdjust={() => setStockDialog({ item: selectedItem, action: selectedItem.trackingMode === "simple" ? "mark_level" : "restock" })} onArchive={() => void archiveSelected()} />}
      {editingItem && <ItemEditDialog item={editingItem} pending={pendingItem === editingItem.id} error={mutationError} onClose={() => { setEditingItem(null); setMutationError(null); }} onSubmit={saveItemEdit} />}
      {stockDialog && <StockDialog item={stockDialog.item} action={stockDialog.action} pending={pendingItem === stockDialog.item.id} error={mutationError} onClose={() => { setStockDialog(null); setMutationError(null); }} onSubmit={(input) => runAction(stockDialog.item, input)} />}
    </div>
  );
}

function itemCategories(item: InventoryItem): string[] {
  return item.categories?.length ? item.categories : [item.category];
}

function sortItems(items: InventoryItem[]): InventoryItem[] {
  const order = { out: 0, low: 1, okay: 2, full: 3 } as const;
  return [...items].sort((left, right) => order[left.stockLevel] - order[right.stockLevel] || left.name.localeCompare(right.name));
}

function formatSavedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

async function localEvents(itemId: string, householdId: string): Promise<StockEvent[]> {
  const events = await homeOSDatabase.stockEvents.where("itemId").equals(itemId).reverse().sortBy("occurredAt");
  return events.filter((event) => event.householdId === householdId);
}

function syncMessage(status: ReturnType<typeof useInventory>["syncStatus"]): ReactNode {
  if (status === "offline") return <><strong>Saved on this device.</strong> Changes will sync when Home OS reconnects.</>;
  if (status === "attention") return <><strong>Some changes need review.</strong> Your local copy is safe.</>;
  return <><strong>Synchronizing.</strong> You can keep working while changes are sent.</>;
}

function LoadingState() {
  return (
    <div className="loading-state" aria-live="polite">
      <p>Loading your home inventory</p>
      {[0, 1, 2].map((value) => <div className="skeleton-row" key={value}><span /><span /><span /></div>)}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => Promise<void> }) {
  return (
    <div className="error-state" role="alert">
      <WarningCircle size={30} weight="duotone" aria-hidden="true" />
      <h2>Inventory could not be loaded</h2>
      <p>{message}</p>
      <button className="button button--quiet" type="button" onClick={() => void onRetry()}><ArrowClockwise size={17} weight="bold" aria-hidden="true" /> Try again</button>
    </div>
  );
}
