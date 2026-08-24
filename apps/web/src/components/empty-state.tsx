import { Package, Plus } from "@phosphor-icons/react";

export function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="empty-state">
      <div className="empty-state__icon" aria-hidden="true"><Package size={30} weight="duotone" /></div>
      <h2>Your inventory is ready for its first item</h2>
      <p>Add something your household uses often. Dish soap, rice, or toilet paper is a useful start.</p>
      <button className="button button--primary" type="button" onClick={onAdd}>
        <Plus size={18} weight="bold" aria-hidden="true" /> Add first item
      </button>
    </section>
  );
}
