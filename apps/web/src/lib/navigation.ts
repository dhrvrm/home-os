export const HOME_VIEWS = ["inventory", "shopping", "expenses", "members", "account", "menu", "recipes", "contacts", "notifications"] as const;
export type HomeView = typeof HOME_VIEWS[number];
export interface LedgerLocation { ledgerTab?: "entries" | "balances" | "rules"; currency?: "INR" | "USD" | "EUR" | "GBP" | "JPY"; entryId?: string; statementMemberId?: string; from?: string; to?: string; ledgerCursor?: string; search?: string; kind?: "expense" | "refund" | "payment"; lifecycle?: "effective" | "void" | "all"; category?: string; ledgerMemberId?: string }
export interface HouseholdLocation extends LedgerLocation { view: HomeView; mealId?: string; recipeId?: string; action?: "password" | "create-member" | "reset-password" | "enable"; memberId?: string; connect?: string }

function recordId(value: string | null | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

export function readHouseholdLocation(search: string): HouseholdLocation {
  const params = new URLSearchParams(search);
  const requested = params.get("view");
  const connectValue = params.get("connect");
  const connect = connectValue && /^[a-f0-9]{32}$/.test(connectValue) ? connectValue : undefined;
  const view = connect ? "account" : HOME_VIEWS.find((value) => value === requested) ?? "inventory";
  const requestedAction = params.get("action");
  const memberId = recordId(params.get("member"));
  let action: HouseholdLocation["action"];
  switch (requestedAction) {
    case "password":
      if (view === "account") action = "password";
      break;
    case "create-member":
      if (view === "members") action = "create-member";
      break;
    case "reset-password":
      if (view === "members" && memberId) action = "reset-password";
      break;
    case "enable":
      if (view === "notifications") action = "enable";
      break;
  }
  return { view, ...(view === "expenses" ? ledgerLocation(params) : {}), ...(action ? { action, ...(action === "reset-password" ? { memberId } : {}) } : {}), ...(connect ? { connect } : {}), mealId: view === "menu" ? recordId(params.get("meal")) : undefined, recipeId: view === "menu" ? recordId(params.get("recipe")) : undefined };
}

export function householdDestination(currentUrl: string, view: HomeView, detail: LedgerLocation & { mealId?: string; recipeId?: string } = {}): string {
  const url = new URL(currentUrl);
  url.pathname = "/";
  for (const key of ["action", "member", "connect"]) url.searchParams.delete(key);
  url.searchParams.set("view", view);
  url.searchParams.delete("meal");
  url.searchParams.delete("recipe");
  for (const key of ledgerKeys) url.searchParams.delete(key);
  if (view === "expenses") { for (const [key, value] of Object.entries(ledgerLocation(new URLSearchParams(Object.entries(detail).filter(([,v]) => v !== undefined) as [string,string][])))) url.searchParams.set(key, value); }
  if (view === "menu") {
    const mealId = recordId(detail.mealId);
    const recipeId = recordId(detail.recipeId);
    if (mealId) url.searchParams.set("meal", mealId);
    if (recipeId) url.searchParams.set("recipe", recipeId);
  }
  url.hash = "";
  return `${url.pathname}${url.search}`;
}

const ledgerKeys = ["ledgerTab", "currency", "entryId", "statementMemberId", "from", "to", "ledgerCursor", "search", "kind", "lifecycle", "category", "ledgerMemberId"];
function ledgerLocation(params: URLSearchParams): LedgerLocation {
  const result: Record<string,string> = {};
  for (const key of ledgerKeys) {
    const value = params.get(key); if (!value) continue;
    if (["entryId", "statementMemberId", "ledgerMemberId"].includes(key) && !recordId(value)) continue;
    if (key === "ledgerTab" && !["entries", "balances", "rules"].includes(value)) continue;
    if (key === "currency" && !["INR", "USD", "EUR", "GBP", "JPY"].includes(value)) continue;
    if (["from", "to"].includes(key) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
    if (key === "ledgerCursor" && (value.length > 4096 || !/^[A-Za-z0-9_.-]+$/.test(value))) continue;
    if (key === "kind" && !["expense", "refund", "payment"].includes(value)) continue;
    if (key === "lifecycle" && !["effective", "void", "all"].includes(value)) continue;
    if (["search", "category"].includes(key) && value.length > 200) continue;
    result[key] = value;
  }
  return result as LedgerLocation;
}
