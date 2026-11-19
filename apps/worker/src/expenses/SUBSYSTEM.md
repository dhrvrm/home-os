---
name: recurring-expenses
definition: >
  The household's authoritative statement of which costs recur, how much
  each costs per period, how often the period repeats, and what portion of
  each cost every participating member bears. It upholds the invariant that
  a recurring expense is a rule, not an event: it names a cadence, a total,
  and a split, and every member's share is derivable from the rule alone
  without any record of a particular period having occurred. It declares no
  ledger of what has been paid or owed; it supplies a period's authoritative
  rule basis when an actual expense is explicitly posted. Without this subsystem the division of
  shared household costs has no shared source of truth.
inputs:
  - name: protected-action-admission
    description: >
      The household access decision for this action, with the verified active
      person, household, and current role, restricted by any connection's
      approved ceiling. Required before disclosure or change so direct and
      connected callers share one authority boundary. Owners and members
      maintain shared facts; viewers inspect them. Claimed actor information
      never substitutes for this decision.
  - name: expense-command
    description: >
      An intent to create, revise, archive, or restore a recurring expense
      rule, carrying the acting member, the originating source and device,
      an idempotent operation identity, and the version of the rule the
      actor last observed. Required so that offline replays are applied
      once and concurrent revisions are detected rather than silently
      overwritten.
  - name: expense-query
    description: >
      A request for the household's recurring expense rules, optionally
      including archived ones, so that any surface can present what recurs
      and what each member bears.
  - name: household-membership
    description: >
      The set of members belonging to the household and whether each is
      currently active. Required because a split names members, the equal
      default is defined over the active set, and a rule naming an inactive
      member must be surfaced as needing attention rather than silently
      resolving.
  - name: recurring-posting-query
    description: >
      A chosen recurring rule, observed version, and intended cadence
      period supplied by the household expense ledger. Required to resolve
      one explicit posting against the current active rule and membership
      without treating the passing of time as proof a cost occurred.
outputs:
  - name: expense-command-outcome
    description: >
      The result of applying a command: the accepted rule with its new
      version and resolved shares; or a conflict carrying the current rule
      when the observed version is stale; or a rejection naming the field
      and reason when the rule would violate an invariant.
  - name: expense-state
    description: >
      The household's recurring expense rules, each with its version,
      cadence, total, split rule, and the resolved per-member shares,
      so that surfaces and offline replicas can present shares without
      recomputing the split themselves.
  - name: expense-change-record
    description: >
      For every accepted command, which rule changed, what action occurred,
      which fields changed from what to what, and who caused it through
      which source. Emitted so the household's audit trail and activity
      feed include expense changes without this subsystem knowing how they
      are recorded.
  - name: recurring-posting-basis
    description: >
      The requested rule's current version, active lifecycle, currency,
      exact total, valid cadence period, and resolved participant shares,
      or the reason the requested posting basis is invalid. Supplied to
      the household expense ledger so it can preserve the accepted rule
      snapshot and one period's provenance while recording separately
      declared actual payers and expense date. Does not itself record a
      charge, confirm payment, or change an earlier posted expense.
---
