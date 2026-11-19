# Household money UI intent

Date: 2026-11-19. Status: written intent before U6/U7 UI implementation; browser verification pending.

Reading this as: an extension of Home OS for household members reviewing shared money, with the existing quiet green product language and predictable forms.

Subject: a household member recording a shared bill, explaining their balance, or recording money already returned or repaid.

Emotional target: **confidence**. A person can see the exact amount, its explanation, and whether the household has accepted it.

## Authority and source audit

The frozen [advanced expense plan](../plans/2026-11-19-2108-feat-advanced-expense-ledger-plan.md), particularly its Goal Capsule, R1–R18, F1–F4, KTD12–KTD14, U6/U7 and Definition of Done, governs behavior. Agreed accounting contracts remain authoritative. This document chooses presentation and interaction within those decisions; it does not create another balance calculation or expand product scope.

Source inspection, not browser inspection, establishes the starting point:

- `apps/web/src/app/globals.css` provides semantic light/dark tokens, divided surfaces, pill buttons, outlined fields, visible focus, reduced-motion support and responsive shell rules.
- `apps/web/src/app/layout.tsx` supplies Geist and Geist Mono through `--font-sans` and `--font-mono`.
- `apps/web/src/components/expenses-view.tsx` currently leads with recurring expenses. The approved change leads with actual money and moves existing rules into their own tab.
- `apps/web/src/components/expense-rule-dialog.tsx` supplies labelled fields, participant controls, a resolved preview and focus return. Preserve recurring semantics while adding the reusable calculator.
- `apps/web/src/components/item-detail-dialog.tsx` supplies the detail-to-history pattern. Preserve named controls and return focus, while using one active dialog for the new flows.
- `docs/design/2026-11-18-access-ui.md` establishes the same tokens, readable mobile wrapping and explicit identity actions.

The `design-taste-frontend` skill is aimed primarily at marketing surfaces, rather than this multi-step money UI. Apply its source audit, preservation and anti-generic guidance only. Source-inferred dials are DESIGN_VARIANCE 3, MOTION_INTENSITY 2, VISUAL_DENSITY 5: regular alignment and restrained state feedback suit the existing product. These are intent, not measured browser results. No new font, component library, illustration or visual system is needed.

## Tokens and visual hierarchy

Consume the existing variables rather than copying hex values into ledger components. Their current values are recorded for design reference:

| Role | Token | Light | Dark |
| --- | --- | --- | --- |
| Page | `--page` | `#f1f3ef` | `#121613` |
| Surface | `--surface` | `#fafbf8` | `#171d19` |
| Main surface | `--surface-strong` | `#ffffff` | `#1d241f` |
| Quiet grouping | `--surface-muted` | `#e7ebe5` | `#232b25` |
| Divider | `--line` | `#d9dfd8` | `#2c352e` |
| Control border | `--line-strong` | `#c8d0c8` | `#3b463d` |
| Text | `--text` | `#17201a` | `#edf2ed` |
| Supporting text | `--text-muted` | `#68736b` | `#aab4ac` |
| Primary action | `--accent` | `#315f49` | `#7daf90` |
| Primary action text | `--accent-text` | `#f5f8f4` | `#112016` |
| Selection | `--accent-soft` | `#d9e8dd` | `#263d2e` |
| Attention | `--warning` / `--warning-soft` | Existing amber pair | Existing amber pair |
| Error/destructive | `--danger` / `--danger-soft` | Existing red pair | Existing red pair |

Retain `--radius: 14px` for surfaces, 9px field corners, the existing pill button treatment, and the existing shadow for the outer surface/dialog. Dividers and spacing group content within it; do not nest elevated cards. Use Phosphor icons already in the app, always with accessible names for icon-only actions.

Use the current 26–34px page heading, 21–23px panel/dialog title, 16–18px section headings and 15px body. Supporting ledger text may be 13px. Money inputs use at least 16px text on mobile so editing does not trigger viewport zoom. Use an 8px spacing rhythm, 16–24px section gaps and 16–26px surface insets, adjusted to the current shell. Primary ledger touch controls have at least 44px targets; compact visual icons can sit within a larger hit area.

