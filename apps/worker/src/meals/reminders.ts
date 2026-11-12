import type { MealReminderCandidate } from "./model";

interface CandidateRow {
  meal_id: string;
  announcement_version: number;
  member_id: string;
  title: string;
  recipes_json: string;
  cooking_at: string;
  reminder_at: string;
  timezone: string;
}

const ELIGIBLE = `m.household_id = ? AND m.status = 'scheduled' AND m.reminder_at <= ? AND m.cooking_at > ?
  AND p.archived_at IS NULL AND p.role IN ('owner', 'member')
  AND (a.member_id IS NULL OR a.announcement_version <> m.announcement_version OR a.response = 'pending')`;
const FROM = `FROM meals m JOIN members p ON p.household_id = m.household_id
  LEFT JOIN meal_attendance a ON a.household_id = m.household_id AND a.meal_id = m.id AND a.member_id = p.id`;

export async function listDueMealReminders(
  database: D1Database,
  householdId: string,
  now: string,
  limit = 100,
  after?: string,
): Promise<MealReminderCandidate[]> {
  const bounded = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), 200))
    : 100;
  let position: string[] | undefined;
  if (after) {
    try {
      const decoded: unknown = JSON.parse(after);
      if (
        Array.isArray(decoded) &&
        decoded.length === 3 &&
        decoded.every((part) => typeof part === "string" && part.length <= 128)
      )
        position = decoded;
    } catch {
      /* A malformed internal cursor restarts the bounded scan. */
    }
  }
  const parameters = [householdId, now, now, ...(position ?? []), bounded];
  const rows = await database
    .prepare(
      `SELECT m.id AS meal_id, m.announcement_version, p.id AS member_id, m.title,
            m.recipes_json, m.cooking_at, m.reminder_at, m.timezone
     ${FROM} WHERE ${ELIGIBLE} ${position ? "AND (m.reminder_at, m.id, p.id) > (?, ?, ?)" : ""} ORDER BY m.reminder_at, m.id, p.id LIMIT ?`,
    )
    .bind(...parameters)
    .all<CandidateRow>();
  return rows.results.map((row) => ({
    cursor: JSON.stringify([row.reminder_at, row.meal_id, row.member_id]),
    mealId: row.meal_id,
    announcementVersion: row.announcement_version,
    memberId: row.member_id,
    title: row.title,
    recipeNames: (JSON.parse(row.recipes_json) as Array<{ name: string }>).map(
      (recipe) => recipe.name,
    ),
    cookingAt: row.cooking_at,
    reminderAt: row.reminder_at,
    timezone: row.timezone,
  }));
}

export async function isMealReminderEligible(
  database: D1Database,
  householdId: string,
  mealId: string,
  announcementVersion: number,
  memberId: string,
  now: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS eligible ${FROM} WHERE ${ELIGIBLE}
     AND m.id = ? AND m.announcement_version = ? AND p.id = ? LIMIT 1`,
    )
    .bind(householdId, now, now, mealId, announcementVersion, memberId)
    .first();
  return row !== null;
}
