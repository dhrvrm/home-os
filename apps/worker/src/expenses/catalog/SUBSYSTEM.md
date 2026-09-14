---
name: expense-catalog
definition: >
  Holds each recurring expense rule and governs its lifecycle: a name, a
  total amount in a currency, a cadence stating how often the period
  repeats from an anchor date, the participating members, and each
  participant's share override if any. It upholds that every participant is
  a household member, that a rule's total, cadence, and participants are
  always coherent, that revisions are versioned so stale revisions are
  refused, and that archiving hides a rule without destroying it. It does
  not compute shares; it asks the share resolver and refuses any rule whose
  split cannot be resolved. Without it there is nothing to which a split
  applies.
inputs:
  - name: expense-command
    description: >
      An intent to create, revise, archive, or restore a rule, carrying
      actor, source, device, idempotent operation identity, and the last
      observed version.
  - name: expense-query
    description: >
      A request for rules, optionally including archived ones.
  - name: household-membership
    description: >
      Which members exist and which are active, to validate participants
      and to flag rules naming inactive members.
  - name: resolved-shares
    description: >
      The per-member amounts that a rule's split yields for its total, or
      the reason the split is unresolvable. Required to reject incoherent
      splits on write and to present shares on read.
outputs:
  - name: split-request
    description: >
      A rule's total amount, its currency's minor unit, its participants,
      and each participant's override if any, handed over so shares can be
      resolved without the resolver knowing anything else about the rule.
  - name: expense-command-outcome
    description: >
      The accepted rule with new version and shares, a conflict with the
      current rule, or a rejection naming the field and reason.
  - name: expense-state
    description: >
      All rules with versions, cadences, totals, split rules, and resolved
      shares.
  - name: expense-change-record
    description: >
      Which rule changed, how, by whom, through which source, for every
      accepted command.
---