Money uses tabular numerals, with the existing mono face where it improves column scanning. Right-align comparable amounts and signed balances; keep the currency code visible for every amount group. Never ellipsize an amount, abbreviate to “1.2k”, or use color alone to convey its direction. Preserve currency precision, including zero-decimal currencies, and the returned deterministic rounding. Do not render provisional floating-point arithmetic as accepted money.

## Layout concept and signature element

Keep the existing Expenses destination in the Home OS shell. Its first screen presents personal balance for the selected currency, Add expense, and actual accepted records. A compact three-tab strip reads **Expenses**, **Balances**, **Recurring rules**. The initial tab is Expenses; there is no marketing hero or dashboard of unrelated metrics.

The signature element is a **flat money explanation row**: a named person at the left and aligned Paid / Share / Recorded payments / Net amounts at the right, expanding or linking to the source statement. The composer uses the same alignment for payer contributions and resolved shares. The repeating visual relationship makes the route from a bill to a balance legible without decoration. These are returned accounting effects, never a separate client balance source.

Use one outer money surface with a header, scope controls, content and continuation controls. On desktop, records have stable description/date and amount columns. A composer may use a wider dialog than the existing 600px rule editor, up to about 880px, with entry controls and a review column only when both remain comfortable. Reading order remains entry, payers, beneficiaries, review, save. Narrow screens use that same order in one column.

| Viewport | Required composition |
| --- | --- |
| 320px | Keep the shell usable with its existing mobile insets; stack header actions, scope fields and money rows. Wrap the three tabs without truncating their labels. Each person/item becomes a labelled block with right-aligned amount on its own line when needed. No page-level horizontal scroll. |
| 390px | The same single-column hierarchy; compact rows may keep name and amount side by side only while both remain readable. Primary action spans the available width when header actions cannot fit. |
| Desktop, including 1280px | Preserve the existing sidebar and main-content bounds. Align record and member columns. Keep primary action adjacent to the money heading; a wider composer may use two columns without changing keyboard order. |

At the existing 820px shell transition, preserve mobile navigation and its bottom clearance. At or below the existing 680px form transition, use one form column. Dialog height follows the visible dynamic viewport, allows internal scrolling and reserves safe-area space. With a software keyboard open, focused fields and the action footer must remain reachable; a sticky footer must not cover preview, validation text or the final input. Test short heights as well as widths.

## Daily money surfaces

**Expenses.** Lead with “Your balance · INR” (or the chosen currency) and explicit directional text such as “You are owed INR 600.00”, “You owe INR 300.00”, or “Settled”. This is the complete current balance for that currency, not the subtotal of the visible page or search. A missing/loading balance is not shown as zero. Beneath it, show bounded actual record results with clear Expense, Refund or Recorded payment type, description, date, amount and status. Label spending summaries with their exact scope. Search/filter results do not silently redefine the personal balance. Preserve search, selected currency, tab, continuation and return position through entry detail.

**Balances.** Show members separately by currency, complete source breakdown and a route to each statement. Departed people remain named in historical facts and balances. Explain signed net with words. Display “Suggested repayments” as a separate section describing a possible way to settle current balances; avoid claims about original counterparty debt, unique settlement or a minimum transfer count.

**Record payment.** Provide an editable form for sender, receiver, positive amount, currency, date, method and optional reference. A suggestion may prefill these fields but cannot execute or lock them. Allow partial payment, a different counterparty/amount and a payment that reverses a balance when permitted by the accounting contract. Review the entered fact and resulting effect. Copy says “Record payment” and “Payment recorded”, never “Pay now” or “Transfer complete”. If a suggestion became stale, show refreshed context while keeping the entered fact available for review; never silently replace it. Viewers see the same financial information with a concise read-only explanation and no mutation controls.

**Recurring rules.** Preserve cadence, shares, archived/restore behavior and existing rule semantics under an explicit Recurring rules heading. Use “Add recurring rule” for rule creation so it is distinct from Add expense. Posting a rule is explicit: choose and preview the normalized cadence period, actual date and payer contributions, then record an expense. No automatic payment/posting is implied. If that rule/period already has an original, open it; a voided original remains the original and does not make the period available again.

