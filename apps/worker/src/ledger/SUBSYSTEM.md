---
name: household-expense-ledger
definition: >
  Preserves accepted household expenses, linked refunds, and recorded
  repayments so each person's contribution, share, and remaining balance
  can be explained. Only accepted financial history changes a balance.
  Each expense conserves its total across both payers and beneficiaries;
  each repayment conserves value between two people; a refund reverses
  contributions and shares rather than pretending another purchase occurred.
  Every amount is exact in its currency's smallest unit and currencies never
  offset each other. Rounding residuals are distributed by a stable stated
  ordering and remain visible in the resolved allocation; identical facts
  produce identical shares. Corrections, voids, and restorations preserve prior
  accepted facts and expose their reversing and replacement effects.
  Recurring intentions become actual expenses only through an explicit
  accepted posting. Without this subsystem recurring plans and informal
  claims cannot establish an explainable household balance.
inputs:
  - name: protected-action-admission
    description: >
      The exact requested action's verified household, active actor, current
      role, and continuing authority, restricted by a connection's approved
      ceiling when present. Required before every disclosure, acceptance,
      or replay. Owners and members maintain shared financial facts and
      comments; viewers inspect them. Current authority must still hold
      when a change and its accountability become accepted together.
  - name: household-membership
    description: >
      Stable household people, display information, roles, and active state.
      Required to select current people for new expenses without discarding
      departed people's existing contributions, shares, comments, or debts.
      Historical corrections and linked refunds retain their original
      people, and repayments may resolve balances involving departed people.
      A shared contact alone is not a financial participant.
  - name: ledger-command
    description: >
      A proposed expense, linked refund, repayment, attributed comment,
      correction, void, restoration, or explicit posting of a recurring
      rule for its chosen period. Carries accountable origin, an operation
      identity bound to its actor and complete intent, and the observed
      version for an existing fact. Expenses identify date, description,
      currency, category, notes, actual payers, beneficiaries, and either a
      whole-bill split or item assignments. Equal, exact amount, percentage,
      weighted shares, and mixed allocations must resolve without silently
      changing the entered intention. In a mixed allocation, fixed amounts
      are assigned first, percentages refer to the original total, and the
      remaining people absorb the remainder by declared weights or equally
      when none are declared. An exact or percentage-only split must cover
      the whole total; unassigned residue and excessive overrides are
      refusals, not hidden balancing charges. Item amounts, assignments,
      discounts, tax, and tips must explain the final total and each person's
      share. Bill-wide monetary adjustments follow aggregate item-derived
      participant cost proportions with explicit deterministic rounding, and cannot
      create a negative bill or negative participant allocation.
      Repayments identify sender, receiver, date, positive amount, currency,
      method, and optional reference; recording them does not move money.
      A reported repayment may change who is in credit or debt and is not
      falsely refused merely because it differs from a current suggestion;
      its resulting balance effect must be explainable.
      Refunds identify an accepted expense and positive amounts returned to
      its payers and credited to its beneficiaries in the same currency.
      Active refunds cannot exceed the original expense's remaining amount
      or a person's remaining original contribution or share. A change to
      the original must preserve those bounds, so an expense with active
      linked credits cannot be voided before those credits are voided.
      Restoring a credit requires its original expense to remain effective.
      A comment retains its admitted author's identity and accepted text;
      further explanation is appended rather than silently rewriting an
      earlier comment. Comments explain records without changing money.
      Required to distinguish an attempted change from an accepted fact.
  - name: ledger-query
    description: >
      The admitted reader's bounded selection of financial records,
      comments, history, member statements, balances, repayment suggestions,
      or exportable statements. Includes relevant dates, text, category,
      participant, currency, lifecycle, and continuation interests. Required
      to find and explain household money without unbounded disclosure or
      treating a partial page as the complete household total.
  - name: recurring-posting-basis
    description: >
      The selected recurring rule's current version, lifecycle, currency,
      exact total, resolved participant shares, and valid chosen period,
      or a reason it cannot be posted. Required to capture an attributable
      rule snapshot while the caller separately declares actual payers and
      expense date. The rule and membership basis must still be valid at
      acceptance. A later rule edit cannot alter a posted expense.
  - name: household-change-acceptance
    description: >
      The accountable acceptance of a proposed financial transition, its
      existing identical receipt, or the reason acceptance was refused.
      Supplied by household change accountability only while the exact
      acting authority remains valid. Required before financial changes
      are reported as accepted so record history, monetary effects, and
      retry acknowledgement cannot disagree or appear only in part.
outputs:
  - name: recurring-posting-query
    description: >
      A selected recurring rule, the version the person observed, and the
      intended cadence period, supplied to recurring expenses. Required to
      establish the authoritative basis for one explicit financial posting
      rather than infer that a scheduled cost was paid.
  - name: ledger-command-outcome
    description: >
      An accepted financial fact or comment with its resulting version and
      exact allocations, a conflict showing the current relevant state,
      or a refusal naming the violated condition. An identical authorized
      retry returns its existing acceptance without duplicating money;
      reusing an operation identity for different intent is refused.
      One recurring rule and period can produce at most one original
      expense even after voiding, and subsequent corrections or restoration
      operate on that expense. Required so surfaces can retain failed work,
      recover concurrent changes, and never count pending input as money.
  - name: ledger-state
    description: >
      Household financial records, payer contributions, resolved beneficiary
      shares, item and adjustment explanations, attributed comments,
      effective lifecycle, and complete retained revision provenance.
      Supplies bounded record and statement pages with honest continuation,
      separately scoped totals, and balances grouped by currency. Each
      person's net is their paid contributions less allocated consumption,
      with refund effects reversed and recorded repayments sent added and
      received subtracted. Every currency's member balances sum to zero.
      Repayment suggestions connect net debtors to net creditors and explain
      how much each could pay; they are a deterministic derived suggestion,
      not uniquely established original counterparty debt, an executed
      transfer, or a claim of the globally fewest payments. Per-expense
      paid-versus-share detail and member statements explain the sources of
      the net without maintaining a competing direct-debt authority.
      Exports identify their currency, scope, continuation, and accepted
      history basis so opening, movements, and closing reconcile. Historical
      people remain identifiable. Required for all surfaces to explain the
      same accepted financial truth and distinguish snapshots from live data.
  - name: ledger-change-proposal
    description: >
      The validated financial or comment transition, attributable person and
      origin, operation identity, affected record, prior and resulting
      versions, and visible before-and-after facts with reversing and
      replacement monetary effects. Supplied to household accountability
      for indivisible acceptance with the current authority, observed
      state, refund limits, and period uniqueness still satisfied. The
      proposed record, effects, history, and retry acknowledgement must all
      become accepted together or none does. Required to preserve the
      complete cause of financial changes without treating a proposal as
      an accepted fact or reconstructing history from the current balance.
---
