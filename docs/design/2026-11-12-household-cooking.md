# Household cooking and contacts: UI intent

Reading this as: household application UI for daily coordination, with a calm, practical language, continuing the existing Geist, green, and warm-white custom CSS system.

## Intent and grounding

**Emotional target: calm coordination.** A member should be able to answer three questions quickly: what is being cooked, when, and whether they have said they are eating. The person cooking should see a trustworthy headcount without chasing messages.

This extends an existing application. Keep the house mark, Geist and Geist Mono, Phosphor icons, semantic colors, existing dialog conventions, and the established Inventory, Shopping, Expenses, Members, and Account destinations. Add working household surfaces rather than a marketing hero or a new visual framework.

The design-taste-frontend skill explicitly excludes dense product UI and multi-step product forms. Its preserve-first audit, consistency, and accessibility guidance applies here; its marketing composition, imagery, hero, and motion prescriptions do not. The existing application's form and navigation patterns remain the foundation.

Design settings: `DESIGN_VARIANCE: 4`, `MOTION_INTENSITY: 2`, `VISUAL_DENSITY: 5`. The work needs clear scheduling and comfortable controls rather than visual novelty or animation. Existing 120–160ms button feedback is sufficient. Honor reduced-motion and reduced-transparency preferences.

## Existing tokens to preserve

| Purpose | Light value from globals.css | Dark behavior |
| --- | --- | --- |
| Canvas | `--page: #f1f3ef` | Existing `#121613` override |
| Flat sections | `--surface: #fafbf8` | Existing `#171d19` override |
| Editable/raised surfaces | `--surface-strong: #ffffff` | Existing `#1d241f` override |
| Subtle grouping | `--surface-muted: #e7ebe5` | Existing `#232b25` override |
| Text | `--text: #17201a` | Existing `#edf2ed` override |
| Supporting text | `--text-muted: #68736b` | Existing `#aab4ac` override |
| Primary action | `--accent: #315f49` | Existing `#7daf90` override |
| Selected/affirmed state | `--accent-soft: #d9e8dd` | Existing `#263d2e` override |
| Boundaries | `--line`, `--line-strong` | Existing semantic overrides |
| Caution/failure | `--warning`, `--danger` and their soft variants | Existing semantic overrides |

Use the existing `--radius: 14px` for panels and established 10px control corners. Keep the existing pill buttons. Do not create a second radius, shadow, or accent system. Use 8/12/16/24/32px spacing. Retain the existing 232px desktop sidebar and responsive shell unless integration requires a small overflow fix.

New interactive controls have at least 44px touch targets; mobile text inputs use at least 16px type. Body text remains around the existing 15px, primary screen headings 26–34px, section headings 20–23px, and supporting copy 12–14px. Important dish names, meal times, and response buttons must never depend on tiny metadata. Muted text is supporting information rather than the only presentation of a critical state.

## Navigation and layout

The application has nine destinations: Menu, Recipes, Inventory, Shopping, Expenses, Contacts, Members, Notifications, and Account. Keep every destination reachable without relying on the browser Back button.

- **Desktop:** preserve the sidebar, with Menu and Recipes adjacent, Inventory/Shopping/Expenses/Contacts adjacent, and Members/Notifications/Account available in the same navigation. Any grouping labels should be quiet and sparse. The sidebar must scroll independently on a short laptop without hiding the account identity.
- **Mobile:** four bottom destinations: Menu, Inventory, Notifications, and More. More opens a labeled, focus-managed sheet containing Recipes, Shopping, Expenses, Contacts, Members, and Account. Mark More selected when its destination is active. Do not fit nine undersized items into the bottom bar.
- **URLs:** `?view=menu&meal=<id>` opens the identified meal, including after sign-in. Other destinations use `?view=<destination>`. A section change updates the URL; Back/Forward restores the prior destination. Preserve a pending meal deep link through the login/setup gate. A missing or inaccessible meal gets a useful terminal state and a link back to Menu.
- Preserve the existing default entry destination unless the implementation plan explicitly chooses another. Explicit URLs take precedence over the default.
- New sections retain the existing topbar title, clear panel heading, and one primary create action. Keep secondary filters and settings beside the relevant content rather than adding a dashboard of unrelated summary tiles.

