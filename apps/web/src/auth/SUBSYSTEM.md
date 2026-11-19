---
name: member-access-experience
definition: >
  Keeps a person's visible household experience consistent with established
  access and the information retained on their device, and lets them knowingly
  authorize or end connected access. Returning direct access has no automatic
  deadline. Retained household work belongs only to the last accepted person;
  departure or a change of person clears that person's local state before
  another person can enter. Remote revocation can be learned only when the
  device communicates, and remembered access is never fresh authority for a
  shared change. Without this subsystem persistent sign-in, disconnected
  work, and connection consent can disagree about whose authority is used.
inputs:
  - name: member-session-intent
    description: >
      The person's intent to enter, remain signed in, leave, replace their
      password, maintain members, or inspect, approve, refuse, and revoke
      connected access. Supplied by the person using the household app and
      includes transient proof and explicit decisions about pending work.
  - name: member-access-outcome
    description: >
      Accepted or refused direct access, including the verified person,
      household, current role, permitted actions, and continuing-grant state.
      Supplied by household access so an authenticated, locked, or retryable
      view never treats a remembered identity as fresh authority.
  - name: connection-access-state
    description: >
      The authority's identified client, intended resource, requested and
      permitted actions, and the person's allowed connection records.
      Required to present explicit consent and understandable per-connection
      revocation without displaying or retaining reusable access proof.
  - name: connection-access-outcome
    description: >
      The authority's accepted approval, refusal, revocation, or requirement
      for personal action. Required so a connection is not shown as approved
      or revoked before the authority accepts the person's decision.
  - name: household-membership
    description: >
      Stable household member identities, display information, roles, and
      active state. Supplied by household access to show the roster and
      owner controls while retaining departed people's historical identity.
  - name: interactive-action-handoff
    description: >
      A requested account or identity-proof action and the safe household
      location where the person can complete it. Supplied by connected
      household interaction as an invitation to act, never proof that a
      member was created or credentials changed. The person must still hold
      the required household authority at acceptance.
  - name: device-access-evidence
    description: >
      The last accepted non-secret access decision, connectivity, retained
      work, and access changes observed elsewhere on this device. Supplied by
      the device environment so reopening and simultaneous views respect one
      person boundary. Device retention can be renewed during use but can be
      lost through clearing, device policy, or the person's departure; such
      loss requires fresh proof without reviving an ended grant. Passwords
      and reusable identity proof are excluded from retained application data.
outputs:
  - name: member-access-request
    description: >
      The person's access or membership intent and necessary transient proof,
      supplied to household access. Remaining signed in requests continuing
      access without an automatic deadline; password saving belongs to the
      person's password manager. Secret proof entry and replacement remain
      direct personal interactions rather than connected-client commands.
  - name: connection-access-request
    description: >
      The proven person's explicit connection approval, refusal, inspection,
      or revocation request and the client, resource, and action ceiling they
      reviewed. Supplied to household access so the authority can accept the
      exact consent decision rather than infer consent from opening a link.
  - name: device-access-verdict
    description: >
      Whether household views may open, must lock, or must clear the previous
      person's saved state and pending work. Supplied to household experiences
      before mounting or resuming, including when another view signs out or
      the authority refuses access. Disconnected retained views remain tied
      to the last accepted identity and cannot establish new shared authority.
      Financial snapshots, statement exports retained by the app, and
      unsaved financial input share this person boundary; no delayed money
      response may repopulate the previous person's state after clearing.
  - name: member-access-presentation
    description: >
      The person's access state, role-appropriate actions, consent details,
      connection status, completed changes, and recoverable failures.
      Supplied to the person using the household app so approval, attempted
      change, and accepted change remain distinguishable.
---
