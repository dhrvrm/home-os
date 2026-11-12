import { homeOSDatabase } from "@/offline/db";
import type { AuthUser } from "@/lib/auth";
import type { WorkLease } from "@/auth/work";
export interface SavedCopy<T> {
  data: T;
  savedAt: string;
  cached: boolean;
}
export function cacheKey(user: AuthUser, domain: string): string {
  return JSON.stringify([user.householdId, user.id, domain]);
}
export async function readCopy<T>(
  user: AuthUser,
  domain: string,
  valid: (data: unknown) => data is T,
  lease: WorkLease,
): Promise<SavedCopy<T> | null> {
  lease.check();
  const row = await homeOSDatabase.householdCache.get(cacheKey(user, domain));
  lease.check();
  if (
    !row ||
    row.householdId !== user.householdId ||
    row.memberId !== user.id ||
    !valid(row.data) ||
    !Number.isFinite(Date.parse(row.savedAt))
  )
    return null;
  return { data: row.data, savedAt: row.savedAt, cached: true };
}
export async function writeCopy<T>(
  user: AuthUser,
  domain: string,
  data: T,
  lease: WorkLease,
): Promise<SavedCopy<T>> {
  lease.check();
  const savedAt = new Date().toISOString();
  await homeOSDatabase.transaction(
    "rw",
    homeOSDatabase.householdCache,
    async () => {
      lease.check();
      await homeOSDatabase.householdCache.put({
        key: cacheKey(user, domain),
        householdId: user.householdId,
        memberId: user.id,
        data,
        savedAt,
      });
      // An access change aborts this transaction, rather than committing a late private copy.
      lease.check();
    },
  );
  lease.check();
  return { data, savedAt, cached: false };
}
