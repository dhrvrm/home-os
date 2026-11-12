"use client";
import { useRef, useState } from "react";
import { request } from "@/lib/api";
import type { AuthUser } from "@/lib/auth";
import {
  errorMessage,
  householdCommand,
  isConflict,
  operationIntent,
  type Intent,
} from "./api";
import { useHouseholdTask } from "./ui";
export function useCommand(user: AuthUser) {
  const task = useHouseholdTask(user);
  const intents = useRef(new Map<string, Intent>());
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("");
  async function execute<T>(
    key: string,
    path: string,
    method: string,
    input: unknown,
    version: number | undefined,
    accepted: (result: T) => void,
    success = "Saved.",
    conflict?: () => void,
  ) {
    if (pending) return;
    setPending(key);
    setError(undefined);
    setStatus("");
    const intent = operationIntent(
      intents.current.get(key) ?? null,
      path,
      method,
      input,
      version,
    );
    intents.current.set(key, intent);
    await task(
      () => householdCommand<T>(path, method, input, intent, version),
      (result) => {
        intents.current.delete(key);
        setPending(null);
        setStatus(success);
        accepted(result);
      },
      (failure) => {
        setPending(null);
        setError(errorMessage(failure));
        if (isConflict(failure)) conflict?.();
      },
    );
  }
  return { execute, pending, error, status, setError };
}
export function useEditorSave<T extends { id: string; version: number }>(
  user: AuthUser,
  collection: string,
  record: T | undefined,
  onSaved: (saved?: T) => void,
) {
  const command = useCommand(user);
  const task = useHouseholdTask(user);
  const [version, setVersion] = useState(record?.version);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<T | null>(null);
  const [reviewing, setReviewing] = useState(false);
  async function save(input: unknown) {
    if (conflict) return;
    await command.execute<Record<string, T>>(
      "save",
      `/${collection}${record ? `/${encodeURIComponent(record.id)}` : ""}`,
      record ? "PATCH" : "POST",
      input,
      version,
      (result) =>
        onSaved(
          result[
            collection === "recipes"
              ? "recipe"
              : collection === "contacts"
                ? "contact"
                : "meal"
          ],
        ),
      "Saved.",
      () => setConflict(true),
    );
  }
  async function review() {
    setReviewing(true);
    await task(
      () =>
        request<Record<string, T[] | T>>(
          `/api/v1/${collection}${collection === "meals" && record ? `/${encodeURIComponent(record.id)}` : "?archived=include"}`,
        ),
      (result) => {
        const records = result[collection];
        setLatest(
          collection === "meals"
            ? ((result.meal as T) ?? null)
            : Array.isArray(records)
              ? (records.find((item) => item.id === record?.id) ?? null)
              : null,
        );
        setReviewing(false);
      },
      (failure) => {
        command.setError(errorMessage(failure));
        setReviewing(false);
      },
    );
  }
  const conflictUI = conflict ? (
    <section className="hh-notice" aria-label="Review conflict">
      <p>
        This record changed. Your draft is preserved. Review the current record
        before retrying.
      </p>
      <button
        type="button"
        className="button button--quiet"
        disabled={reviewing}
        onClick={() => void review()}
      >
        {reviewing ? "Loading current record…" : "Review current record"}
      </button>
      {latest && (
        <>
          <CurrentRecord value={latest} />
          <button
            type="button"
            className="button"
            onClick={() => {
              setVersion(latest.version);
              setConflict(false);
              setLatest(null);
              command.setError(undefined);
            }}
          >
            I reviewed the changes — keep my draft
          </button>
        </>
      )}
    </section>
  ) : null;
  return { ...command, save, conflict, conflictUI };
}

function CurrentRecord({ value }: { value: object }) {
  const record = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string) : "";
  const list = (key: string) =>
    Array.isArray(record[key])
      ? (record[key] as Array<Record<string, unknown>>)
          .map((item) => String(item.name ?? ""))
          .join(", ")
      : "";
  return (
    <div className="hh-current-record">
      <h4>Current saved record</h4>
      <strong>{text("name") || text("title")}</strong>
      {text("role") && <p>{text("role")}</p>}
      {text("cookingAt") && (
        <p>
          {new Date(text("cookingAt")).toLocaleString(undefined, {
            timeZone: text("timezone"),
          })}{" "}
          · {text("timezone")}
        </p>
      )}
      {list("recipes") && <p>Dishes: {list("recipes")}</p>}
      {list("ingredients") && <p>Ingredients: {list("ingredients")}</p>}
      {text("description") && <p className="hh-lines">{text("description")}</p>}
      {text("instructions") && (
        <p className="hh-lines">{text("instructions")}</p>
      )}
      {text("phone") && <p>{text("phone")}</p>}
      {text("email") && <p>{text("email")}</p>}
      {text("address") && <p>{text("address")}</p>}
      {text("notes") && <p className="hh-lines">{text("notes")}</p>}
      {text("archivedAt") && <p>Archived</p>}
      {text("status") === "cancelled" && <p>Cancelled</p>}
    </div>
  );
}
