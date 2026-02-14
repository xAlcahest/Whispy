# Project Status

This file tracks implemented UI status and near-term gaps. Detailed implementation is documented in `docs/UI_IMPLEMENTATION.md`.

## Implemented

- Electron architecture with two UI windows (overlay + control panel) and typed preload bridge.
- Overlay dictation UX with mock lifecycle states (`IDLE`, `RECORDING`, `PROCESSING`), context menu, cancel action, resize/interactivity management, and optional auto-hide.
- Control panel with first-run onboarding wizard (4 steps) and post-onboarding workspace.
- Conversations/history section with search, language/provider/date filters, expand/collapse, copy, delete, clear-all confirmation, and header counter badge.
- Settings workspace with tree navigation (General, Models, Prompts, Agent name, Shortcuts, Info).
- Model configuration split by pipeline and runtime:
  - Transcriptions: Cloud + Local
  - Post-processing: Cloud + Local
- Cloud provider tab UX with centered tabs and separators (OpenAI, Grok, Groq, Meta, Custom), including provider-specific API key fields and custom endpoint/model fields.
- Local model management with simulated download/remove progress for both transcription and post-processing models.
- Prompts workspace (Preview/Customize/Test) and dedicated Agent name section with mock prompt-routing test.
- i18n scaffolding integrated (`I18nProvider`, `useI18n`) with current English-only dictionary.

## Known Gaps / Risks

- Core dictation/runtime integrations are still mock implementations.
- API keys are stored in renderer localStorage (no secure keychain yet).
- Cross-window sync relies heavily on storage events rather than explicit shared state channel.
- UI language selector currently offers only English.
- Some legacy settings fields remain (`provider`, `modelId`) alongside newer cloud/local split fields.
- One overlay size key (`WITH_TOAST`) exists but is not used by current overlay state logic.

## Next Candidate Work

- Replace mock transcription/runtime/download flows with real services and IPC-driven status.
- Move credential storage to secure OS keychain integration.
- Expand localization beyond English and complete translation coverage.
- Add settings tree search/filter for faster navigation.
- Add import/export for settings/prompts/history.
- Improve model capability visibility (for example auto-detect support, latency/cost/tooling metadata).
- Replace static cloud model catalogs with backend auto-discovery, keep curated defaults, and add a `Show others` option for full provider model lists.
