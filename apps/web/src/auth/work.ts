export const ACCESS_BOUNDARY_KEY = "home-os:access-boundary:v1";

export class AccessChangedError extends Error {
  constructor() { super("Household access changed. Sign in again before continuing."); }
}

export interface AccessProof { readonly memberId: string | null; readonly boundary: string | null; readonly generation: number }
export interface WorkLease { readonly memberId: string | null; readonly proof: AccessProof; check(): void }
export interface AccessIdentity { id: string; householdId: string }

let generation = 0;
let paused = false;
let memberId: string | null = null;
const tasks = new Set<Promise<unknown>>();

export function readAccessBoundary(): string | null {
  try { return localStorage.getItem(ACCESS_BOUNDARY_KEY); } catch { return null; }
}

export function publishAccessBoundary(state: "locked" | "ready" | "signed-out", member?: AccessIdentity): void {
  try { localStorage.setItem(ACCESS_BOUNDARY_KEY, JSON.stringify({ state, generation: crypto.randomUUID(), ...(member ? { memberId: member.id, householdId: member.householdId } : {}) })); } catch { /* Private browser mode can disable storage. */ }
  try { navigator.serviceWorker?.controller?.postMessage({ type: "HOMEOS_ACCESS_BOUNDARY", state }); } catch { /* Server admission remains the authority when no controller is available. */ }
}

export function boundaryMember(value = readAccessBoundary()): AccessIdentity | null {
  try {
    const boundary = JSON.parse(value ?? "null");
    return boundary?.state === "ready" && typeof boundary.memberId === "string" && typeof boundary.householdId === "string"
      ? { id: boundary.memberId, householdId: boundary.householdId } : null;
  } catch { return null; }
}

export function boundaryState(value = readAccessBoundary()): "locked" | "ready" | "signed-out" | null {
  try {
    const state = JSON.parse(value ?? "null")?.state;
    return ["locked", "ready", "signed-out"].includes(state) ? state : null;
  } catch { return null; }
}

export function activeMemberId(): string | null { return memberId; }
export function setActiveMemberId(id: string | null): void { memberId = id; }

export function captureAccessProof(): AccessProof { return { memberId, boundary: readAccessBoundary(), generation }; }
export function isCurrentAccessProof(proof: AccessProof): boolean {
  const identity = boundaryMember(proof.boundary);
  return proof.generation === generation && proof.memberId === memberId && proof.boundary === readAccessBoundary()
    && (!identity || identity.id === proof.memberId);
}
export function signalSessionExpired(proof: AccessProof): void {
  if (isCurrentAccessProof(proof)) window.dispatchEvent(new CustomEvent("home-os:session-expired", { detail: proof }));
}

export function lockHouseholdWork(): void { paused = true; generation++; memberId = null; }
export function resumeHouseholdWork(): void { generation++; paused = false; }

export async function drainHouseholdWork(): Promise<void> {
  await Promise.allSettled(Array.from(tasks));
}

export function runHouseholdWork<T>(action: (lease: WorkLease) => Promise<T>): Promise<T> {
  const readyMember = boundaryMember();
  if (paused || ["locked", "signed-out"].includes(boundaryState() ?? "") || (readyMember && readyMember.id !== memberId)) return Promise.reject(new AccessChangedError());
  const admittedGeneration = generation;
  const sharedBoundary = readAccessBoundary();
  const admittedMemberId = memberId;
  const admittedIdentity = boundaryMember(sharedBoundary);
  const lease: WorkLease = {
    memberId,
    proof: captureAccessProof(),
    check() {
      const currentBoundary = readAccessBoundary();
      const currentIdentity = boundaryMember(currentBoundary);
      const sameMemberGrant = admittedIdentity !== null && admittedIdentity.id === admittedMemberId && admittedMemberId !== null && admittedMemberId === memberId
        && currentIdentity?.id === admittedMemberId && admittedIdentity.householdId === currentIdentity.householdId;
      if (paused || generation !== admittedGeneration || (sharedBoundary !== currentBoundary && !sameMemberGrant)) throw new AccessChangedError();
    },
  };
  const task = Promise.resolve().then(() => { lease.check(); return action(lease); });
  tasks.add(task);
  void task.then(() => tasks.delete(task), () => tasks.delete(task));
  return task;
}
