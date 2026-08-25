"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  Basket,
  House,
  MagnifyingGlass,
  Package,
  Plus,
  ShoppingCartSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { applyEvent, createItem, listItems } from "@/lib/api";
import type { ApplyEventInput, CreateItemInput, InventoryItem } from "@/lib/inventory";
import { EmptyState } from "./empty-state";
import { ItemForm } from "./item-form";
import { ItemRow } from "./item-row";

type LoadState = "loading" | "ready" | "error";

export function InventoryApp() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingItem, setPendingItem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    try {
      setItems(await listItems());
      setLoadState("ready");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The inventory could not be loaded.");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void listItems().then((loadedItems) => {
      if (!active) return;
      setItems(loadedItems);
      setLoadState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(error instanceof Error ? error.message : "The inventory could not be loaded.");
      setLoadState("error");
    });
    return () => { active = false; };
  }, []);

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
      const item = await createItem(input);
      setItems((current) => [item, ...current]);
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
      const updated = await applyEvent(item.id, input);
      setItems((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Stock could not be updated.");
    } finally {
      setPendingItem(null);
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
          <a className="nav-link is-active" href="#inventory"><Package size={19} weight="duotone" aria-hidden="true" />Inventory</a>
          <span className="nav-link is-disabled" aria-disabled="true"><ShoppingCartSimple size={19} aria-hidden="true" />Shopping</span>
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
            <h1>Inventory</h1>
          </div>
          <button className="button button--primary topbar__add" type="button" onClick={() => setShowForm(true)}>
            <Plus size={18} weight="bold" aria-hidden="true" /> Add item
          </button>
        </header>

        <section className="overview" aria-label="Inventory summary">
          <div className="overview__intro">
            <span className="overview__icon"><Basket size={24} weight="duotone" aria-hidden="true" /></span>
            <div><p>Household inventory</p><h2>Know what is here before you buy.</h2></div>
          </div>
          <dl className="overview__stats">
            <div><dt>Tracked</dt><dd>{items.length}</dd></div>
            <div><dt>Need attention</dt><dd>{attentionCount}</dd></div>
            <div><dt>Locations</dt><dd>{locations}</dd></div>
          </dl>
        </section>

        <section id="inventory" className="inventory-panel">
          <header className="inventory-panel__header">
            <div><h2>Everything at home</h2><p>{visibleItems.length} of {items.length} items</p></div>
            <label className="search-field">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <span className="sr-only">Search inventory</span>
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search inventory" placeholder="Search items or rooms" />
            </label>
          </header>

          {items.length > 0 && (
            <div className="filter-strip" aria-label="Filter by category">
              {categories.map((value) => (
                <button key={value} className={category === value ? "filter is-active" : "filter"} type="button" onClick={() => setCategory(value)}>{value}</button>
              ))}
            </div>
          )}

          {mutationError && (
            <div className="inline-error" role="alert"><WarningCircle size={19} weight="fill" aria-hidden="true" /><span>{mutationError}</span><button type="button" onClick={() => setMutationError(null)}>Dismiss</button></div>
          )}

          {loadState === "loading" && <LoadingState />}
          {loadState === "error" && <ErrorState message={loadError} onRetry={load} />}
          {loadState === "ready" && items.length === 0 && <EmptyState onAdd={() => setShowForm(true)} />}
          {loadState === "ready" && items.length > 0 && visibleItems.length === 0 && (
            <div className="no-results"><MagnifyingGlass size={24} aria-hidden="true" /><h3>No matching items</h3><p>Try another search or category.</p></div>
          )}
          {loadState === "ready" && visibleItems.length > 0 && (
            <div className="item-list">
              <div className="item-list__labels" aria-hidden="true"><span>Item</span><span>Stock</span><span>Consumption</span><span>Actions</span></div>
              {visibleItems.map((item) => <ItemRow key={item.id} item={item} pending={pendingItem === item.id} onAction={runAction} />)}
            </div>
          )}
        </section>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <a className="is-active" href="#inventory"><Package size={20} weight="fill" aria-hidden="true" /><span>Inventory</span></a>
        <button type="button" onClick={() => setShowForm(true)} aria-label="Add item"><Plus size={22} weight="bold" aria-hidden="true" /></button>
        <span aria-disabled="true"><ShoppingCartSimple size={20} aria-hidden="true" />Shopping</span>
      </nav>

      {showForm && <ItemForm pending={saving} error={mutationError} onClose={() => { setShowForm(false); setMutationError(null); }} onSubmit={addItem} />}
    </div>
  );
}

function itemCategories(item: InventoryItem): string[] {
  return item.categories?.length ? item.categories : [item.category];
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
