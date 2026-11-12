# Persisted login UI intent

Home OS is a shared household utility. Signing in should feel as calm and familiar as opening the existing inventory; member administration should make it clear who can enter the home without turning account management into a separate product.

**Emotional target:** reassurance.

**Subject grounding:** reuse the existing house mark, forest-green actions, warm quiet surfaces, Geist type, and labels used by the inventory/expense surfaces. No marketing hero, decorative dashboard preview, gradients, or disconnected auth design system.

**Tokens:** existing `--page`, `--surface`, `--surface-muted`, `--line`, `--text`, `--text-muted`, `--accent`, `--accent-soft`, and `--danger` remain authoritative in both color modes. Use the existing `.button`, `.field`, and `.form-error` primitives. New spacing follows 8/12/16/24/32px, with 44px minimum action height. Inputs stay at least 16px on mobile. Auth surface width is 30rem maximum with 20px minimum outer padding; account and member layouts wrap naturally.

**Layout:** a single readable sign-in form centered in a full-height canvas, with Home OS identity at the top, one clear heading and one next action. First-owner setup adds only the fields required to establish the home. Account settings and members use the same flat section headers, line-separated rows, and inline editors as the current product. Members remain scannable on a phone with name/email/status together and actions below when space is tight.

**Signature element:** the existing compact house mark paired with a short context label ("Your shared home") provides continuity between the sign-in screen and the app shell. No new illustration is needed.

**UX invariants:** native email/password fields and meaningful autocomplete; no app-managed plaintext password storage; optional visible password; persistent-session checkbox with duration explained; clear pending/error/success states; password confirmation; owner-only account creation and deactivation; inactive members remain visible; password resets explain session revocation; sign-out calls attention to connection/pending work rather than silently discarding it. All controls are keyboard reachable, errors announce themselves, and editor cancellation restores the list context.

**Definition of done:** inspect form hierarchy at desktop/mobile, ensure the primary action is visible on a small laptop, ensure member rows wrap without horizontal scrolling, verify labels and native submit behavior with interaction tests, check light/dark tokens and disabled/error states, and record any browser verification limitation in the handoff.

## Implementation self-critique

- **Squint:** one narrow auth surface, one heading, and one accent action; the existing house mark anchors identity without illustration or decoration. Account and membership surfaces use flat dividers and retain the product's visual vocabulary.
- **Skim:** login/setup intent is stated before inputs; member name, email, role, and active state are grouped; owner-only controls are explicit. Password reset and deactivation explain their consequences beside the action.
- **Above the fold:** the ordinary sign-in path is compact enough for a small laptop; first-owner setup deliberately scrolls rather than shrinking inputs or crowding fields.
- **Mobile:** 20px outer padding, 16px inputs, 44px actions, responsive row stacking, wrapping email addresses, and no fixed-width editors. Dark mode comes from existing semantic tokens. No animation was introduced.
- **Slop fingerprint:** no new gradients, decorative cards, floating assistant, generic feature panels, or marketing copy. New UI follows the established utility surface.
- **Verification:** 15 interaction tests cover native credential attributes and persistence selection, setup confirmation, failed sign-in/reconciliation retry, visibility, own password changes, failed sign-out, member creation/deactivation/reset, inactive retention, read-only permissions, and load retry. Targeted ESLint passes. Live desktop/mobile browser inspection remains an integration check for the parent session.
