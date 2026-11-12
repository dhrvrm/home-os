export const HOME_VIEWS = ["inventory", "shopping", "expenses", "members", "account", "menu", "recipes", "contacts", "notifications"] as const;
export type HomeView = typeof HOME_VIEWS[number];
export interface HouseholdLocation { view: HomeView; mealId?: string; recipeId?: string }

function recordId(value: string | null | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

export function readHouseholdLocation(search: string): HouseholdLocation {
  const params = new URLSearchParams(search);
  const requested = params.get("view");
  const view = HOME_VIEWS.find((value) => value === requested) ?? "inventory";
  return { view, mealId: view === "menu" ? recordId(params.get("meal")) : undefined, recipeId: view === "menu" ? recordId(params.get("recipe")) : undefined };
}

export function householdDestination(currentUrl: string, view: HomeView, detail: { mealId?: string; recipeId?: string } = {}): string {
  const url = new URL(currentUrl);
  url.searchParams.set("view", view);
  url.searchParams.delete("meal");
  url.searchParams.delete("recipe");
  if (view === "menu") {
    const mealId = recordId(detail.mealId);
    const recipeId = recordId(detail.recipeId);
    if (mealId) url.searchParams.set("meal", mealId);
    if (recipeId) url.searchParams.set("recipe", recipeId);
  }
  url.hash = "";
  return `${url.pathname}${url.search}`;
}
