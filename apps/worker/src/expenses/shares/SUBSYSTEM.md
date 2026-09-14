---
name: share-resolver
definition: >
  Turns a total amount and a split rule into one exact amount per
  participant. The split rule is equal by default; any participant may
  instead be assigned a fixed amount or a percentage of the total. Fixed
  amounts are taken from the total first, percentages are taken from the
  total next, and the remainder is divided equally among participants with
  no override. It upholds that the resolved shares sum exactly to the
  total in the currency's minor unit, that any rounding remainder is
  assigned deterministically so every environment computing the same rule
  reaches the same answer, and that a rule whose overrides exceed the total
  or leave nobody to absorb the remainder is unresolvable rather than
  silently adjusted. It knows nothing of households, cadences, or
  persistence, so the same resolution can be reproduced offline and, later,
  per period by a ledger. Without it shares would be recomputed
  inconsistently wherever they are displayed.
inputs:
  - name: split-request
    description: >
      A total amount, the currency's minor unit, the participants, and each
      participant's override (fixed amount or percentage) if any.
outputs:
  - name: resolved-shares
    description: >
      One exact amount per participant summing to the total, or the reason
      the split cannot be resolved.
---
