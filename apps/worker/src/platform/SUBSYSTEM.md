---
name: household-change-accountability
definition: >
  Makes an accepted household change attributable, repeatable without
  duplication, and inspectable in its allowed visibility. The domain fact,
  operation acknowledgement, and applicable history share one acceptance
  boundary; none may claim success while another is absent. Acceptance and
  replay require authority that is current for the exact acting grant and
  action, not merely an earlier admission. Shared activity explains accepted
  before-and-after facts while private activity stays with its person.
  Without this subsystem an uncertain response can duplicate a change or
  accepted facts can lose their accountable cause.
inputs:
  - name: protected-action-admission
    description: >
      The intended action's verified actor, household, current role, subject,
      and continuing grant restricted by any approved connection ceiling.
      Required both when accepting a change and when returning a previous
      acceptance, so revocation, departure, demotion, or replacement of
      identity proof cannot be bypassed by an older operation receipt.
  - name: command-context
    description: >
      Accountable actor, household, origin, operation identity, intended
      action, and observed version supplied by the application boundary.
      Required to bind one operation to one person's complete intent,
      reject conflicting reuse, and explain direct or connected changes.
  - name: change-record
    description: >
      Accepted inventory changes and their before-and-after facts and
      resulting versions. Required to retain accountable stock history
      without turning a rejected observation into accepted activity.
  - name: expense-change-record
    description: >
      Accepted recurring-rule changes, their actor and origin, and prior
      and resulting facts. Required to explain changing cost intentions
      separately from an actual expense or repayment.
  - name: ledger-change-proposal
    description: >
      A validated expense, linked refund, repayment, comment, correction,
      void, or restoration transition with operation identity, actor,
      origin, before-and-after facts, versions, and reversing or replacement
      money effects. Includes the current-state conditions that must still
      hold for the transition, such as refund bounds and period uniqueness.
      Required to accept financial facts, effects, history, and retry
      acknowledgement together under current authority or leave all
      unchanged; a valid proposal alone is not an accepted change.
  - name: cooking-change-record
    description: >
      Accepted recipe, meal-announcement, and personal attendance changes.
      Required to explain household planning without treating a reminder
      delivery attempt as a changed cooking commitment.
  - name: contact-change-record
    description: >
      Accepted shared contact changes and their accountable origin.
      Required to explain maintenance without implying membership changes.
  - name: access-change-record
    description: >
      Accepted non-secret membership and access changes with attributable
      actor, origin, and allowed visibility. Required for accountability
      without revealing identity proof or private connection credentials.
  - name: activity-query
    description: >
      An admitted reader's household activity interests and bounded
      continuation supplied by direct or connected household interaction.
      Required to inspect relevant accepted changes within their allowed
      visibility rather than expose unrelated private activity.
outputs:
  - name: household-change-acceptance
    description: >
      The resulting accepted transition and retry acknowledgement, an
      already accepted identical operation, or a refusal because authority,
      observed state, domain conditions, or operation identity no longer
      permit acceptance. Supplied to the household expense ledger so it
      can report a fact as saved only when its monetary effects, durable
      history, and accountable receipt were accepted together. A repeated
      result never creates another financial effect or revives a revoked
      acting grant.
  - name: activity-state
    description: >
      Bounded household-scoped accepted change history, including actor,
      origin, affected fact, operation identity, prior and resulting
      versions, and visible before-and-after differences. Supplied to
      direct or connected household readers for an attributable explanation
      of what changed. Financial history includes reversals and replacement
      effects, while secret proof and another person's private activity
      remain excluded. It records accepted facts rather than attempted
      commands or proof that external money moved.
---
