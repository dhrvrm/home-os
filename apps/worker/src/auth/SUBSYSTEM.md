---
name: household-access
definition: >
  Determines which person may act in the household and with which authority,
  whether acting directly or through a personally authorized connection.
  Membership, identity proof, continuing grants, and action permissions form
  one authority: another entry point cannot confer a different role or bypass
  a revoked grant. Owners govern household access, owners and members
  maintain shared facts and answer their own meal attendance, and viewers
  inspect shared facts. Every active person controls their own reminders and
  connections. At least one active owner must remain. Continuing access has
  no automatic deadline, but explicit revocation, departure, and replacement
  of identity proof remain effective. Stable member identities survive those
  changes so household history remains attributable. Without this subsystem
  household facts have neither an accountable actor nor an enforceable
  household boundary.
inputs:
  - name: member-access-request
    description: >
      A person's request to establish, prove, continue, or end direct access;
      replace their own identity proof; or maintain another member's access
      with owner authority. Supplied by the member access experience or an
      admitted connected action. Carries genuine proof where necessary,
      accountable operation context, and the intended change without trusting
      caller-claimed identity, role, or household. Secret proof entry belongs
      to the person's direct interaction with the household authority.
  - name: connection-access-request
    description: >
      A client's request to identify itself and the household resource it
      seeks, establish or continue delegated access, or end its connection;
      and a proven person's explicit decision to approve, refuse, inspect,
      or revoke connections. Supplied by connected household interaction or
      the member access experience. A person manages their own connections;
      an owner may inspect non-secret connection status and revoke another
      household member's connection. Client claims alone cannot stand in for
      the person's consent.
  - name: protected-action-request
    description: >
      The intended household action, requested subject, apparent origin,
      current proof of access, and connection authority when delegated.
      Supplied by application entry points before disclosure or change so
      all callers receive one permission decision for the same action.
  - name: deployment-access-policy
    description: >
      The trusted household boundary, first-owner authority, independent
      protection for identity proof, and the household resource identity.
      Supplied by the deployment environment so a public visitor cannot
      claim the home and proof intended elsewhere cannot enter this one.
  - name: present-time
    description: >
      The trusted current moment supplied by the execution environment.
      Required to bound attempts and temporary exchanges of authority,
      without imposing an automatic deadline on continuing grants.
  - name: notification-delivery-check
    description: >
      The intended recipient, household, and exact continuing device grant
      supplied by household reminders. Required to establish current delivery
      authority independently of an earlier registration decision.
outputs:
  - name: member-access-outcome
    description: >
      Acceptance, refusal, or the need for fresh proof; the verified member,
      household, current role, available actions, and continuing-grant state.
      Supplied to household experiences without secret identity proof. An
      accepted continuing grant has no automatic deadline. Already-ended
      grants remain ended when policy changes or a person rejoins. Ending a
      direct session ends that session and its device authority, without
      ending independently consented connections. Replacing identity proof
      or deactivating a member ends all their existing grants.
  - name: connection-access-state
    description: >
      The identified client, intended household resource, requested actions,
      and authoritative approval request, or the person's allowed view of
      existing connections, approved limits, and revocation state. Supplied
      to the member access experience and connected household interaction
      so consent and connection management are understandable without
      disclosing reusable proof. A connection's approved ceiling cannot
      expand merely because its member gains authority later.
  - name: connection-access-outcome
    description: >
      Whether establishing, continuing, or ending a connection succeeded,
      requires direct personal authorization, or was refused. Continuing
      delegated authority is bound to the consenting person, household
      resource, identified client, and approved action ceiling; its proof
      belongs only to the intended client through the access exchange,
      never household results or activity history. Temporary proof may be
      replaced without asking the person to sign in again while the durable
      grant remains valid. Revocation takes effect for further actions even
      if previously issued proof remains in a client's possession.
  - name: protected-action-admission
    description: >
      Permission or refusal for the exact requested action and subject,
      with the verified active person, household, current role, and current
      continuing-grant boundary when admitted. Supplied to every household
      authority before disclosure or change. Effective authority is the
      intersection of the current role, the connection's explicit ceiling
      when present, and personal or household ownership of the subject.
      Personal reminder control and connection control never confer shared
      editing rights. Membership and connection-management changes require
      authority that still holds when the change is accepted, so an earlier
      decision cannot survive intervening revocation or demotion.
  - name: notification-delivery-authority
    description: >
      Whether the recipient still belongs to the household and the exact
      continuing device grant remains valid. Supplied before reminder
      dispatch so sign-out, revocation, replacement of identity proof, and
      departure prevent further disclosure through that device. Lack of an
      automatic session deadline does not weaken these conditions.
  - name: household-membership
    description: >
      Stable member identities, display information, roles, and active state.
      Supplied to member experiences, connected household interaction,
      recurring expenses, and household cooking so people remain referable
      after departure without confusing shared contacts with login accounts.
  - name: access-change-record
    description: >
      The accountable person, direct or connected origin, and non-secret
      outcome of accepted membership or access changes. Supplied to household
      accountability without passwords, reusable proofs, or identity
      verifiers. A declined or merely proposed interactive action is not an
      accepted membership change.
---
