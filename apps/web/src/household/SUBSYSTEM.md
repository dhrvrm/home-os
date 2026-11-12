---
name: household-planning-experience
definition: >
  Lets a person maintain shared cooking plans and contacts, answer whether
  they will eat, and control reminders while seeing which household facts
  were actually accepted. The visible plan, current identity, and actions
  offered must agree; an old view or arriving reminder cannot act for a
  different person. Without this subsystem the household's accepted facts
  and authority exist without a coherent daily planning experience.
inputs:
  - name: household-planning-intent
    description: >
      The person's intention to browse or maintain recipes, scheduled meals,
      contacts, and reminders, or to answer their own meal attendance.
      Supplied by the person using the app and includes their explicit
      choices about device notification permission.
  - name: member-access-outcome
    description: >
      The accepted current person, household, role, and continuing grant
      supplied by household access. Required to distinguish an owner,
      participating member, and viewer and to associate personal responses
      and reminders with the person who actually entered the home.
  - name: device-access-verdict
    description: >
      Whether household views may open, must lock, or must clear the prior
      person's state, supplied by the member access experience. Required
      so delayed replies and notifications cannot reopen or mutate another
      person's household view after access changes.
  - name: household-membership
    description: >
      The household's stable people, display names, roles, and active state
      supplied by household access. Required to identify owners and meal
      participants without treating a contact as a login identity.
  - name: recipe-catalog
    description: >
      Reusable dishes, instructions, ingredients, lifecycle, serving basis,
      and qualified stock hints supplied by household cooking. Required so
      the person can discover a dish and bring it into a scheduled meal.
  - name: meal-state
    description: >
      The authoritative meal announcements, cooking times and named zones,
      dishes as announced, effective personal responses, and attendance
      totals supplied by household cooking. Required to present tomorrow
      or a seven-day period without confusing unanswered with not eating.
  - name: cooking-command-outcome
    description: >
      The cooking authority's accepted change, current conflicting state,
      or refusal. Required to preserve editable input on failure and show
      that a recipe, schedule, or answer was saved only after acceptance.
  - name: contact-state
    description: >
      The matching shared contacts, their purposes, channels, lifecycle,
      and versions supplied by household contacts. Required to show useful
      contact details and offer appropriate device call or message actions.
  - name: contact-command-outcome
    description: >
      The contact authority's accepted change, current conflicting state,
      or refusal. Required to make shared contact edits understandable and
      recoverable instead of silently losing unsaved information.
  - name: notification-state
    description: >
      The person's recent reminders, reading state, delivery preferences,
      and registered-device status supplied by household reminders. Required
      to distinguish an inbox reminder from permission to deliver it outside
      the app and to show whether delivery was actually enabled.
  - name: notification-command-outcome
    description: >
      The reminder authority's accepted personal change or refusal.
      Required so permission or device-registration failures remain visible
      and the person can retry without believing delivery is already active.
  - name: notification-permission-state
    description: >
      The device's delivery capabilities and the person's granted, denied,
      or undecided notification permission, supplied by the device
      environment. Required to ask only after explicit intent and explain
      unsupported or denied delivery without blocking the ordinary inbox.
  - name: notification-arrival
    description: >
      A delivered reminder and its intended person, household, announcement,
      and return location, supplied by the device delivery environment.
      Required to return to the current meal through the access boundary;
      a reminder whose recipient cannot be verified may expose only generic
      app information rather than a previous person's household details.
  - name: present-time
    description: >
      The current device moment supplied by the device environment.
      Required to explain local cooking times, upcoming dates, and stale
      displayed information while leaving final acceptance to the authority.
outputs:
  - name: recipe-maintenance-intent
    description: >
      The person's proposed reusable dish and lifecycle changes, supplied
      to household cooking with the version they observed. Required to
      turn an editable recipe form into an accountable shared decision.
  - name: menu-maintenance-intent
    description: >
      The person's selected dishes, unambiguous cooking moment and named
      time zone, reminder lead time, notes, and cancellation intention,
      supplied to household cooking with the announcement they observed.
      Required to establish or revise an actual household meal.
  - name: meal-attendance-intent
    description: >
      The admitted person's own answer to the announcement currently shown,
      supplied to household cooking. Required to ask whether that person
      is eating without presenting authority to answer for somebody else.
  - name: cooking-query
    description: >
      The requested recipe selection or bounded local-date period, supplied
      to household cooking. Required for tomorrow, a seven-day menu, and
      recoverable archived recipes to reveal the intended records.
  - name: contact-maintenance-intent
    description: >
      The person's proposed shared contact details and lifecycle changes,
      supplied to household contacts with the observed version. Required
      to maintain useful references without implying membership changes.
  - name: contact-query
    description: >
      The person's contact search, category, and lifecycle interests,
      supplied to household contacts so discovery remains household-scoped.
  - name: notification-intent
    description: >
      The admitted person's request to view or acknowledge reminders and
      enable, disable, register, or retire their own permitted device
      delivery, supplied to household reminders. Required to connect explicit
      consent and device capabilities to a continuing personal permission.
  - name: household-planning-presentation
    description: >
      The accepted or pending household plan, contact information, personal
      reminder state, available actions, and actionable failures supplied
      to the person using the app. Required so they can tell what is planned,
      whether their answer counted, and how to recover when a change fails.
---
