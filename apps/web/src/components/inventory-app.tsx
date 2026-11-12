"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { AuthSession } from "@/lib/auth";
import { AccountPanel } from "./account-panel";
import { MembersView } from "./members-view";
import { MoreNavigation } from "./more-navigation";
import { MenuView } from "@/household/menu-view";
import { RecipesView } from "@/household/recipes-view";
import { ContactsView } from "@/household/contacts-view";
import { NotificationsView } from "@/household/notifications-view";
import { householdDestination, readHouseholdLocation, type HomeView, type HouseholdLocation } from "@/lib/navigation";
import "@/household/household.css";
import {
  ArrowClockwise,
  Archive,
  Basket,
  DownloadSimple,
  House,
  MagnifyingGlass,
  Package,
  Plus,
  Receipt,
  ShoppingCartSimple,
  Sparkle,
  WarningCircle,
  WifiSlash,
  Users,
  UserCircle,
  CalendarBlank,
  BookOpen,
  AddressBook,
  Bell,
  DotsThree,
} from "@phosphor-icons/react";
import {
  exportInventory,
  listItemEvents,
} from "@/lib/api";
import { BrowserAssistant } from "@/lib/browser-assistant";
import type { AssistantProposal } from "@/lib/inventory-assistant";
import type { ApplyEventInput, CreateItemInput, InventoryItem, StockEvent, UpdateItemInput } from "@/lib/inventory";
import { needsAttention } from "@/lib/restock";
import { homeOSDatabase } from "@/offline/db";
import { useInventory } from "@/offline/use-inventory";
import { EmptyState } from "./empty-state";
import { InventoryAssistant } from "./inventory-assistant";
import { ItemDetailDialog } from "./item-detail-dialog";
import { ItemEditDialog } from "./item-edit-dialog";
import { ItemForm } from "./item-form";
import { ItemRow } from "./item-row";
import { ExpensesView } from "./expenses-view";
import { ShoppingView } from "./shopping-view";
import { StockDialog } from "./stock-dialog";

type PrimaryView = HomeView;
type StockDialogState = { item: InventoryItem; action: "consume" | "restock" | "mark_level" };