## Composer: exact entry, then review

Keep one labelled form with these groups: expense date/description/currency/category/notes; Whole bill or Itemized amount; Who paid; Who shares; resolved review; save controls. Category and notes remain available without obscuring the primary amount work. Show retained editable input as “Unsaved”; only a connected accepted response/status may create a saved record or change accepted balances.

The amount mode selector is an explicit choice. Switching modes must preserve compatible input or explain and confirm any input it would discard in the same dialog. Multiple payer contributions are independently editable. Show total paid, expense total and exact remainder/difference beside Who paid; invalid totals explain what needs correction rather than silently changing a payer.

Whole-bill splits expose Equal, Exact amount, Percentage, Weighted shares and Mixed using plain labels. Mixed rows show their selected rule and resolved amount together. Percentage basis and remainder behavior follow the agreed resolver; never suggest that a percentage of the original total is a percentage of the remaining balance. Review lists each person's exact share and any rounding allocation. Stable participant order is retained; sorting display names must not change who receives a rounding remainder.

Itemized entry shows each line's label, quantity, amount meaning and participants. Match the accepted quantity/price schema exactly; distinguish unit amount from line total wherever both appear. Keep bill discount, tax and tip visibly bill-wide and show their contribution to final total and each person's allocation. Adding/removing a line is explicit and preserves the other lines. On mobile, edit a line inline within its own labelled block, rather than squeezing every input into a table or opening another modal.

The final review always includes currency, total, payer total/difference and resolved beneficiary shares. Incomplete or invalid input explains why Save is unavailable. Financial preview is read-only; acceptance recomputes it authoritatively. If authoritative refusal changes the explanation, retain the input and show the specific issue. Do not silently substitute a different accepted total.

Duplicate opens an unsaved editable draft dated today. Identify its source, retain useful explanatory content, and require correction of departed parties before an ordinary new expense can save. Historical and restore paths keep their distinct accounting behavior; do not treat them as duplicate/new selection.

Expose plan limits where relevant: at most 12 distinct payers/beneficiaries in union, 40 item lines, 160 characters for description/line label, 200 for category/method/reference and 2,000 for notes/comments. Show a concise counter or inline limit message at the affected input. Do not claim that clipped content was saved in full. Money limits and supported currencies come from shared schemas.

## Calculator, focus and keyboard

Every supported money field has a named calculator control, such as “Calculate amount for Priya”. Calculator appears inline within the current editor, with one focus scope. Show expression, valid result and currency precision, then **Apply** and **Cancel calculation**. Applying updates only the selected field; it does not save the bill. Cancel leaves the original field untouched. Invalid expressions cannot apply or submit. Currency changes follow explicit amount semantics and invalidate/recompute pending calculator results as appropriate; they are never currency conversion.

Use decimal input mode for money and appropriate numeric input for quantities. The calculator expression field must still allow operators through a physical keyboard and visible operator buttons when the mobile keypad lacks them. Do not block paste, selection, deletion, negative expression intermediates or ordinary keyboard editing. Final money validation follows the domain rules. Enter in the calculator evaluates without submitting the expense; Escape closes that inline calculation first and returns focus to its source control. Buttons inside an editor have explicit types. Enter in notes/comments remains a newline.

The outer dialog has an accessible title, modal semantics, inert background and a complete Tab/Shift+Tab loop. Initial focus goes to the first meaningful input for a new draft, or the heading/status when resuming recovery. Close returns to the actual invoker; detail-to-edit/refund/payment replaces the current dialog rather than nesting it. Back returns to the previous detail/state. Expanders and tab controls expose selected/expanded state and work with keyboard; tabs support standard arrow/Home/End navigation when implemented as an ARIA tablist.

