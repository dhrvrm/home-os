---
name: household-money-experience
definition: >
  Lets a household person record and understand shared expenses, refunds,
  and repayments with a visible path from entered amounts to accepted
  allocations and balances. The expense being edited, the person acting,
  and the actions offered must agree. An input calculation, unsaved draft,
  repayment suggestion, and recorded payment are visibly different states.
  Cached financial facts remain inspectable for the last admitted person,
  but money changes require connected acceptance. Without this subsystem
  correct financial records remain difficult to enter, explain, or recover
  when access, connectivity, or concurrent changes intervene.
inputs:
  - name: household-money-intent
    description: >
      The person's choice to browse or search financial history, inspect
      member balances and suggested repayments, compose an expense or
      itemized bill, calculate an amount, record a refund or payment, add
      an explanatory comment, correct or reverse an entry, explicitly post
      a recurring period, or export a statement. Supplied by the person
      using the app and required to preserve their intended amount and
      allocation instead of inferring acceptance from input alone.
  - name: member-access-outcome
    description: >
      The accepted person, household, current role, and allowed actions
      supplied by household access. Required to offer shared writes to
      owners and members, financial inspection to viewers, and never infer
      financial authority from being named on an expense or repayment.
  - name: device-access-verdict
    description: >
      Whether the current person's household views may open, must lock,
      or must clear retained state and pending input. Required before
      presenting financial caches or applying delayed results so another
      person cannot inherit balances, statements, or editable drafts.
  - name: household-membership
    description: >
      Stable household people, display names, and active state supplied by
      household access. Required for current participant selection and for
      clearly identified historical participants in corrections, refunds,
      balances, and repayment records.
  - name: expense-state
    description: >
      The household's recurring rules, versions, cadences, lifecycle, and
      resolved shares. Required to choose a period for explicit posting
      while explaining that the rule itself is neither an expense nor
      evidence that a payment occurred.
  - name: ledger-state
    description: >
      Accepted financial entries, exact allocations, comments, revision
      history, scoped balances and totals, derived repayment suggestions,
      and exportable statements supplied by the ledger. Required to show
      each currency separately, explain before-and-after monetary effects,
      distinguish original payer/share detail from suggested repayments,
      and mark incomplete pages and retained snapshots honestly.
  - name: ledger-command-outcome
    description: >
      The ledger's accepted result, current conflicting state, or refusal.
      Required to announce saved money only after acceptance, preserve
      editable input on failure, and recover an uncertain response through
      the same operation rather than risk a duplicate expense or payment.
  - name: device-money-evidence
    description: >
      Connectivity and the current person's retained accepted financial
      snapshots supplied by the device environment. Required for useful
      disconnected reads with visible freshness while disabling financial
      posting until a connected authority can accept it. Retained inputs
      are drafts, never queued financial authority or accepted balances.
outputs:
  - name: ledger-command
    description: >
      The person's explicit financial or comment intent with accountable
      operation identity and the record version they observed. Supplied to
      the ledger so connected acceptance validates authoritative amounts,
      allocations, authority, and conflicts. An amount calculator is only an
      input aid; its value must obey the same money rules as typed input.
      Corrections, voids, and restoration identify the fact being changed
      rather than erase it, and recording a repayment claims only that the
      person reports a payment, never that the app transferred funds.
  - name: ledger-query
    description: >
      The person's bounded financial search, record, statement, balance,
      history, or export interests supplied to the ledger. Required for
      stable navigation between a balance and its contributing accepted
      facts without confusing a page subtotal with a complete balance.
  - name: expense-query
    description: >
      The person's selection of recurring rules for period posting,
      supplied to recurring expenses. Required to choose an existing rule
      and inspect its current version without duplicating rule authority.
  - name: protected-action-request
    description: >
      The intended financial read or write and subject under current direct
      proof, supplied through the application boundary to household access.
      Required so visible controls are not mistaken for server authority.
  - name: household-money-presentation
    description: >
      The person's accepted or unsaved financial work, selected currency,
      payer and participant allocations, item adjustment explanation,
      comments, member balances, suggested repayments, statements, history,
      available actions, freshness, and recoverable failures. Supplied to
      the person using the app. Required so input, failed attempt, accepted
      record, historical reversal, and external payment remain distinguishable.
---
