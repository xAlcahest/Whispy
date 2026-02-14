# Project Status

This file tracks implemented UI status and near-term gaps. Full behavioral detail lives in `docs/UI_IMPLEMENTATION.md`.

## Implemented

- Electron app with two windows (overlay + control panel), typed preload bridge, and typed shared IPC contracts.
- External links are forced to open in the user browser (no in-app Electron popup browsing).
- Overlay dictation UX with mock lifecycle states, context menu, cancel action, dynamic interactivity, and optional auto-hide.
- Control panel onboarding + post-onboarding workspace with Conversations and Settings.
- Settings redesigned into grouped left sidebar with fixed-left navigation and internal panel scrolling.
- Responsive model UX updates in both Speech and Post-Processing:
  - Provider selectors in responsive grid layout.
  - Model selectors in responsive grid layout for narrow windows.
  - Local model cards with wrapped metadata chips and overflow-safe action buttons.
- Preferences updates:
  - Hotkey activation controls moved into Preferences.
  - Auto-paste backend selector (`wtype` / `xdotools` / `ydotools`) with always-on autopaste behavior.
  - Wayland warning when selecting `wtype`.
  - Microphone access moved into Preferences.
- Dictionary workflow updates:
  - Dictionary section in Speech.
  - Enable/disable toggle.
  - Add, save, delete replacement rules.
  - Save icon appears only for unsaved valid edits and disappears after save.
  - Rules remain visible but grayed-out/read-only when dictionary is disabled.
- Prompts workspace tab row preserved side-by-side with overflow handling.
- Developer/Info updates:
  - New `Bug logs` card with debug mode toggle and show/hide log paths.
  - Runtime status now includes cloud provider name for transcription runtime.
- Provider API key UX updates:
  - Non-custom providers show API key docs links for key creation.
  - Custom providers support model endpoint scanning with explicit error handling when endpoint is unavailable.

## Known Gaps / Risks

- Core runtime behavior is still mock (transcription, downloads, permissions behavior).
- API keys are still stored in renderer localStorage (no OS keychain integration yet).
- Cloud provider model catalogs for non-custom providers remain static frontend data.
- Cross-window state sync still uses storage events heavily.
- Onboarding still contains legacy fields (`provider`, `modelId`) alongside newer split runtime settings.
- i18n remains effectively English-only.

## Next Candidate Work

- Replace mock dictation/runtime/download flows with real backend + IPC-driven state.
- Move credential storage to secure OS keychain.
- Implement backend cloud model discovery for non-custom providers and keep `Show others` expansion flow.
- Add schema/validation for custom provider endpoints and richer scanner diagnostics (auth/network/rate-limit distinctions).
- Add import/export for settings/prompts/history.
- Expand localization coverage beyond English.
