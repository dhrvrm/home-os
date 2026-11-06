---
name: household-access
definition: >
  Determines which person may act in the household, for how long, and with
  which authority. Membership, proof of identity, and continuing access are
  governed together so that a revoked member cannot retain authority merely
  by keeping an earlier grant. Establishing the first owner requires the
  household operator's authority; later membership changes require an active
  owner. Member identities survive credential changes and departure because
  household history and shared expenses continue to refer to those people.
  Without this subsystem household facts are accessible and mutable without
  an accountable person or an enforceable household boundary.
inputs:
  - name: member-access-request
    description: >
      A person's request to establish, prove, continue, or end access; to
      replace their own proof of identity; or, with owner authority, to
      maintain another member's access. Includes the proof and requested
      persistence needed to decide the request without trusting a claimed
      identity, role, or household.
  - name: protected-action-request
    description: >
      The household action a caller wishes to perform, its apparent origin,
      and the caller's current proof of access. Required to decide admission
      before any household information is disclosed or changed.
  - name: deployment-access-policy
    description: >
      The household operator's trusted household boundary, first-owner
      authority, and independently held credential-protection material.
      Required to prevent a public visitor from claiming the home and to
      keep recorded identity verifiers insufficient on their own to grant
      access. This meaning enters from the deployment environment.
  - name: present-time
    description: >
      The trusted current moment supplied by the execution environment.
      Required to expire access and bound repeated attempts to establish it.
outputs:
  - name: member-access-outcome
    description: >
      Whether an access or membership request was accepted, rejected, or
      requires fresh proof; the accepted member and household, their current
      authority, and the end of the grant when access is allowed. Supplies
      enough information to restore a returning member's experience without
      disclosing the secret proof or a reusable identity verifier.
  - name: protected-action-admission
    description: >
      Permission or refusal for the requested household action, with the
      verified active member, household, and role when permitted. The
      household application consumes this decision before its domain
      operations and uses that member for attribution, including delayed
      operations, rather than accepting a caller's claimed actor.
  - name: household-membership
    description: >
      The stable identities, display information, roles, and active status
      of people belonging to the household. Supplied to member management
      and shared expenses so that people remain referable after departure
      and inactive participants can be surfaced without rewriting history.
  - name: access-change-record
    description: >
      The accountable actor and non-secret outcome of accepted changes to
      membership and access. Supplied to household accountability without
      recording passwords, reusable proofs, or identity verifiers.
---
