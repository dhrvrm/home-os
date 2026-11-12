import type { AuthSession } from "@/lib/auth";

const SESSION_KEY = "home-os:session:v1";
const OWNER_KEY = "home-os:data-owner:v1";

export interface DataOwner { id: string; householdId: string }

function validatedSession(value: unknown): AuthSession | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.expiresAt !== "string" || !Number.isFinite(Date.parse(candidate.expiresAt))) return null;
  const user = candidate.user;
  if (!user || typeof user !== "object") return null;
  const fields = user as Record<string, unknown>;
  if (!["id", "householdId", "name", "email"].every((field) => typeof fields[field] === "string" && (fields[field] as string).length > 0 && (fields[field] as string).length <= 254)) return null;
  if (!["owner", "member", "viewer"].includes(String(fields.role))) return null;
  return {
    expiresAt: candidate.expiresAt,
    user: { id: fields.id as string, householdId: fields.householdId as string, name: fields.name as string, email: fields.email as string, role: fields.role as AuthSession["user"]["role"] },
  };
}

function stored(storage: Storage): AuthSession | null {
  try { return validatedSession(JSON.parse(storage.getItem(SESSION_KEY) ?? "null")); } catch { return null; }
}

export function readSavedSession(now = Date.now()): AuthSession | null {
  for (const source of [() => sessionStorage, () => localStorage]) {
    try {
      const candidate = stored(source());
      if (candidate && Date.parse(candidate.expiresAt) > now) return candidate;
    } catch { /* No application storage means no offline access evidence. */ }
  }
  return null;
}

export function saveSession(session: AuthSession): void {
  const safe = validatedSession(session);
  if (!safe) throw new Error("Home OS received an invalid sign-in response.");
  try {
    const previous = stored(localStorage);
    const persistent = Date.parse(safe.expiresAt) - Date.now() > 13 * 60 * 60 * 1000
      || (previous?.user.id === safe.user.id && previous.expiresAt === safe.expiresAt);
    if (persistent) localStorage.setItem(SESSION_KEY, JSON.stringify(safe));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* Online access remains available without browser storage. */ }
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(safe)); } catch { /* Storage can be disabled. */ }
}

export function clearSavedSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* Storage can be disabled. */ }
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* Storage can be disabled. */ }
}

export function readDataOwner(): DataOwner | null {
  try {
    const candidate = JSON.parse(localStorage.getItem(OWNER_KEY) ?? "null");
    return candidate && typeof candidate.id === "string" && typeof candidate.householdId === "string"
      ? { id: candidate.id, householdId: candidate.householdId } : null;
  } catch { return null; }
}

export function setDataOwner(owner: DataOwner): void {
  try { localStorage.setItem(OWNER_KEY, JSON.stringify({ id: owner.id, householdId: owner.householdId })); } catch { /* Device access cannot survive a reload without storage. */ }
}

export function clearDataOwner(): void {
  try { localStorage.removeItem(OWNER_KEY); } catch { /* Storage can be disabled. */ }
}
