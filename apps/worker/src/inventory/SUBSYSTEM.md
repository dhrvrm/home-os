---
name: household-inventory
definition: >
  Holds what a household keeps, where it is kept, how much of it there is,
  and whether it needs attention. It upholds one invariant: every item's
  current state is the deterministic result of its declared description plus
  the ordered history of stock observations, so any reader at any time sees
  the same truth. From that truth it derives replenishment signals of two
  distinct origins — observed (usage forecast and consumption cadence,
  inferred from history) and declared (a stated restock interval, imposed by
  the household because some goods spoil or run out by time rather than by
  count). Both origins converge on a single attention verdict: why, if at
  all, this item should be bought next. Without this subsystem the household
  has no shared memory of its stock and no reason-bearing answer to "what do
  we need".
inputs:
  - name: item-declaration
    description: >
      The household's statement of an item: its name and aliases, categories,
      storage location, counting unit and tracking mode, low-stock threshold,
      and — when the household chooses — how often it must be restocked
      regardless of observed level. Carries the intent of what is kept and
      what "enough" means for it.
  - name: stock-observation
    description: >
      A fact about an item's stock at a moment: something was consumed, it
      was restocked, or its level was marked. Carries what happened so the
      item's current state and its history can be reconciled.
  - name: item-lifecycle-decision
    description: >
      Whether an item still belongs to the household's active inventory
      (archived or restored). Carries retirement intent without erasing
      history.
  - name: catalogue-query
    description: >
      Which items a reader wants to see: text match, category, stock level,
      and archived-ness. Carries the reader's narrowing of interest.
  - name: command-context
    description: >
      Who is acting, for which household, under which operation identity and
      expected version. Required so each change is attributable,
      idempotent, and conflict-checked against concurrent editors.
  - name: present-time
    description: >
      The moment "now". Required because every derived signal — days
      remaining, cadence, restock due-ness — is a relation between recorded
      history and the present.
outputs:
  - name: item-state
    description: >
      An item's declared description, its current stock, and its
      replenishment signals: observed usage forecast, observed consumption
      cadence, declared-interval due status (due soon or overdue, measured
      from the last restock), and the resulting attention verdict with its
      reason. Provided so readers and shopping views can show both what the
      item is and why it matters right now.
  - name: stock-history
    description: >
      The ordered observations recorded for an item. Provided so the origin
      of the current state can be inspected and trusted.
  - name: change-record
    description: >
      For every accepted mutation, the before/after differences, the
      action performed, and the new version. Provided so the household's
      audit trail and offline synchronisation can replay or reconcile it.
  - name: declaration-rejection
    description: >
      Which part of a declaration or observation violated an invariant and
      why. Provided so the actor can correct the input rather than have it
      silently altered.
---