## Signature element: seven-day cooking agenda

The menu's signature is a readable date strip connected to a cooking agenda. It should feel like planning the household's next few days, not managing a spreadsheet.

At desktop, show seven date buttons across the available width with today/tomorrow context and a small meal count. Below, present the seven days in chronological agenda sections. Clicking a date moves focus/scroll to that day and updates its selected state. The date strip may scroll within its own container on mobile; the page itself must not overflow. Mobile meal entries remain full width, with time, dishes, attendance, and response in that order. Avoid seven narrow meal-card columns at any viewport.

Provide Today, Tomorrow, and Next 7 days controls where the implementation's range model supports them. Keep the displayed range and timezone visible. Show a plain empty row for an unscheduled day with an eligible member's Add meal action. Do not fill empty days with decorative cards or invented meals.

## Menu and attendance flow

Each meal entry presents:

1. A readable cooking time and meal label/title.
2. The selected dish names, with access to their scheduled recipe details.
3. The current `Eating / Not eating / Unanswered` totals.
4. The current member's response and explicit `I'm eating` / `Not eating` controls when eligible.
5. Supporting notes, reminder timing, and shared edit/cancel controls when permitted.

Use visible words for every response; color alone does not convey meaning. A pending submission labels the affected action `Saving…`, prevents duplicate submissions, and leaves the other meal entries usable. Announce the accepted result, for example `You're marked as eating.` Do not show success before the server accepts it. A member may change their own response before the meal closes. Keep shared editing and personal attendance visually distinct.

The attendance roster can expand beneath its totals. Show active eligible members and their effective response; avoid presenting departed people as still awaiting an answer. Owners do not silently answer for other members. Viewers can read the menu and attendance but cannot change shared records or submit an eating response under the agreed role policy.

Cancelled meals remain understandable and visibly marked Cancelled, with no attendance or reminder actions. A past meal is visibly closed. Opening an old notification fetches the current meal state and explains cancellation, rescheduling, or a closed response period before offering any action.

### Schedule meal form

Use a familiar accessible dialog or inline section with: meal title/label, date, cooking time, multi-select recipe list, reminder lead time, and notes. Recipe selection shows selected dish names and an obvious Remove action. Search a long recipe list; preserve selections while filtering. At least one available recipe is required. If there are no recipes, explain this and offer a route to Add recipe while keeping entered meal details recoverable.

Time input and grouping use the household's persisted IANA timezone, not whichever timezone the current phone happens to use. Label it next to the date/time inputs, for example `Cooking time · Asia/Kolkata`. Convert the local date/time through that timezone and reject invalid/nonexistent times rather than silently shifting them. The confirmation summary repeats the resulting date, time, and timezone before save.

For a meaningful edit to cooking time or dishes, show an inline warning before save: `Changing the time or dishes asks everyone to confirm again.` After saving, old responses appear effectively unanswered for the new announcement revision. A note-only edit does not reset attendance. Recipe-library edits do not silently change the dishes or instructions already saved with a meal.

## Recipe library

Use a search field, Active/Archived filter, Add recipe action, and readable recipe summaries. A summary prioritizes name, servings, and ingredient count; optional preparation duration remains secondary. Opening a recipe reveals its ingredients and cooking instructions. Add to menu starts the meal form with that recipe selected.

The recipe form includes a name, servings, cooking instructions, and an editable ingredient list. Each ingredient has a readable name, an amount/unit description, and an optional linked inventory item. Add ingredient and Remove ingredient have explicit labels; removing one row must not reset the others. Long instructions use a comfortably sized textarea and retain line breaks on display. Keep the form a single coherent task rather than a wizard.

