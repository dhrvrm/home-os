---
name: household-contacts
definition: >
  Preserves the people and services a household needs to reach, why they
  matter, and the channels through which they can be contacted. A contact
  is a shared reference rather than membership or permission to enter the
  home. Retiring a contact removes it from ordinary selection while keeping
  its identity recoverable. Without this subsystem useful contact details
  remain scattered and lose their household context.
inputs:
  - name: contact-maintenance-intent
    description: >
      A member's intention to create, revise, retire, or restore a named
      person or service, including its purpose or category, contact channels,
      address, and notes. Supplied by the household planning experience so
      shared contact information can be maintained without changing access.
  - name: contact-query
    description: >
      A household reader's search, category, and lifecycle interests.
      Supplied by the household planning experience so a needed contact can
      be found without scanning unrelated household records.
  - name: protected-action-admission
    description: >
      The household access decision and verified member authority supplied
      before contact information is read or changed. Owners and members
      maintain shared contacts; viewers may inspect them.
  - name: command-context
    description: >
      The accountable actor, household, operation identity, and observed
      version supplied by the application boundary. Required to make edits
      attributable and prevent duplicate creation or silent concurrent loss.
outputs:
  - name: contact-state
    description: >
      Matching household contacts with their names, purposes, usable contact
      channels, notes, lifecycle, and versions. Supplied to the household
      planning experience so a member can identify and reach the intended
      person or service.
  - name: contact-command-outcome
    description: >
      The accepted contact, a conflict with its current version, or a
      rejection identifying information the member must correct. Supplied
      to the household planning experience so unsuccessful changes remain
      visible and recoverable.
  - name: contact-change-record
    description: >
      The actor, accepted contact change, and resulting version supplied to
      household accountability. Retains the origin of shared contact changes
      without creating a new household member or granting access.
---
