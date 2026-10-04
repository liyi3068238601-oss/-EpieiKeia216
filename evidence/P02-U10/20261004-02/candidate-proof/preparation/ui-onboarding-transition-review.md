# Native login to onboarding transition review

Status: preparation-only source investigation. No author FINAL, no formal review decision, and no product or test code changes. No live UI, model, or registry was run or accessed, and no user profile contents were read. The running candidate08 full6 evidence was read only.

## Snapshot

- Main tree: `178379a8ad9c0c27f833a412ff06f7b0095bab79`, clean at inspection.
- Frozen Native source: `.runtime/P01/desktop-source` at `29628c9acdb81b703bbd4080c207a0e7ce5e276e`, clean.
- Author worktree: `.runtime/P02/worktrees/mature-integration` at `2f5d349673c4bf636a44f90ecf7729c70eb36d6d`, clean.
- Failure artifacts: `.runtime/P02/experiments/mature-integration/desktop-full-candidate08/scenarios/success/ui-result.json` and `ui-success-failure-window-0.txt`.

## Finding

The observed failure is strongly explained by a P02 driver postcondition race; the inspected Native flow explicitly supports an asynchronous transition from the login entry to the workspace/onboarding. This does not establish a Native product defect.

`LoginApiKeyForm.tsx:125-132` awaits the empty-key skip settings update, then calls `onSkipped`. `WelcomeScreen.tsx:364-367` first resets `loginMode` to `providers`, then calls Root's completion callback. The callback in `Root.tsx:873-903` awaits `refreshAppSettings`; on the startup-provider-required path it can also await default-workspace creation before clearing `welcomeScreenOpenReason`. `Root.tsx:982-1015` conditionally replaces WelcomeScreen with the main app, whose `OccupationOnboarding` is mounted at `Root.tsx:1015`. The onboarding visibility is derived from its own local request/trigger state (`OccupationOnboarding.tsx:54-84, 214-220`), with the real surface marked `data-testid="onboarding-page"` at line 273.

The P02 driver (`tests/integration/P02/desktop-ui.mjs:137-145`) waits for `login-use-api-key-button` to detach after entering the API-key form. That button is rendered only in the provider mode (`WelcomeScreen.tsx:341-352`), so it detaches before skip completion and Root route closure. After `onSkipped` resets the form to provider mode, the button can briefly become visible again while Root is awaiting settings refresh/workspace creation. The driver's next loop can observe it and call `click()` just as Root unmounts WelcomeScreen. This matches the captured 30-second click timeout at `desktop-ui.mjs:139` and the final text showing the onboarding step.

The `ui_actions` entry `skipped-key-onboarding-with-empty-password` is appended immediately after the premature detach wait; it proves the driver reached the skip path, but does not prove WelcomeScreen had closed. The screenshot text confirms the final page was the real three-step occupation onboarding.

## Minimal P02-only postcondition recommendation

Use an existing route-level accessible marker that stays present across both login submodes: WelcomeScreen's `h1` is localized from `login.title` (`WelcomeScreen.tsx:283-285, 454-469`; Chinese and English values are in `i18n/locales/zh-CN.ts:787` and `en-US.ts:864`). After skip, use the existing `readyWorkspace` deadline to wait for the compound destination condition:

- the login heading is no longer visible; and
- either `onboarding-page` or `v4-composer-input` is actually visible.

Only then handle the visible onboarding or composer. Keep the current overall deadline; do not infer route closure from the API-key button's detach, re-click a transient login target, or add a blind retry. This is a recommendation only; no driver change was made.

## Evidence boundary

Source and artifact contents above were read directly. The route race is an inference that fits both the source ordering and captured failure; this run was not replayed and the transient state was not instrumented. No claim is made about a formal review outcome or task acceptance.


## Read-only follow-up on author handler

Inspected author source at `cd03ddc3a3f6f7ca67b4313e309db20db4755343`, `tests/integration/P02/desktop-ui.mjs:138-158`. Recovery catches only Playwright `TimeoutError` from clicking the provider-mode API-key entry. It proceeds only with the recorded empty-password skip action, the entry button now invisible, and a visible real onboarding page or composer; otherwise it rethrows. The recovery does not click again. The outer loop then uses the existing onboarding branch (`:161-179`), which requires the real page and an enabled Skip control and waits for step progress; it returns only when the composer is visible. Combined with Root's mutually exclusive `WelcomeScreen`/main render branches (`Root.tsx:982-990, 1010-1022`), these conditions do not bypass an open login route or skip an unprocessed onboarding step.

This is a source-only assessment of the handler, not a formal review decision. Candidate09 was not run or inspected.
