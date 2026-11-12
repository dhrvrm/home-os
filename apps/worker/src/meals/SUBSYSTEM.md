---
name: household-cooking
definition: >
  Holds the household's reusable recipes and its announced meals so people
  can agree what will be cooked, when, and for whom. A meal retains the
  selected dishes as announced even when their reusable recipes later
  change. A person's answer belongs to the announcement they saw; changing
  the dishes or cooking time requires renewed assent, while unrelated
  people's answers and explanatory notes cannot invalidate it. Unanswered
  means unknown rather than refusal. Without this subsystem the household
  has recipes and messages but no shared, time-specific cooking commitment
  or trustworthy count of the people joining it.
inputs:
  - name: recipe-maintenance-intent
    description: >
      A member's intention to create, revise, retire, or restore a reusable
      dish, including its name, ingredients, stated quantities and units,
      instructions, serving basis, and optional links to household stock.
      Supplied by the household planning experience so useful dishes can
      be selected repeatedly without rewriting their meaning each time.
  - name: menu-maintenance-intent
    description: >
      A member's intention to announce or revise a meal with one or more
      selected dishes, an unambiguous cooking moment, the named local time
      zone used to understand it, a reminder lead time, and explanatory
      notes, or to cancel that meal. Supplied by the household planning
      experience so the household can distinguish a reusable possibility
      from an actual cooking commitment.
  - name: meal-attendance-intent
    description: >
      An admitted participant's own yes or no answer to the current meal
      announcement. Supplied by the household planning experience with the
      announcement the person observed, so another person cannot impersonate
      their answer and a stale view cannot assent to a changed meal.
  - name: cooking-query
    description: >
      The dishes or bounded local-date period a household reader wants to
      inspect, including retired recipes when explicitly requested.
      Supplied by the household planning experience so tomorrow and the
      coming week refer to the household's named time zone.
  - name: protected-action-admission
    description: >
      The household access decision and verified member authority for the
      requested action. Required before revealing cooking information or
      accepting changes. Owners and members can maintain shared cooking
      plans and answer for themselves; viewers can inspect them.
  - name: command-context
    description: >
      The accountable actor, household, operation identity, and observed
      version supplied by the application boundary. Required so repeated
      commands do not duplicate meals and concurrent edits cannot silently
      replace a newer announcement or another accepted response.
  - name: household-membership
    description: >
      The household's stable people, roles, and active status supplied by
      household access. Required to derive the eligible owner and member
      participants, retain historical attribution, and exclude departed
      people from current attendance totals and reminder questions.
  - name: item-state
    description: >
      The current description, counting basis, availability, and active
      state of household stock supplied by inventory. Required to show
      honest ingredient availability hints without treating an unlinked
      ingredient, incompatible units, or a coarse stock level as proof that
      a recipe's quantities can be fulfilled.
  - name: present-time
    description: >
      The trusted current moment supplied by the execution environment.
      Required to distinguish upcoming cooking from past meals, close
      attendance when cooking begins, and make reminder eligibility expire.
outputs:
  - name: recipe-catalog
    description: >
      The household's reusable dishes and their lifecycle, serving basis,
      ingredients, instructions, versions, and reason-bearing stock hints.
      Supplied to the household planning experience so a member can choose
      dishes without assuming that scheduling them consumes inventory.
  - name: meal-state
    description: >
      The current and retained meal announcements, selected dish snapshots,
      cooking moments and named time zones, reminder timing, cancellation
      state, and each eligible participant's effective response with yes,
      no, and unanswered totals. Supplied to the household planning
      experience so the menu and the cook's headcount express one meaning.
  - name: meal-reminder-state
    description: >
      The current meal announcement identity, cooking and reminder moments,
      readable dishes, and unanswered eligible recipients, together with
      cancellation or supersession that makes an earlier question obsolete.
      Supplied to household reminders for a bounded question before cooking;
      past meals and stale announcements cannot authorize a delivery.
  - name: cooking-command-outcome
    description: >
      The accepted recipe, meal, or personal response; a conflict showing
      the current relevant version; or a refusal explaining the violated
      condition. Supplied to the household planning experience so failure
      never looks like a saved announcement or accepted attendance.
  - name: cooking-change-record
    description: >
      The actor, affected household fact, accepted change, and resulting
      version supplied to household accountability. Preserves the history
      of recipes, announcements, cancellations, and personal answers without
      treating reminder attempts as changes to the cooking commitment.
---