Close, Escape, backdrop and navigation share the same deliberate dirty-input handling. A discard choice replaces content within the same focus boundary, with explicit Keep editing and Discard draft controls. An unknown save is not an ordinary discardable draft. Error summary and field errors identify the affected controls with `aria-describedby`/`aria-invalid`; submission refusal focuses the first actionable error. Announce save/recovery status politely and failures assertively, without announcing every keystroke or rerendering away focus.

## Retained attempts and uncertain outcomes

Use one durable unresolved attempt slot per **browser origin + household + admitted person**, separate from read-cache data and excluded from read-cache pruning. Retain the exact operation ID and immutable payload before dispatch, with transactional acquisition across tabs and current-lease ownership checks. Failure to retain means no send and a visible “Could not prepare this save. Your input is still unsaved.” This is not a money outbox.

| State | Person sees | Available next action |
| --- | --- | --- |
| Editable, unsent | Unsaved input and exact preview | Edit; deliberate draft discard; connected Save when valid |
| Sending | “Saving…” and unchanged review | No edits or repeated submission; closing cannot lose the retained attempt |
| Outcome unknown | “Save outcome unknown. This may already have been recorded.” and a read-only summary of the frozen intent | Check status; retry the same retained save while connected and authorized |
| Own-operation status not found | “Not confirmed yet” with the same frozen summary | Keep checking or retry the same intent; no new operation or ordinary editing |
| Accepted | Current accepted record and refreshed authorized balance | Inspect detail/history; normal subsequent actions |
| Definitive ordinary validation refusal | Specific error and retained editable input | Correct input and deliberately submit again through the attempt mechanism |
| Authority lost or session expired | Recovery locked; concise identity/session explanation | Reauthenticate/revalidate as the same person; deliberate account actions through the existing boundary |
| Slot occupied by another tab | Existing pending-save summary/status for this person | Open/recover that attempt; no second independent unresolved money submission |

Network failure, timeout, 5xx and unreadable replies enter Outcome unknown; do not label them “Not saved” or offer “Save as new”. A Not found lookup alone cannot prove an outstanding request will never commit. Preserve the frozen payload/ID across reload, tab changes, reconnect and same-member reauthentication. A status lookup or replay must use current authority. Acceptance clears the matching owned attempt and opens the current record; stale callbacks cannot clear or repopulate a different person's newer state.

If the editor closes while sending/unknown, retain a persistent pending-save entry point in the money surface; returning or reloading restores recovery. The exact submitted record stays immutable until an accepted outcome or definitive refusal permits the next state. Reconnect, visibility change, reload and same-person reauthentication never auto-post money. Cached money remains visibly read-only while offline, with a connected-save explanation; do not enqueue financial changes for later posting.

Logout/account switching follows the existing explicit pending-work/discard decision before its authorized clearing boundary. Name which person's retained work would be discarded and explain that discarding local recovery does not undo a save that may already have committed. Same-member revalidation does not discard it. Do not disclose the previous person's retained form, attempt, cache or prepared statement to the next person. These are deliberate identity actions within the existing auth flow, not new financial consent gates.

## Entry explanation, refunds and history

Detail leads with description/type, accepted status, currency/total and date, followed by payers, beneficiary allocations and itemized/adjustment explanation. Notes remain part of the record. Comments are separately attributed, immutable and paged; appending explanation never changes the balance. Revision history names actor/time/action, preserves accepted prior facts and makes reversal/replacement effects legible.

Correction, void and restore have explicit verbs and a concise effect review. Retain the source detail and input through a version conflict; show that someone changed the record and offer Reload latest for deliberate review rather than silently rebasing and resubmitting. Void is not delete. Restore is not a new original or a way around refund/source limits.

Linked refund starts from its expense and keeps the original visible in context. Show original currency, remaining overall/per-person capacity and positive refund amount with returned allocations; preview the reversal of contributions and consumption. A stale capacity refusal preserves unsaved input and offers refreshed capacity for review; do not silently reduce the entered refund. Historical departed people remain identified, and recorded repayments can name them where permitted.

## Statements, exports and return paths

