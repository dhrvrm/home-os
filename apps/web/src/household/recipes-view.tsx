"use client";
import { useState } from "react";
import { Plus, Archive, ArrowCounterClockwise } from "@phosphor-icons/react";
import type { AuthUser } from "@/lib/auth";
import { listItems } from "@/lib/api";
import type { InventoryItem } from "@/lib/inventory";
import type { Recipe, RecipeIngredientInput } from "./types";
import { recipesData } from "./validate";
import {
  Field,
  labelsFrom,
  Modal,
  ResourceState,
  SaveActions,
  useHouseholdTask,
  useOnline,
  useResource,
  WriteReason,
} from "./ui";
import { useCommand, useEditorSave } from "./mutations";
export function RecipesView(props: {
  currentUser: AuthUser;
  onAddToMenu: (recipeId: string) => void;
}) {
  return (
    <RecipeScreen
      key={`${props.currentUser.householdId}:${props.currentUser.id}:${props.currentUser.role}`}
      {...props}
    />
  );
}
function RecipeScreen({
  currentUser,
  onAddToMenu,
}: {
  currentUser: AuthUser;
  onAddToMenu: (recipeId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [editor, setEditor] = useState<Recipe | "new" | null>(null);
  const connected = useOnline();
  const writable = connected && currentUser.role !== "viewer";
  const query = new URLSearchParams({
    search,
    archived: archived ? "only" : "exclude",
  }).toString();
  const resource = useResource(
    currentUser,
    `recipes:${query}`,
    `/api/v1/recipes?${query}`,
    recipesData,
  );
  const command = useCommand(currentUser);
  async function lifecycle(recipe: Recipe) {
    await command.execute(
      recipe.id,
      `/recipes/${encodeURIComponent(recipe.id)}${archived ? "/restore" : ""}`,
      archived ? "POST" : "DELETE",
      undefined,
      recipe.version,
      () => void resource.refresh(),
      archived
        ? "Recipe restored."
        : "Recipe archived. Its scheduled dishes remain available.",
      () => void resource.refresh(),
    );
  }
  return (
    <section className="hh-panel" aria-label="Recipes">
      <header className="hh-header">
        <div>
          <h2>Recipe library</h2>
          <p>Reusable dishes for your household’s menu.</p>
        </div>
        {currentUser.role !== "viewer" && (
          <button
            className="button button--primary"
            disabled={!writable}
            onClick={() => setEditor("new")}
          >
            <Plus size={18} /> Add recipe
          </button>
        )}
      </header>
      <div className="hh-toolbar">
        <Field label="Search recipes">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Field label="Recipe status">
          <select
            value={archived ? "archived" : "active"}
            onChange={(event) => setArchived(event.target.value === "archived")}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </Field>
      </div>
      <WriteReason user={currentUser} connected={connected} />
      <ResourceState {...resource} retry={() => void resource.refresh()} />
      <p role="status" className="hh-status">
        {command.status}
      </p>
      {command.error && (
        <p role="alert" className="form-error">
          {command.error}
        </p>
      )}
      {resource.copy && resource.copy.data.recipes.length === 0 && (
        <p className="hh-empty">
          {search
            ? "No recipes match your search."
            : archived
              ? "No archived recipes."
              : "No recipes yet. Add your first dish to start planning."}
        </p>
      )}
      <div className="hh-list">
        {resource.copy?.data.recipes.map((recipe) => (
          <article
            className="hh-entry"
            aria-label={recipe.name}
            key={recipe.id}
          >
            <header className="hh-entry-header">
              <div>
                <h3>{recipe.name}</h3>
                <p>
                  {recipe.servings} servings · {recipe.ingredients.length}{" "}
                  ingredients
                </p>
              </div>
              {recipe.archivedAt && <span className="hh-tag">Archived</span>}
            </header>
            {recipe.description && (
              <p className="hh-lines">{recipe.description}</p>
            )}
            <p className="hh-muted">
              {recipe.availability.state === "missing"
                ? "Some ingredients are out of stock or below the required amount."
                : recipe.availability.state === "ready"
                  ? "Recorded linked stock covers these quantities. Check freshness before cooking."
                  : "Stock not fully checked."}
            </p>
            <details>
              <summary>Ingredients and instructions</summary>
              <ul className="hh-ingredients">
                {recipe.ingredients.map((ingredient, index) => {
                  const stock = recipe.availability.ingredients.find(
                    (item) => item.index === index,
                  );
                  return (
                    <li key={index}>
                      <strong>{ingredient.name}</strong>{" "}
                      {ingredient.quantity ?? ""} {ingredient.unit}
                      <small>
                        {stock
                          ? `${stock.state === "missing" ? "Check stock" : stock.state === "unknown" ? "Stock not checked" : "Tracked stock"}: ${stock.reason}${stock.availableQuantity === null ? "" : ` · ${stock.availableQuantity} ${stock.unit}`}`
                          : "Stock not checked"}
                      </small>
                    </li>
                  );
                })}
              </ul>
              <p className="hh-lines">
                {recipe.instructions || "No instructions supplied."}
              </p>
              {recipe.labels.length > 0 && (
                <p className="hh-muted">{recipe.labels.join(" · ")}</p>
              )}
            </details>
            <div className="hh-actions">
              {!archived && currentUser.role !== "viewer" && (
                <button
                  className="button button--primary"
                  disabled={!writable}
                  onClick={() => onAddToMenu(recipe.id)}
                >
                  Add to menu
                </button>
              )}
              {currentUser.role !== "viewer" && (
                <>
                  <button
                    className="button button--quiet"
                    disabled={!writable || !!command.pending}
                    onClick={() => setEditor(recipe)}
                  >
                    Edit recipe
                  </button>
                  <button
                    className="button button--quiet"
                    disabled={!writable || !!command.pending}
                    onClick={() => void lifecycle(recipe)}
                  >
                    {archived ? (
                      <ArrowCounterClockwise size={18} />
                    ) : (
                      <Archive size={18} />
                    )}
                    {command.pending === recipe.id
                      ? "Saving…"
                      : archived
                        ? "Restore recipe"
                        : "Archive recipe"}
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {editor && (
        <RecipeEditor
          user={currentUser}
          recipe={editor === "new" ? undefined : editor}
          connected={connected}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void resource.refresh();
          }}
        />
      )}
    </section>
  );
}
export function RecipeEditor({
  user,
  recipe,
  connected,
  onClose,
  onSaved,
}: {
  user: AuthUser;
  recipe?: Recipe;
  connected: boolean;
  onClose: () => void;
  onSaved: (saved?: Recipe) => void;
}) {
  const [name, setName] = useState(recipe?.name ?? "");
  const [description, setDescription] = useState(recipe?.description ?? "");
  const [servings, setServings] = useState(recipe?.servings ?? 4);
  const [instructions, setInstructions] = useState(recipe?.instructions ?? "");
  const [labels, setLabels] = useState(recipe?.labels.join(", ") ?? "");
  const [rows, setRows] = useState<
    Array<RecipeIngredientInput & { rowId: string }>
  >(() =>
    (
      recipe?.ingredients ?? [
        { name: "", quantity: null, unit: "", inventoryItemId: null },
      ]
    ).map((row) => ({ ...row, rowId: crypto.randomUUID() })),
  );
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [stockError, setStockError] = useState("");
  const task = useHouseholdTask(user);
  const save = useEditorSave(user, "recipes", recipe, onSaved);
  function update(rowId: string, change: Partial<RecipeIngredientInput>) {
    setRows((current) =>
      current.map((row) => (row.rowId === rowId ? { ...row, ...change } : row)),
    );
  }
  async function loadStock() {
    await task(
      () => listItems(),
      setItems,
      () =>
        setStockError(
          "Inventory could not be loaded. You can still save unlinked ingredients.",
        ),
    );
  }
  return (
    <Modal
      title={recipe ? `Edit ${recipe.name}` : "Add recipe"}
      pending={!!save.pending}
      onClose={onClose}
    >
      <form
        className="item-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.save({
            name: name.trim(),
            description,
            servings,
            instructions,
            labels: labelsFrom(labels),
            ingredients: rows.map((row) => ({
              name: row.name,
              quantity: row.quantity,
              unit: row.unit,
              inventoryItemId: row.inventoryItemId,
            })),
          });
        }}
      >
        <Field label="Recipe name" wide>
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Servings">
          <input
            required
            type="number"
            min={1}
            max={100}
            step={1}
            value={servings}
            onChange={(event) => setServings(Number(event.target.value))}
          />
        </Field>
        <Field label="Labels (comma separated)">
          <input
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
          />
        </Field>
        <Field label="Description / notes" wide>
          <textarea
            maxLength={2000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <fieldset className="hh-ingredient-editor field--wide">
          <legend>Ingredients</legend>
          <button
            type="button"
            className="button button--quiet"
            disabled={!connected}
            onClick={() => void loadStock()}
          >
            Load inventory links
          </button>
          {stockError && <p role="alert">{stockError}</p>}
          {rows.map((row, index) => (
            <div className="hh-ingredient-row" key={row.rowId}>
              <Field label={`Ingredient ${index + 1} name`}>
                <input
                  required
                  maxLength={120}
                  value={row.name}
                  onChange={(event) =>
                    update(row.rowId, { name: event.target.value })
                  }
                />
              </Field>
              <Field label={`Ingredient ${index + 1} quantity`}>
                <input
                  type="number"
                  min="0.000001"
                  step="any"
                  value={row.quantity ?? ""}
                  onChange={(event) =>
                    update(row.rowId, {
                      quantity:
                        event.target.value === ""
                          ? null
                          : Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label={`Ingredient ${index + 1} unit`}>
                <input
                  maxLength={40}
                  value={row.unit ?? ""}
                  onChange={(event) =>
                    update(row.rowId, { unit: event.target.value })
                  }
                />
              </Field>
              <Field label={`Ingredient ${index + 1} inventory link`}>
                <select
                  value={row.inventoryItemId ?? ""}
                  onChange={(event) =>
                    update(row.rowId, {
                      inventoryItemId: event.target.value || null,
                    })
                  }
                >
                  <option value="">Not linked — stock not checked</option>
                  {row.inventoryItemId &&
                    !items.some((item) => item.id === row.inventoryItemId) && (
                      <option value={row.inventoryItemId}>
                        Existing inventory link
                      </option>
                    )}
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <button
                type="button"
                className="button button--quiet"
                onClick={() =>
                  setRows((current) =>
                    current.filter((item) => item.rowId !== row.rowId),
                  )
                }
              >
                Remove ingredient {index + 1}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button"
            disabled={rows.length >= 60}
            onClick={() =>
              setRows((current) => [
                ...current,
                {
                  rowId: crypto.randomUUID(),
                  name: "",
                  quantity: null,
                  unit: "",
                  inventoryItemId: null,
                },
              ])
            }
          >
            Add ingredient
          </button>
        </fieldset>
        <Field label="Cooking instructions" wide>
          <textarea
            rows={8}
            maxLength={12000}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
        {save.error && (
          <p className="form-error field--wide" role="alert">
            {save.error}
          </p>
        )}
        <div className="field--wide">{save.conflictUI}</div>
        {!connected && (
          <p className="field--wide hh-notice">Connect to save this draft.</p>
        )}
        <SaveActions
          pending={!!save.pending}
          disabled={!connected || save.conflict}
          onClose={onClose}
          label="Save recipe"
        />
      </form>
    </Modal>
  );
}