export function InventoryApp({ session, onLogout, onSessionChange }: {
  session?: AuthSession;
  onLogout?: () => Promise<void>;
  onSessionChange?: (session: AuthSession) => void;
} = {}) {
  const readOnly = session?.user.role === "viewer";
  const pendingCount = useLiveQuery(() => homeOSDatabase.outbox.where("state").anyOf("pending", "sending").count(), [], 0);
  const inventory = useInventory();
  const items = useMemo(() => sortItems(inventory.items), [inventory.items]);
  const archivedItems = useMemo(() => sortItems(inventory.archivedItems), [inventory.archivedItems]);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [navigation, setNavigation] = useState<HouseholdLocation>({ view: "inventory" });
  const view = navigation.view;
  const [showMore, setShowMore] = useState(false);
  const closeMore = useCallback(() => setShowMore(false), []);
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

  function setView(next: PrimaryView, detail: { mealId?: string; recipeId?: string } = {}) {
    const destination = householdDestination(window.location.href, next, detail);
    if (`${window.location.pathname}${window.location.search}` !== destination) window.history.pushState(null, "", destination);
    setNavigation(readHouseholdLocation(window.location.search));
    setShowMore(false);
    setShowForm(false);
    setSelectedItem(null);
    setEditingItem(null);
    setStockDialog(null);
    setShowAssistant(false);
    document.getElementById("main")?.scrollIntoView?.({ block: "start" });
  }

  useEffect(() => {
    let active = true;
    const restore = () => {
      if (!active) return;
      setNavigation(readHouseholdLocation(window.location.search));
      setShowMore(false);
      setShowForm(false);
      setSelectedItem(null);
      setEditingItem(null);
      setStockDialog(null);
      setShowAssistant(false);
    };
    queueMicrotask(restore);
    window.addEventListener("popstate", restore);
    return () => { active = false; window.removeEventListener("popstate", restore); };
  }, []);

  useEffect(() => {
    let active = true;
    if (readOnly) queueMicrotask(() => {
      if (!active) return;
      setShowForm(false);
      setEditingItem(null);
      setStockDialog(null);
    });
    return () => { active = false; };
  }, [readOnly]);

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
  const attentionCount = items.filter(needsAttention).length;
  const locations = new Set(items.map((item) => item.location)).size;

  function requireWritable() {
    if (readOnly) throw new Error("Your account has read-only access.");
  }

  async function addItem(input: CreateItemInput) {
    setSaving(true);
    setMutationError(null);
    try {
      requireWritable();
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
      requireWritable();
      const updated = await inventory.applyStock(item.id, input);
      setSelectedItem((current) => current?.id === updated.id ? updated : current);
      if (selectedItem?.id === updated.id) {
        try {
          setEvents(await localEvents(updated.id));
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
    requireWritable();
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
      requireWritable();
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
      const local = await localEvents(item.id);
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
    if (readOnly || !selectedItem || !window.confirm(`Archive ${selectedItem.name}? Its history will be kept.`)) return;
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
      requireWritable();
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
          items: await Promise.all(allItems.map(async (item) => ({ item, events: await localEvents(item.id) }))),
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

  function secondaryView(): ReactNode {
    switch (view) {
      case "shopping":
        return <ShoppingView items={items} pendingItem={pendingItem} disabled={readOnly} onRestock={(item) => item.trackingMode === "exact" ? setStockDialog({ item, action: "restock" }) : void runAction(item, { type: "restock" })} />;
      case "expenses":
        return <ExpensesView readOnly={readOnly} />;
      case "members":
        return session ? <MembersView currentUser={session.user} /> : null;
      case "account":
        return session && onLogout && onSessionChange ? <AccountPanel session={session} onLogout={onLogout} onSessionChange={onSessionChange} hasPendingChanges={pendingCount > 0} /> : null;
      case "menu":
        return session ? <MenuView currentUser={session.user} focusedMealId={navigation.mealId} prefillRecipeId={navigation.recipeId} /> : null;
      case "recipes":
        return session ? <RecipesView currentUser={session.user} onAddToMenu={(recipeId) => setView("menu", { recipeId })} /> : null;
      case "contacts":
        return session ? <ContactsView currentUser={session.user} /> : null;
      case "notifications":
        return session ? <NotificationsView currentUser={session.user} onOpenMeal={(mealId) => setView("menu", { mealId })} /> : null;
      default:
        return null;
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
          {session && <>
            <button className={view === "menu" ? "nav-link is-active" : "nav-link"} aria-current={view === "menu" ? "page" : undefined} type="button" onClick={() => setView("menu")}><CalendarBlank size={19} aria-hidden="true" />Menu</button>
            <button className={view === "recipes" ? "nav-link is-active" : "nav-link"} aria-current={view === "recipes" ? "page" : undefined} type="button" onClick={() => setView("recipes")}><BookOpen size={19} aria-hidden="true" />Recipes</button>
          </>}
          <button className={view === "inventory" ? "nav-link is-active" : "nav-link"} type="button" onClick={() => setView("inventory")}><Package size={19} weight="duotone" aria-hidden="true" />Inventory</button>
          <button className={view === "shopping" ? "nav-link is-active" : "nav-link"} type="button" onClick={() => setView("shopping")}><ShoppingCartSimple size={19} aria-hidden="true" />Shopping</button>
          <button className={view === "expenses" ? "nav-link is-active" : "nav-link"} type="button" onClick={() => setView("expenses")}><Receipt size={19} weight="duotone" aria-hidden="true" />Expenses</button>
          {session && <>
            <button className={view === "contacts" ? "nav-link is-active" : "nav-link"} aria-current={view === "contacts" ? "page" : undefined} type="button" onClick={() => setView("contacts")}><AddressBook size={19} aria-hidden="true" />Contacts</button>
            <button className={view === "members" ? "nav-link is-active" : "nav-link"} type="button" onClick={() => setView("members")}><Users size={19} aria-hidden="true" />Members</button>
            <button className={view === "notifications" ? "nav-link is-active" : "nav-link"} aria-current={view === "notifications" ? "page" : undefined} type="button" onClick={() => setView("notifications")}><Bell size={19} aria-hidden="true" />Notifications</button>
            <button className={view === "account" ? "nav-link is-active" : "nav-link"} type="button" onClick={() => setView("account")}><UserCircle size={19} aria-hidden="true" />Account</button>
          </>}
        </nav>
        <div className="sidebar__home">
          <span className="home-avatar">H</span>
          <div><strong>{session?.user.name ?? "Our home"}</strong><small>{readOnly ? "Read-only access" : `${items.length} tracked items`}</small></div>
        </div>
      </aside>

      <main id="main" className="main-content">
        <header className="topbar">
          <div>
            <p className="topbar__context">Our home</p>
            <h1>{viewTitle(view)}</h1>
          </div>
          <div className="topbar__actions">
            {view === "inventory" && <button className="button button--quiet topbar__assistant" type="button" onClick={() => setShowAssistant(true)}>
              <Sparkle size={17} weight="fill" aria-hidden="true" /> Ask Home
            </button>}
            {view === "inventory" && !readOnly && <button className="button button--primary topbar__add" type="button" onClick={() => setShowForm(true)}>
              <Plus size={18} weight="bold" aria-hidden="true" /> Add item
            </button>}
          </div>
        </header>

        {["inventory", "shopping"].includes(view) && inventory.syncStatus !== "synced" && inventory.syncStatus !== "starting" && <div className="offline-banner" role="status"><WifiSlash size={19} weight="fill" aria-hidden="true" /><span>{syncMessage(inventory.syncStatus)}</span><button className="button button--small button--quiet" type="button" onClick={() => void inventory.refresh()}>Sync now</button></div>}

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
          {!showArchived && inventory.loadState === "ready" && items.length === 0 && <EmptyState onAdd={() => setShowForm(true)} disabled={readOnly} />}
          {!showArchived && inventory.loadState === "ready" && items.length > 0 && visibleItems.length === 0 && (
            <div className="no-results"><MagnifyingGlass size={24} aria-hidden="true" /><h3>No matching items</h3><p>Try another search or category.</p></div>
          )}
          {!showArchived && inventory.loadState === "ready" && visibleItems.length > 0 && (
            <div className="item-list">
              <div className="item-list__labels" aria-hidden="true"><span>Item</span><span>Stock</span><span>Consumption</span><span>Actions</span></div>
              {visibleItems.map((item) => <ItemRow key={item.id} item={item} pending={pendingItem === item.id} disabled={readOnly} onAction={runAction} onOpenStock={(target, action) => setStockDialog({ item: target, action })} onDetails={(target) => void openDetails(target)} />)}
            </div>
          )}
          {showArchived && archivedItems.length === 0 && <div className="no-results"><Archive size={26} aria-hidden="true" /><h3>No archived items</h3><p>Items you archive will stay recoverable here.</p></div>}
          {showArchived && archivedItems.length > 0 && <div className="archived-list">{archivedItems.map((item) => <article key={item.id}><div><h3>{item.name}</h3><p>{item.location} · archived {item.archivedAt ? formatSavedAt(item.archivedAt) : "recently"}</p></div><button className="button button--small button--quiet" type="button" disabled={readOnly || pendingItem === item.id} onClick={() => void restoreArchived(item)}>Restore</button></article>)}</div>}
        </section> : secondaryView()}
      </main>

      <nav className={session ? "mobile-nav mobile-nav--household" : "mobile-nav"} aria-label="Mobile navigation">
        {session && <button className={view === "menu" ? "is-active mobile-nav__section" : "mobile-nav__section"} type="button" onClick={() => setView("menu")}><CalendarBlank size={20} aria-hidden="true" /><span>Menu</span></button>}
        <button className={view === "inventory" ? "is-active mobile-nav__section" : "mobile-nav__section"} type="button" onClick={() => setView("inventory")}><Package size={20} weight="fill" aria-hidden="true" /><span>Inventory</span></button>
        {!session && <button type="button" disabled={readOnly} onClick={() => setShowForm(true)} aria-label="Add item"><Plus size={22} weight="bold" aria-hidden="true" /></button>}
        {!session && <>
          <button className={view === "shopping" ? "is-active mobile-nav__section" : "mobile-nav__section"} type="button" onClick={() => setView("shopping")}><ShoppingCartSimple size={20} aria-hidden="true" /><span>Shopping</span></button>
          <button className={view === "expenses" ? "is-active mobile-nav__section" : "mobile-nav__section"} type="button" onClick={() => setView("expenses")}><Receipt size={20} aria-hidden="true" /><span>Expenses</span></button>
        </>}
        {session && <>
          <button className={view === "notifications" ? "is-active mobile-nav__section" : "mobile-nav__section"} type="button" onClick={() => setView("notifications")}><Bell size={20} aria-hidden="true" /><span>Notifications</span></button>
          <button className={!["menu", "inventory", "notifications"].includes(view) ? "is-active mobile-nav__section" : "mobile-nav__section"} type="button" aria-haspopup="dialog" aria-expanded={showMore} onClick={() => setShowMore(true)}><DotsThree size={22} weight="bold" aria-hidden="true" /><span>More</span></button>
        </>}
      </nav>

      {showMore && session && <MoreNavigation activeView={view} onNavigate={setView} onClose={closeMore} />}

      {showForm && !readOnly && <ItemForm pending={saving} error={mutationError} onClose={() => { setShowForm(false); setMutationError(null); }} onSubmit={addItem} />}
      {showAssistant && <InventoryAssistant assistant={assistant} items={items} onApply={applyAssistantProposal} onClose={() => setShowAssistant(false)} />}
      {selectedItem && !editingItem && !stockDialog && <ItemDetailDialog item={selectedItem} events={events} loading={eventsLoading} error={eventsError} readOnly={readOnly} onClose={() => setSelectedItem(null)} onEdit={() => setEditingItem(selectedItem)} onAdjust={() => setStockDialog({ item: selectedItem, action: selectedItem.trackingMode === "simple" ? "mark_level" : "restock" })} onArchive={() => void archiveSelected()} />}
      {editingItem && !readOnly && <ItemEditDialog item={editingItem} pending={pendingItem === editingItem.id} error={mutationError} onClose={() => { setEditingItem(null); setMutationError(null); }} onSubmit={saveItemEdit} />}
      {stockDialog && !readOnly && <StockDialog item={stockDialog.item} action={stockDialog.action} pending={pendingItem === stockDialog.item.id} error={mutationError} onClose={() => { setStockDialog(null); setMutationError(null); }} onSubmit={(input) => runAction(stockDialog.item, input)} />}
    </div>
  );
}

function viewTitle(view: PrimaryView): string {
  return { inventory: "Inventory", shopping: "Shopping", expenses: "Expenses", members: "Household members", account: "Your account", menu: "Your home menu", recipes: "Recipe library", contacts: "Household contacts", notifications: "Your notifications" }[view];
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

async function localEvents(itemId: string): Promise<StockEvent[]> {
  return homeOSDatabase.stockEvents.where("itemId").equals(itemId).reverse().sortBy("occurredAt");
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
