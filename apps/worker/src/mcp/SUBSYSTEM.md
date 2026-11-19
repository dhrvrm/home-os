---
name: connected-household-interaction
definition: >
  Lets an external client act for a consenting household person through the
  same household authorities used by the direct experience. Every active
  account can connect, including viewers, but a connection conveys only the
  intersection of current role, explicit consent, and ownership of the
  requested subject. Domain truths, accepted changes, conflicts, and
  accountability retain their existing meaning regardless of entry point.
  Actions requiring secret identity proof or native device consent return a
  truthful invitation for direct personal action. Without this subsystem
  external clients must either lack household capabilities or become a
  competing source of permissions and facts.
inputs:
  - name: connected-client-intent
    description: >
      A connected client's request to discover supported household actions,
      establish access, read household facts, or perform a specific change.
      Supplied by the external client with its intended subject, operation
      identity, and observed versions where available. It carries intent
      rather than trusted actor, role, household, or permission.
  - name: connection-access-state
    description: >
      The household authority's identified client, resource, reviewed
      permission ceiling, and allowed non-secret connection records.
      Required to explain what a connection requests or already permits and
      to offer honest connection management.
  - name: connection-access-outcome
    description: >
      The household authority's accepted, refused, continuing, or revoked
      connection decision. Required to complete the client's access exchange
      or direct the person to explicit authorization. Reusable connection
      proof may flow only through the intended client's access exchange and
      never through ordinary household action results.
  - name: protected-action-admission
    description: >
      The authority's decision for the exact action and subject, verified
      active actor and household, current role, and approved connection
      limits. Required before every household disclosure or action;
      discovery can describe only capabilities available within this
      boundary. A connected client cannot supply its own actor or bypass
      later checks at acceptance.
  - name: member-access-outcome
    description: >
      The household authority's accepted or refused membership action and
      non-secret resulting state. Required to distinguish an actual access
      change from a request that still needs direct personal action.
  - name: household-membership
    description: >
      Stable household member identities, display information, roles, and
      active state supplied by household access. Required for roster queries
      and contextual selection without implying authority to edit access.
  - name: item-state
    description: >
      Inventory descriptions, stock state, replenishment reasons, and
      versions supplied by household inventory. Required for listing,
      detail, attention, and stock-aware household questions.
  - name: stock-history
    description: >
      Ordered stock observations supplied by household inventory. Required
      to explain the origin of current inventory state.
  - name: change-record
    description: >
      Accepted inventory changes and resulting versions supplied by
      household inventory. Required to report actual outcomes and allow a
      caller to reconcile the next change.
  - name: declaration-rejection
    description: >
      The inventory invariant violated by a proposed declaration or stock
      observation. Required to return correctable failure instead of
      silently altering the caller's intent.
  - name: expense-state
    description: >
      Recurring expense rules and their resolved member shares supplied by
      recurring expenses. Required to inspect household cost rules without
      inventing a payments ledger.
  - name: expense-command-outcome
    description: >
      An accepted expense rule, current conflicting rule, or reason for
      refusal supplied by recurring expenses. Required so connected editing
      retains the same conflict and share semantics as direct editing.
  - name: ledger-state
    description: >
      Accepted expenses, refunds, repayments, item allocations, attributed
      comments, financial revisions, member statements, scoped totals and
      balances, and derived repayment suggestions supplied by the household
      expense ledger. Required for connected financial inspection and
      exports with the same household visibility and separate currencies
      as the app. Continuation and snapshot scope remain explicit; a page
      is not a complete balance and a suggestion is not a bank transfer.
  - name: ledger-command-outcome
    description: >
      The ledger's accepted financial fact or comment, current conflicting
      state, or refusal. Required for connected recording, corrections,
      reversals, and explicit recurring-period posting to retain the same
      exact allocations, idempotency, refund bounds, and durable history as
      direct editing. A tool invocation alone cannot establish acceptance.
  - name: recipe-catalog
    description: >
      Reusable dishes, instructions, ingredients, serving basis, lifecycle,
      versions, and qualified stock hints supplied by household cooking.
      Required to choose real reusable dishes without claiming that an
      availability hint reserves or consumes stock.
  - name: meal-state
    description: >
      Accepted meal announcements, selected dish snapshots, cooking times
      and zones, effective personal responses, and headcounts supplied by
      household cooking. Required to answer date-bounded menu questions and
      inspect attendance accurately.
  - name: cooking-command-outcome
    description: >
      The accepted recipe, announcement, or personal response, current
      conflict, or refusal supplied by household cooking. Required to
      preserve announcement and response concurrency when an external client
      acts.
  - name: contact-state
    description: >
      Shared contact references, channels, lifecycle, and versions supplied
      by household contacts. Required to discover useful household contacts
      without treating them as login members.
  - name: contact-command-outcome
    description: >
      The accepted shared contact, current conflicting state, or refusal
      supplied by household contacts. Required for truthful and recoverable
      connected maintenance.
  - name: notification-state
    description: >
      The admitted person's own reminder inbox, reading state, preferences,
      and non-secret delivery status supplied by household reminders.
      Required to let each person manage their reminders without revealing
      another person's inbox or receiving secrets.
  - name: notification-command-outcome
    description: >
      An accepted personal reminder change or refusal supplied by household
      reminders. Required to distinguish a preference change from actual
      device enrollment or delivery.
  - name: activity-state
    description: >
      Household-scoped accepted change history supplied by household
      accountability. Required to explain who changed a fact without
      revealing secret proof or operational diagnostics.