Stock indications must state what is known:

- **Tracked stock:** display the linked item's actual stock state or recorded quantity/unit.
- **Out of stock:** warn beside that ingredient and offer the relevant inventory destination.
- **Not linked / no current stock evidence:** show `Stock not checked` or equivalent.

Do not label a recipe Cookable merely because a linked item exists. Percentage stock and incompatible units do not prove the required amount is available. Scheduling a meal never silently consumes stock. Show archived recipes separately, with Restore; keep their saved meal snapshots readable.

## Contacts

Contacts are household people and service details, not sign-in accounts. The screen should say this succinctly and link to Members only if needed for account access.

Provide search across contact name and supplied role/labels, Active/Archived switching, and Add contact. A contact summary groups the name and relationship/service label, followed by the supplied phone, email, and notes. Show Call and Email as ordinary labeled links only when the corresponding validated channel exists. Do not invent a missing phone number, make the whole row an ambiguous action, or render arbitrary URLs as contact actions.

Create/edit forms have clear field labels, native phone/email input hints, bounded notes, and inline validation. Archive keeps history and explains recoverability; Restore is visible in Archived. An empty search differs from an empty contact list. On mobile, channel values wrap and actions stack without forcing horizontal scroll.

## Reminders and notification preferences

Notifications is a useful in-app inbox even when push is unavailable or declined. Use simple recent-first entries with a clear unread state, timestamp, current meal link, and Mark read action. A read-all action is appropriate when there are multiple unread entries. Explain the bounded inbox when relevant without showing implementation retention details as a primary product decision.

A meal reminder should plainly communicate the intended question, such as `Dinner is planned for 7:30 pm. Are you eating?` with the dish names where access permits. Its Open meal action leads to the fresh meal state and the member's explicit yes/no controls. Do not put a Yes label on a notification action that merely opens the app without recording Yes.

Keep preferences in a labeled section reachable from the inbox:

- Meal reminder preference with a saved-state acknowledgement.
- Device push state: Off, Enabled on this device, Blocked by browser, Unavailable, or Needs sign-in.
- An explicit Enable push notifications button. Call browser permission only from this user gesture; do not prompt on screen load, login, menu save, or the first app visit.
- Disable on this device, and any supported test-notification action, with honest pending/success/error feedback.
- Any quiet-hours options only when supported by the canonical preferences protocol; label their timezone and resulting behavior directly.

If browser permission is denied, explain that it can be changed in browser settings and retain the inbox. If push is unsupported, say so rather than disabling an unexplained button. If an iPhone/iPad browser requires an installed Home Screen app for the supported flow, show a concise installation hint in that detected state. Do not claim that permission is granted, a subscription exists, or a push arrived merely because a setting was saved.

Sessions govern device push eligibility. Sign-out, credential revocation, expiry, and deactivation stop future eligible deliveries. An already accepted in-flight push may arrive later; its service worker must verify the intended recipient before exposing household details or present a generic Home OS notification that opens through sign-in. A different member on the same device must never inherit the previous member's detailed push content.

## Owners and member access

Reuse Members for multiple owners. Keep Owner, Member, and Viewer labels explicit. Owners can create another owner through the existing Access field; there is no separate landlord/homeowner identity unless the product later defines one. Preserve the final active owner's protection and the explanation beside a disabled demotion/deactivation action. Contacts never grant app access.

## Shared interaction states

| State | Required visible behavior |
| --- | --- |
| Loading | Section-specific progress text; maintain surrounding navigation and avoid an empty panel |
| First use | Explain the missing content and offer the one appropriate eligible create action |
| Search empty | State that no results match and allow clearing the filter |
| Load failure | Plain error, Try again, and retained previously accepted content where safe |
| Mutation pending | Disable duplicate submission for that task, preserve inputs, use a specific pending verb |
| Validation error | Associate the message with its field, focus the first invalid field, preserve other inputs |
| Version conflict | Explain that the record changed, preserve the draft, and require an explicit review/retry rather than silently overwriting |
| Offline with accepted cache | Identify the saved copy and its age; keep supported reads available and online-only writes unavailable |
| Offline without cache | Explain that this section needs an initial connection; keep navigation and existing offline inventory usable |
| Session/role change | Close or lock disallowed editors, suppress stale success, and respect the current member boundary |
| Archived/cancelled/missing | State the terminal condition and provide Restore or a relevant route back when authorized |

