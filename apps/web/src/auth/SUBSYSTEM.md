---
name: member-access-experience
definition: >
  Keeps a person's visible household experience consistent with their
  established access and the data retained on this device. Returning access
  may reveal the same member's saved household work while disconnected only
  until the last accepted grant expires. Expiry preserves that person's
  pending work behind fresh proof; explicit departure or a change of person
  removes the previous person's local household state before another person
  can use it. Without this subsystem persisted sign-in and offline work can
  disagree about whose information and pending actions are on the device.
inputs:
  - name: member-session-intent
    description: >
      The person's intent to enter, remain signed in, leave, replace their
      password, or maintain household members. Includes transient identity
      proof and explicit decisions about pending work. This meaning enters
      from the person using the household application.
  - name: member-access-outcome
    description: >
      The authority's accepted or refused access result, including the
      verified member and household, current role, and grant expiry.
      Required to display authenticated, locked, and retryable states without
      treating a remembered name as fresh authority.
  - name: household-membership
    description: >
      The household's stable member identities, display information, roles,
      and active status. Required to show the member roster and let owners
      maintain access while retaining departed members' historical identity.
  - name: device-access-evidence
    description: >
      The last accepted non-secret access result, connectivity, retained
      household work, and access changes observed elsewhere on this device.
      Supplied by the device environment so reopening, reconnection, and
      simultaneous views respect the same member boundary. Passwords and
      reusable identity proofs are excluded from retained application data.
  - name: present-time
    description: >
      The current device moment. Required to stop exposing saved household
      work when the last accepted access grant has expired, even before a
      connection is available to obtain a new decision.
outputs:
  - name: member-access-request
    description: >
      The person's access or member-maintenance intent and transient proof,
      passed to the household authority for a decision. Remembering access
      requests a bounded continuing grant; saving a password is delegated
      to the person's password manager rather than retained by the app.
  - name: device-access-verdict
    description: >
      Whether household views may open, must remain locked, or must clear
      the prior person's saved household state and pending work. Supplied to
      the local household experience before it mounts or resumes, including
      when another view signs out or the current authority refuses access.
---
