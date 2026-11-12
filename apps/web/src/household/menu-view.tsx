"use client";
import { useState } from "react";
import { Plus, CaretLeft, CaretRight } from "@phosphor-icons/react";
import type { AuthUser } from "@/lib/auth";
import type { AttendanceResponse, Meal, UpdateMealInput } from "./types";
import { mealsData, mealData, recipesData } from "./validate";
import {
  addDays,
  displayDate,
  displayTime,
  localDate,
  localDateTime,
  zonedInstant,
} from "./time";
import {
  Field,
  Modal,
  ResourceState,
  SaveActions,
  useOnline,
  useNow,
  useResource,
  WriteReason,
} from "./ui";
import { useCommand, useEditorSave } from "./mutations";
import { RecipeEditor } from "./recipes-view";
interface MenuProps {
  currentUser: AuthUser;
  focusedMealId?: string;
  prefillRecipeId?: string;
}
export function MenuView(props: MenuProps) {
  return (
    <MenuScreen
      key={`${props.currentUser.householdId}:${props.currentUser.id}:${props.currentUser.role}:${props.prefillRecipeId ?? ""}`}
      {...props}
    />
  );
}
function MenuScreen({
  currentUser: user,
  focusedMealId,
  prefillRecipeId,
}: MenuProps) {
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [from, setFrom] = useState(() => localDate(new Date(), timezone));
  const [selected, setSelected] = useState(from);
  const [editor, setEditor] = useState<Meal | "new" | null>(
    prefillRecipeId && user.role !== "viewer" ? "new" : null,
  );
  const [focusDismissed, setFocusDismissed] = useState<string>();
  const connected = useOnline();
  const writable = connected && user.role !== "viewer";
  const to = addDays(from, 7);
  const query = new URLSearchParams({
    from,
    to,
    includeCancelled: "true",
  }).toString();
  const resource = useResource(
    user,
    `meals:${query}`,
    `/api/v1/meals?${query}`,
    mealsData,
  );
  const zone = resource.copy?.data.timezone ?? timezone;
  const today = localDate(new Date(), zone);
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index));
  if (
    resource.copy?.data.timezone &&
    resource.copy.data.timezone !== timezone
  ) {
    const next = resource.copy.data.timezone;
    setTimezone(next);
    setFrom(localDate(new Date(), next));
    setSelected(localDate(new Date(), next));
  }
  function range(date: string) {
    setFrom(date);
    setSelected(date);
  }
  return (
    <section className="hh-panel" aria-label="Menu">
      <header className="hh-header">
        <div>
          <h2>Cooking agenda</h2>
          <p>
            {displayDate(from)} – {displayDate(addDays(from, 6))} · {zone}
          </p>
        </div>
        {user.role !== "viewer" && (
          <button
            className="button button--primary"
            disabled={!writable}
            onClick={() => setEditor("new")}
          >
            <Plus size={18} /> Schedule meal
          </button>
        )}
      </header>
      <div className="hh-toolbar hh-range">
        <button
          className="button button--quiet"
          aria-label="Previous 7 days"
          onClick={() => range(addDays(from, -7))}
        >
          <CaretLeft size={18} />
        </button>
        <button className="button button--quiet" onClick={() => range(today)}>
          Today
        </button>
        <button
          className="button button--quiet"
          onClick={() => range(addDays(today, 1))}
        >
          Tomorrow
        </button>
        <button className="button button--quiet" onClick={() => range(today)}>
          Next 7 days
        </button>
        <button
          className="button button--quiet"
          aria-label="Next week"
          onClick={() => range(addDays(from, 7))}
        >
          <CaretRight size={18} />
        </button>
      </div>
      <WriteReason user={user} connected={connected} />
      <ResourceState {...resource} retry={() => void resource.refresh()} />
      {focusedMealId && focusDismissed !== focusedMealId && (
        <FocusedMeal
          user={user}
          id={focusedMealId}
          writable={writable}
          onEdit={setEditor}
          onBack={() => setFocusDismissed(focusedMealId)}
          onChanged={() => void resource.refresh()}
        />
      )}
      <nav className="hh-dates" aria-label="Seven-day menu">
        {days.map((day) => {
          const count =
            resource.copy?.data.meals.filter(
              (meal) => localDate(meal.cookingAt, zone) === day,
            ).length ?? 0;
          return (
            <button
              className="hh-date"
              aria-current={selected === day ? "date" : undefined}
              key={day}
              onClick={() => {
                setSelected(day);
                document.getElementById(`agenda-${day}`)?.focus();
                document
                  .getElementById(`agenda-${day}`)
                  ?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
              }}
            >
              <strong>
                {day === today
                  ? "Today"
                  : day === addDays(today, 1)
                    ? "Tomorrow"
                    : displayDate(day).split(",")[0]}
              </strong>
              <span>{day.slice(5)}</span>
              <small>
                {count} {count === 1 ? "meal" : "meals"}
              </small>
            </button>
          );
        })}
      </nav>
      {resource.copy && (
        <div className="hh-agenda">
          {days.map((day) => {
            const meals = resource
              .copy!.data.meals.filter(
                (meal) => localDate(meal.cookingAt, zone) === day,
              )
              .sort((a, b) => a.cookingAt.localeCompare(b.cookingAt));
            return (
              <section
                tabIndex={-1}
                id={`agenda-${day}`}
                key={day}
                className="hh-day"
                aria-label={displayDate(day)}
              >
                <h3>
                  {day === today
                    ? "Today · "
                    : day === addDays(today, 1)
                      ? "Tomorrow · "
                      : ""}
                  {displayDate(day)}
                </h3>
                {meals.length === 0 ? (
                  <p className="hh-empty">
                    No meals planned.
                    {writable && (
                      <button
                        className="button button--quiet"
                        onClick={() => {
                          setSelected(day);
                          setEditor("new");
                        }}
                      >
                        Add meal
                      </button>
                    )}
                  </p>
                ) : (
                  meals.map((meal) => (
                    <MealEntry
                      key={`${meal.id}:${meal.announcementVersion}:${meal.status}`}
                      user={user}
                      meal={meal}
                      writable={writable}
                      onEdit={() => setEditor(meal)}
                      onChanged={() => void resource.refresh()}
                    />
                  ))
                )}
              </section>
            );
          })}
        </div>
      )}
      {editor && (
        <MealEditor
          user={user}
          meal={editor === "new" ? undefined : editor}
          timezone={zone}
          date={selected}
          prefillRecipeId={editor === "new" ? prefillRecipeId : undefined}
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
function FocusedMeal({
  user,
  id,
  writable,
  onEdit,
  onBack,
  onChanged,
}: {
  user: AuthUser;
  id: string;
  writable: boolean;
  onEdit: (meal: Meal) => void;
  onBack: () => void;
  onChanged: () => void;
}) {
  const resource = useResource(
    user,
    `meal:${id}`,
    `/api/v1/meals/${encodeURIComponent(id)}`,
    mealData,
  );
  return (
    <section className="hh-focused" aria-label="Opened meal">
      <header className="hh-header">
        <h3>Opened meal</h3>
        <button className="button button--quiet" onClick={onBack}>
          Back to agenda
        </button>
      </header>
      <ResourceState {...resource} retry={() => void resource.refresh()} />
      {resource.copy && (
        <MealEntry
          key={`${id}:${resource.copy.data.meal.version}`}
          user={user}
          meal={resource.copy.data.meal}
          showDate
          writable={writable}
          onEdit={() => onEdit(resource.copy!.data.meal)}
          onChanged={() => {
            void resource.refresh();
            onChanged();
          }}
        />
      )}
    </section>
  );
}
function MealEntry({
  user,
  meal,
  writable,
  onEdit,
  onChanged,
  showDate = false,
}: {
  user: AuthUser;
  meal: Meal;
  writable: boolean;
  onEdit: () => void;
  onChanged: () => void;
  showDate?: boolean;
}) {
  const command = useCommand(user);
  const cancelled = meal.status === "cancelled";
  const now = useNow();
  const past = Date.parse(meal.cookingAt) <= now;
  const closed = cancelled || past;
  const own = meal.myAttendance;
  const counts = meal.attendance.counts;
  async function answer(response: AttendanceResponse) {
    await command.execute(
      "attendance",
      `/meals/${encodeURIComponent(meal.id)}/attendance`,
      "PUT",
      {
        response,
        announcementVersion: meal.announcementVersion,
        expectedResponseVersion: own?.responseVersion ?? 0,
      },
      undefined,
      onChanged,
      response === "yes"
        ? "You’re marked as eating."
        : response === "no"
          ? "You’re marked as not eating."
          : "Your answer is now unanswered.",
      onChanged,
    );
  }
  async function cancel() {
    if (
      !window.confirm(`Cancel ${meal.title}? The meal will remain in history.`)
    )
      return;
    await command.execute(
      "cancel",
      `/meals/${encodeURIComponent(meal.id)}`,
      "PATCH",
      { status: "cancelled" },
      meal.version,
      onChanged,
      "Meal cancelled.",
      onChanged,
    );
  }
  return (
    <article
      className={`hh-entry hh-meal${cancelled ? " hh-meal--cancelled" : ""}`}
      aria-label={meal.title}
    >
      <header className="hh-entry-header">
        <div>
          <p className="hh-time">
            {displayTime(meal.cookingAt, meal.timezone)}{" "}
            <small>{meal.timezone}</small>
          </p>
          <h4>{meal.title}</h4>
          {showDate && (
            <p>
              <time dateTime={meal.cookingAt}>
                {displayDate(localDate(meal.cookingAt, meal.timezone))}
              </time>
            </p>
          )}
        </div>
        {closed && (
          <span className="hh-tag">{cancelled ? "Cancelled" : "Closed"}</span>
        )}
      </header>
      <ul className="hh-dishes">
        {meal.recipes.map((recipe, index) => (
          <li key={`${recipe.sourceRecipeId}:${index}`}>
            <details>
              <summary>{recipe.name}</summary>
              <p>{recipe.servings} servings · As announced</p>
              <ul>
                {recipe.ingredients.map((ingredient, i) => (
                  <li key={i}>
                    {ingredient.name} {ingredient.quantity ?? ""}{" "}
                    {ingredient.unit}
                  </li>
                ))}
              </ul>
              <p className="hh-lines">{recipe.instructions}</p>
            </details>
          </li>
        ))}
      </ul>
      <p className="hh-counts">
        <span>
          <strong>{counts.yes}</strong> Eating
        </span>
        <span>
          <strong>{counts.no}</strong> Not eating
        </span>
        <span>
          <strong>{counts.pending}</strong> Unanswered
        </span>
      </p>
      <details className="hh-roster">
        <summary>See who’s eating</summary>
        <ul>
          {meal.attendance.participants.map((participant) => (
            <li key={participant.memberId}>
              {participant.memberName} ·{" "}
              {participant.response === "yes"
                ? "Eating"
                : participant.response === "no"
                  ? "Not eating"
                  : "Unanswered"}
              {participant.needsReconfirmation ? " · Please confirm again" : ""}
            </li>
          ))}
        </ul>
      </details>
      {own?.needsReconfirmation && !closed && (
        <p className="hh-notice">
          The time or dishes changed. Please confirm your answer again.
        </p>
      )}
      {own && (
        <p>
          Your answer:{" "}
          <strong>
            {own.response === "yes"
              ? "Eating"
              : own.response === "no"
                ? "Not eating"
                : "Unanswered"}
          </strong>
        </p>
      )}
      {user.role !== "viewer" && !closed && (
        <div className="hh-actions hh-attendance">
          <button
            className={`button ${own?.response === "yes" ? "button--primary" : "button--quiet"}`}
            disabled={!writable || !!command.pending}
            onClick={() => void answer("yes")}
          >
            {command.pending === "attendance" ? "Saving…" : "I’m eating"}
          </button>
          <button
            className={`button ${own?.response === "no" ? "button--primary" : "button--quiet"}`}
            disabled={!writable || !!command.pending}
            onClick={() => void answer("no")}
          >
            Not eating
          </button>
          {own?.response !== "pending" && (
            <button
              className="button button--quiet"
              disabled={!writable || !!command.pending}
              onClick={() => void answer("pending")}
            >
              Clear my answer
            </button>
          )}
        </div>
      )}
      {meal.notes && <p className="hh-lines">{meal.notes}</p>}
      <p className="hh-muted">
        Reminder {meal.reminderMinutesBefore} minutes before cooking.
      </p>
      <p className="hh-status" role="status">
        {command.status}
      </p>
      {command.error && (
        <p className="form-error" role="alert">
          {command.error}
        </p>
      )}
      {user.role !== "viewer" && !closed && (
        <div className="hh-actions">
          <button
            className="button button--quiet"
            disabled={!writable || !!command.pending}
            onClick={onEdit}
          >
            Edit meal
          </button>
          <button
            className="button button--quiet"
            disabled={!writable || !!command.pending}
            onClick={() => void cancel()}
          >
            {command.pending === "cancel" ? "Cancelling…" : "Cancel meal"}
          </button>
        </div>
      )}
    </article>
  );
}
function MealEditor({
  user,
  meal,
  timezone,
  date,
  prefillRecipeId,
  connected,
  onClose,
  onSaved,
}: {
  user: AuthUser;
  meal?: Meal;
  timezone: string;
  date: string;
  prefillRecipeId?: string;
  connected: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const zone = meal?.timezone ?? timezone;
  const [title, setTitle] = useState(meal?.title ?? "Dinner");
  const [time, setTime] = useState(
    meal ? localDateTime(meal.cookingAt, zone) : `${date}T19:30`,
  );
  const [reminder, setReminder] = useState(meal?.reminderMinutesBefore ?? 60);
  const [notes, setNotes] = useState(meal?.notes ?? "");
  const [selected, setSelected] = useState(
    meal?.recipes.map((recipe) => recipe.sourceRecipeId) ??
      (prefillRecipeId ? [prefillRecipeId] : []),
  );
  const [search, setSearch] = useState("");
  const [refreshSnapshots, setRefreshSnapshots] = useState(false);
  const [validation, setValidation] = useState("");
  const [creatingRecipe, setCreatingRecipe] = useState(false);
  const recipes = useResource(
    user,
    "recipes:meal-picker",
    "/api/v1/recipes",
    recipesData,
  );
  const save = useEditorSave(user, "meals", meal, onSaved);
  const selectionChanged =
    !meal ||
    selected.length !== meal.recipes.length ||
    selected.some(
      (id) => !meal.recipes.some((recipe) => recipe.sourceRecipeId === id),
    );
  let instant: string | undefined;
  let timeError = "";
  try {
    instant = zonedInstant(time, zone);
  } catch (error) {
    timeError =
      error instanceof Error ? error.message : "Invalid cooking time.";
  }
  const meaningful = Boolean(
    meal &&
      (selectionChanged ||
        refreshSnapshots ||
        (instant && Date.parse(instant) !== Date.parse(meal.cookingAt))),
  );
  const available = recipes.copy?.data.recipes ?? [];
  function toggle(id: string, checked: boolean) {
    setSelected((old) =>
      checked ? [...old, id] : old.filter((value) => value !== id),
    );
  }
  if (creatingRecipe)
    return (
      <RecipeEditor
        user={user}
        connected={connected}
        onClose={() => setCreatingRecipe(false)}
        onSaved={(created) => {
          if (created && typeof created.id === "string")
            setSelected((current) =>
              current.includes(created.id) ? current : [...current, created.id],
            );
          setCreatingRecipe(false);
          void recipes.refresh();
        }}
      />
    );
  return (
    <Modal
      title={meal ? `Edit ${meal.title}` : "Schedule meal"}
      pending={!!save.pending}
      onClose={onClose}
    >
      <form
        className="item-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!instant || !selected.length) {
            setValidation(timeError || "Select at least one dish.");
            return;
          }
          const input: UpdateMealInput = {
            ...(!meal || title.trim() !== meal.title
              ? { title: title.trim() }
              : {}),
            ...(!meal || Date.parse(instant) !== Date.parse(meal.cookingAt)
              ? { cookingAt: instant, timezone: zone }
              : {}),
            ...(!meal || reminder !== meal.reminderMinutesBefore
              ? { reminderMinutesBefore: reminder }
              : {}),
            ...(!meal || notes !== meal.notes ? { notes } : {}),
            ...(!meal || selectionChanged || refreshSnapshots
              ? { recipeIds: selected }
              : {}),
          };
          if (Object.keys(input).length === 0) {
            onClose();
            return;
          }
          void save.save(input);
        }}
      >
        <Field label="Meal title" wide>
          <input
            required
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label={`Cooking date and time · ${zone}`} wide>
          <input
            type="datetime-local"
            required
            value={time}
            onChange={(event) => setTime(event.target.value)}
            aria-describedby="meal-time-preview"
          />
        </Field>
        <p id="meal-time-preview" className="hh-muted field--wide">
          {instant
            ? `${displayDate(localDate(instant, zone))} · ${displayTime(instant, zone)} · ${zone}`
            : timeError}
        </p>
        <Field label="Reminder minutes before cooking">
          <input
            required
            type="number"
            min={1}
            max={10080}
            step={1}
            value={reminder}
            onChange={(event) => setReminder(Number(event.target.value))}
          />
        </Field>
        <fieldset className="hh-recipe-picker field--wide">
          <legend>Dishes (choose up to 12)</legend>
          <ResourceState {...recipes} retry={() => void recipes.refresh()} />
          <Field label="Search available dishes">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
          <div className="hh-selected">
            {selected.map((id) => (
              <div key={id}>
                <span>
                  {available.find((recipe) => recipe.id === id)?.name ??
                    meal?.recipes.find((recipe) => recipe.sourceRecipeId === id)
                      ?.name ??
                    "Selected dish"}
                </span>
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => toggle(id, false)}
                >
                  Remove dish
                </button>
              </div>
            ))}
          </div>
          {recipes.copy && available.length === 0 && (
            <p className="hh-notice">
              Add a recipe before scheduling a meal. Your meal draft stays here.
              <button
                className="button button--quiet"
                type="button"
                disabled={!connected}
                onClick={() => setCreatingRecipe(true)}
              >
                Add a recipe for this meal
              </button>
            </p>
          )}
          {available
            .filter((recipe) =>
              recipe.name
                .toLocaleLowerCase()
                .includes(search.toLocaleLowerCase()),
            )
            .map((recipe) => (
              <label className="hh-check" key={recipe.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(recipe.id)}
                  disabled={
                    !selected.includes(recipe.id) && selected.length >= 12
                  }
                  onChange={(event) => toggle(recipe.id, event.target.checked)}
                />
                <span>{recipe.name}</span>
              </label>
            ))}
          {meal && (
            <label className="hh-check">
              <input
                type="checkbox"
                checked={refreshSnapshots}
                onChange={(event) => setRefreshSnapshots(event.target.checked)}
              />
              <span>Refresh selected dishes from the recipe library</span>
            </label>
          )}
        </fieldset>
        {meaningful && (
          <p className="hh-notice field--wide">
            Changing the time or dishes asks everyone to confirm again.
          </p>
        )}
        <Field label="Meal notes" wide>
          <textarea
            rows={4}
            maxLength={2000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
        {(validation || save.error) && (
          <p className="form-error field--wide" role="alert">
            {validation || save.error}
          </p>
        )}
        <div className="field--wide">{save.conflictUI}</div>
        {!connected && (
          <p className="hh-notice field--wide">Connect to save this draft.</p>
        )}
        <SaveActions
          pending={!!save.pending}
          disabled={!connected || save.conflict || !selected.length || !instant}
          onClose={onClose}
          label="Save meal"
        />
      </form>
    </Modal>
  );
}