Statement heading names person, currency, date scope and accepted-history basis/revision. Show opening balance, movements and closing balance with a visible relationship; continuation is explicit. Entry links return to the same statement scope and position. Direct entry/statement links resolve within current household authority and provide a labelled return to Expenses or Balances when no in-app origin exists. Browser Back/popstate follows the same dirty-input and frozen-attempt guards as visible navigation. Balances and spending summaries carry their own scopes; none is labelled as a complete balance merely because one page loaded.

CSV/JSON export controls are next to that declared scope. Show preparation and cancel states. Download only after assembling one complete consistent statement within 10,000 movement rows and 8 MiB. A changed revision cancels preparation and offers Restart export; excess size asks for a narrower range. Do not produce a partial file labelled complete or combine revisions. Keep download scope/currency/basis clear. CSV text must be safely encoded while validated numeric amounts remain numeric, including negative balances.

## Loading, empty, offline and error behavior

Reserve the shape of the balance and rows while loading; do not flash zeros or an empty household. Initial failure has Retry and a stable route back. Page-continuation failure keeps already loaded records and retries only the failed continuation without claiming completeness. Empty actual records say “No expenses recorded yet” and offer Add expense to permitted members; empty rules and an empty filtered result have their own explanations and next actions.

Cached data identifies its offline/stale status and currency/scope. A failed refresh preserves readable authorized data with a retry notice. Permission changes remove mutation controls and lock retained attempt recovery as required. Inline input errors retain input; expired authority routes to the existing reauthentication path. Persistent financial errors remain near the action and are not communicated only by a disappearing toast. Every state retains a working close/back/retry route appropriate to whether an attempt is editable or frozen.

Bound cached copies to the plan's latest 20 query pages and 10 entry details per person. Do not expose cache implementation terms in ordinary copy. Statement preparation and delayed network results remain bound to the current admitted identity and work lease.

## Definition-of-Done self-critique: pending actual UI

This document records design intent and a source audit only. No implementation, browser screenshot, keyboard journey or visual pass is claimed. U6/U7 implementation and U8 integrated proof must supply evidence before marking these checks complete.

| Check | Intended outcome | Evidence still required |
| --- | --- | --- |
| Squint | One money surface; personal balance and primary action dominate; aligned rows explain source amounts without nested cards | Actual 320px, 390px and desktop screenshots in light and dark, including populated balances and composer |
| Skim | Within seconds, a person distinguishes actual expenses, recurring rules, suggestions, reported payments, unsaved input and uncertain saves | Actual initial/detail/payment/recovery captures and a reading pass over visible labels |
| Above fold | Personal balance, Add expense and tab navigation lead the initial screen; editor title, first meaningful field and recoverable actions are reachable | Captures at 320×568, 390×844 and 1280×800, plus short-height/software-keyboard inspection; check bottom navigation and footer overlap |
| Generic-pattern fingerprint | Existing Home OS tokens, restrained typography and real money explanations carry the page | Actual screenshots checked for unrelated hero copy, metric tiles, gratuitous chips/gradients, decoration, nested cards or inaccessible tiny amounts |
| Money and responsive alignment | Exact untruncated amounts, clear currency and stable person/amount association; no horizontal page overflow | Long names, maximum supported amounts, INR and zero-decimal currency, 320/390/desktop screenshots and zoom inspection |
| Keyboard and dialogs | One active focus scope, explicit calculator Apply, deliberate dirty discard, recoverable errors and focus return | Actual Tab/Shift+Tab, Escape, Enter, native keypad/operator input, screen-reader labels/announcements and detail/editor transition journeys |
| Financial state clarity | Retained unknown attempt stays frozen and identity-bound; no optimistic accepted money or automatic offline posting | Reload/two-tab/response-loss/same-member reauthentication/account-switch journeys, plus source/component and integrated evidence |
| Lifecycle completeness | Every loading/empty/offline/error/conflict state has a truthful scope and working next step | Actual captures/journeys for failure, stale revision, source-period collision, refund capacity, export cancellation/limits and viewer state |

Future verification should record screenshot paths, viewport/theme, observed problems and fixes here. Leave any unobserved check pending; passing component tests alone does not complete visual self-critique.