outputs:
  - name: connection-access-request
    description: >
      The client's proposed resource and action ceiling, proof of its
      permitted connection, or the admitted person's allowed inspection or
      revocation request, supplied to household access. Required so one
      authority establishes, continues, limits, and ends delegated access.
      Explicit personal consent is collected through the direct household
      experience.
  - name: protected-action-request
    description: >
      The client's exact action and intended subject with current connection
      proof, supplied to household access. Required to derive the
      accountable person and effective permissions afresh rather than
      trusting a role saved at connection creation.
  - name: member-access-request
    description: >
      An admitted owner's requested non-secret member profile, role,
      activation, or deactivation change with accountable operation context,
      supplied to household access. Required to reuse the same membership
      authority and last-owner protection as the direct experience.
      Credential entry and replacement instead require an interactive
      handoff.
  - name: command-context
    description: >
      The verified actor and household, connected origin, operation
      identity, and observed domain version supplied to household
      authorities. Required so connected commands are attributable,
      repeatable without duplication, and conflict-checked wherever the
      domain has an observed version; caller-claimed actor information never
      supplies authority.
  - name: item-declaration
    description: >
      The admitted person's inventory description, categories, location,
      units, tracking basis, threshold, and optional restock cadence,
      supplied to household inventory. Required to create or revise the same
      inventory facts maintained through the direct experience.
  - name: stock-observation
    description: >
      The admitted person's consumption, restock, or stock-level observation
      supplied to household inventory. Required to change stock through its
      authoritative history rather than overwrite a derived level.
  - name: item-lifecycle-decision
    description: >
      The admitted person's request to archive or restore an inventory item,
      supplied to household inventory. Required to preserve recoverable
      lifecycle and history.
  - name: catalogue-query
    description: >
      The admitted reader's item selection, text, category, stock, and
      lifecycle interests supplied to household inventory. Required to
      narrow household-scoped inventory inspection.
  - name: expense-command
    description: >
      The admitted person's create, revise, archive, or restore intention
      for a recurring expense rule with accountable context and observed
      version, supplied to recurring expenses. Required to apply the
      existing cadence and exact-share rules without creating payment or
      settlement behaviour.
  - name: expense-query
    description: >
      The admitted reader's selection of recurring expense rules and
      archived state supplied to recurring expenses. Required to expose
      existing rules and resolved shares.
  - name: ledger-command
    description: >
      The admitted person's expense, itemized bill, linked refund,
      repayment, comment, correction, void, restoration, or explicit
      recurring-period posting with complete intent, operation identity,
      and observed version. Supplied to the household expense ledger so
      every connected financial write uses the same current authority,
      conservation, acceptance, and history boundary as the app. Caller
      supplied identity cannot impersonate a payer's assent or a comment
      author, and recording money does not execute a payment.
  - name: ledger-query
    description: >
      The admitted reader's bounded financial record, search, comment,
      revision, balance, repayment-suggestion, member-statement, or export
      interests. Supplied to the household expense ledger so all active
      users can inspect permitted household finances within their approved
      connection ceiling without assuming access to other households.
  - name: recipe-maintenance-intent
    description: >
      The admitted person's proposed reusable dish, ingredients,
      instructions, serving basis, and lifecycle change supplied to
      household cooking. Required to maintain the same recipe catalog as the
      direct experience.
  - name: menu-maintenance-intent
    description: >
      The admitted person's dishes, cooking moment and named zone, reminder
      lead time, notes, or cancellation intention supplied to household
      cooking. Required to create or revise an actual announcement while
      preserving the meaning of previously observed attendance.
  - name: meal-attendance-intent
    description: >
      The admitted eligible person's own answer and the announcement they
      observed, supplied to household cooking. Required to express
      participation without impersonating another member or assenting to a
      changed announcement.
  - name: cooking-query
    description: >
      The admitted reader's requested dishes or bounded local-date period,
      supplied to household cooking. Required to support tomorrow and seven-
      day questions with the same household calendar meaning.
  - name: contact-maintenance-intent
    description: >
      The admitted person's contact details and lifecycle change with
      observed version supplied to household contacts. Required to maintain
      shared references without creating household access.
  - name: contact-query
    description: >
      The admitted reader's contact search, category, and lifecycle
      interests supplied to household contacts. Required to discover the
      intended household references.
  - name: notification-intent
    description: >
      The admitted person's request to read or acknowledge their own
      reminders and change their own delivery preferences, supplied to
      household reminders. Required for personal control without enrolling a
      device, granting native permission, or accessing another person's
      receiving secrets.
  - name: activity-query
    description: >
      The admitted reader's household change-history interests and bounded
      selection supplied to household accountability. Required for
      inspectable activity under the same household boundary as other reads.
  - name: interactive-action-handoff
    description: >
      The requested account creation, identity-proof replacement, or device
      enrollment action and its safe household destination, supplied through
      the client to the member access or household planning experience.
      Required when completion needs the person's secret proof or native
      device consent. It means action required, never account created,
      password changed, or delivery enabled.
  - name: connected-client-result
    description: >
      Supported permitted actions, admitted household facts, accepted
      changes, conflicts, refusals, or explicit requests for direct personal
      action, supplied to the external client. Required so automation can
      reconcile outcomes without treating a suggestion, attempted command,
      or interactive handoff as completed work. Household results contain no
      identity verifiers, reusable access proof, or confidential delivery
      destinations.
---