New cached content is member/household-scoped and goes through the existing household-work boundary. It is removed with other device household data on account switch/sign-out. A late network response must not refill the previous member's cache or announce a stale success.

Dialogs use `role="dialog"`, an accessible title, keyboard focus containment, Escape when safe, and focus restoration to the invoking control. Do not let a loading spinner steal focus. Disabled writes have an adjacent reason when role/offline constraints might be unclear. Successful attendance and preference changes use a polite live region; errors use an alert. More is keyboard-operable and closes on destination selection or Escape.

## Frontend component seams

These are UI responsibilities, not a second API contract. The implementation plan's DTOs and route protocol remain authoritative.

| Component | Inputs and responsibility |
| --- | --- |
| `MenuView` | Current member, household timezone, optional focused meal ID, and navigation callback; owns range/date selection, meal loading, schedule dialog and attendance refresh |
| `RecipeView` | Current member, inventory evidence, and Add to menu callback; owns query/archive state, recipe details and edit form |
| `ContactsView` | Current member; owns search, archived state and contact form |
| `NotificationsView` | Current member and meal-navigation callback; owns inbox, read state, preferences and device push controls |
| `MealDialog` | Initial meal/dishes, available recipes, timezone, pending/error state, close and submit callbacks; preserves the member's draft |
| `AttendanceControls` | Effective self response, current announcement/response versions, role/closed/offline/pending state and self-response callback |
| `MoreNavigation` | Current destination, available destinations, navigation and close callbacks; shell-owned focus-managed secondary navigation |

Use the existing exported request helper so session proof, same-origin credentials, request timeouts, and rejected-session handling remain consistent. Keep feature DTO/cache helpers under the agreed household frontend directory. The application shell owns URL navigation and connects these components; domain views should not independently rewrite unrelated URL parameters.

## Definition of done and critique

- **Squint test:** time, dish names, attendance, and personal response are the dominant menu hierarchy. One accent and flat sections provide continuity. No stack of unrelated summary cards competes with the next meal.
- **Skim test:** a member can find tomorrow's meal, their own answer, and the cook's total without opening an editor. A cook can see which people are still unanswered.
- **Above the fold:** at 1366×768 the date range and first planned meal are visible; at 390×844 the screen title, selected day and first meal's essential information are visible without shrinking controls. Dense form content scrolls instead of compressing inputs.
- **Mobile/navigation:** no document-level horizontal overflow at 390px or 320px; long dish/contact names wrap; date-strip overflow is contained; bottom navigation never hides the last field/action; all nine destinations and browser Back remain usable.
- **Interaction proof:** exercise recipe create/edit/archive/restore, multi-dish scheduling, yes/no changes and counts, reschedule reconfirmation, note-only preservation, contacts, archived/missing meals, preference/push permission states, online/offline cache states, and role changes.
- **Access proof:** test logged-out notification links, same-member reauthentication, account switch, viewer limitations, and revoked push sessions. UI optimism never expands authority or reports an unaccepted write as saved.
- **Accessibility/theme:** keyboard paths through More and dialogs, 44px touch targets, native labels, error focus, live status, reduced motion, and existing light/dark token contrast all require browser inspection.
- **Slop fingerprint:** no marketing hero, decorative food image, arbitrary gradients, tiny meal columns, generic metric grid, unnecessary animation, or invented claims of ingredient sufficiency. The signature comes from the real seven-day cooking agenda.

This document is design intent before implementation. Its checklist is an acceptance target, not a claim that browser verification or implementation has already passed.
