# UI Implementation (Current State)

This document describes what is actually implemented in the UI as of the current codebase.

## 1) UI architecture and windows

- App architecture is Electron `main` + `preload` + React `renderer`, with hash routes selecting window content (`#/overlay`, `#/control`).
- Two BrowserWindows are created at startup:
  - **Overlay window**: frameless, transparent, always-on-top, skip-taskbar, visible on all workspaces.
  - **Control panel window**: frameless main workspace window with custom header and full settings/history UI.
- Overlay size is controlled from renderer through IPC size keys (`BASE`, `WITH_MENU`, `EXPANDED`; `WITH_TOAST` exists but is not currently used by overlay view logic).
- Renderer uses a typed `electronAPI` bridge, with a browser-safe fallback implementation for non-Electron contexts.

## 2) Main UI flows implemented

### Overlay flow

- Overlay states are `IDLE -> RECORDING -> PROCESSING -> IDLE` driven by a mock transcription service.
- Primary interaction:
  - Left click toggles start/stop dictation.
  - Right click opens context menu: start/stop, open control panel, hide overlay.
  - Hover while active shows cancel button.
  - `Esc` closes menu first, then hides overlay.
- Overlay adjusts interactivity and size dynamically:
  - Captures mouse only when hovered, active, or context menu is open.
  - Auto-hide timer hides overlay when idle if enabled.
- On mock transcription result:
  - Entry is appended to local history.
  - If auto-paste is enabled, text is copied to clipboard (with error toast fallback).
  - Notifications are emitted through localStorage-backed app notifications.

### Control panel flow

- On first run (based on localStorage flag), a 4-step onboarding wizard is shown:
  1. Welcome
  2. Provider/model/language
  3. Permissions (mock)
  4. Hotkey + activation mode
- After onboarding, main workspace has two top-level sections:
  - **Conversations**
  - **Settings**
- Header includes:
  - Section toggle button (settings icon)
  - "Show overlay" action
  - Theme toggle (light/dark)

## 3) Settings workspace structure and navigation

- Settings are presented as a left tree + right content panel.
- Tree branches/leaves currently implemented:
  - `General`
    - Activation
    - Behavior
    - Privacy / Local
  - `Models`
    - `Transcriptions`
      - Cloud
      - Local
    - `Post-processing`
      - Cloud
      - Local
  - `Prompts`
  - `Agent name`
  - `Shortcuts`
  - `Info`
- Branches are expandable/collapsible.
- Selecting a node updates active content; for section cards with matching ids, the right panel scrolls to that node anchor.

## 4) Model configuration UX

Model configuration is split by **pipeline** and **runtime mode**:

- Pipelines:
  - **Transcriptions**
  - **Post-processing**
- Runtime modes:
  - **Cloud**
  - **Local**

Behavior implemented:

- Cloud mode:
  - Provider tabs (OpenAI, Grok, Groq, Meta, Custom).
  - Provider-specific model selection list.
  - Active model is visually marked.
- Local mode:
  - Local model cards with metadata (size/speed/quality).
  - Simulated download/remove with progress bar.
  - "Use local" action enabled only for downloaded models.
- Cloud catalogs are currently static in frontend constants (mock stage).
- Language model compatibility guard:
  - `Auto-detect` language is allowed only for model ids included in `AUTO_DETECT_SUPPORTED_TRANSCRIPTION_MODELS`.
  - If unsupported model is active while `Auto-detect` is selected, UI falls back language to `English`.

### Planned backend behavior for cloud model discovery

When real backend integrations are enabled, cloud model lists should switch from static UI catalogs to runtime discovery:

- Program performs automatic provider-side model scan/discovery.
- UI shows a curated/filtered default list first (program-level filtering).
- A `Show others` action reveals the full raw provider model set discovered by backend.
- This pattern should apply to both cloud pipelines:
  - Cloud Transcriptions
  - Cloud Post-processing

## 5) Provider tabs and API key handling (custom vs non-custom)

Shared behavior in both cloud transcriptions and cloud post-processing:

- **Non-custom providers** (`openai`, `grok`, `groq`, `meta`):
  - Single password-type API key field shown for selected provider.
  - Key persists to provider-specific setting fields (separate fields per provider and per pipeline).
  - Model is chosen from predefined catalog list.
- **Custom provider**:
  - Dedicated fields for:
    - Custom base URL
    - Custom API key
    - Custom model id
  - "Use cloud" button explicitly activates cloud runtime with custom provider and model.

Important current storage behavior:

- API keys are persisted in localStorage as plain JSON settings (no secure keychain integration yet).

## 6) Prompts workspace and agent name

- Prompts workspace is a dedicated section with 3 tabs:
  - `Preview`: shows current normal prompt and agent-route prompt.
  - `Customize`: editable textareas for normal prompt and agent prompt.
  - `Test`: mock routing test output based on whether input contains current agent name.
- Agent name has a dedicated section (`Agent name`) separate from prompts.
- Prompt test routing logic:
  - If test input includes agent name (case-insensitive), route is "Agent prompt".
  - Otherwise route is "Normal prompt".
- Legacy guard in storage migrates `ActionAgent`/empty name to default `Agent`.

## 7) Conversations/history and counter

- Conversations section reads local history entries and supports:
  - Search by text
  - Filters: language, provider, date range (today/7d/30d/all)
  - Expand/collapse entry text
  - Copy single entry
  - Delete single entry
  - Clear all (confirmation dialog)
- History data is generated by overlay mock transcription results and sorted newest-first.
- Header shows conversation count badge:
  - Loading state: `...`
  - Count cap display: `999+`

## 8) i18n scaffolding and current language status

- i18n provider/hook exists and is wired into app root.
- Current locale type is only `en`, with a minimal translation dictionary.
- Language setting UI exists, but available UI language options currently only include English.
- Locale is synchronized through settings storage and storage-event listeners.

## 9) Known UX issues/risks and open TODOs

- **Mock-heavy flows**: dictation, permissions, model downloads, and some runtime status are simulated.
- **API key security risk**: sensitive keys are stored in localStorage (plain text in renderer context).
- **Cross-window state sync depends on storage events**: behavior can be brittle versus explicit IPC/state bus.
- **Model path text is macOS-specific**: local transcription storage path copy is hardcoded to `~/Library/...`.
- **Incomplete i18n**: only English dictionary/locale currently implemented.
- **Unused overlay size constant**: `WITH_TOAST` exists in IPC/main sizing map but is not selected by overlay renderer logic.
- **Legacy settings overlap**: onboarding still uses old `provider` + `modelId` fields while new cloud/local split fields are also present.
- **Cloud model source is static today**: frontend uses fixed provider/model catalogs until backend discovery is wired.

## 10) Where in code

- Window lifecycle and IPC registration: `main/index.ts`
- Preload bridge: `preload/index.ts`
- Shared IPC contracts: `shared/ipc.ts`
- Shared bridge interface: `shared/electron-api.ts`
- Route switch between overlay/control: `renderer/src/App.tsx`
- Overlay UI and interactions: `renderer/src/views/OverlayView.tsx`
- Control panel UI (history, onboarding, settings tree, models, prompts, agent): `renderer/src/views/ControlPanelView.tsx`
- Settings/model constants and catalogs: `renderer/src/lib/constants.ts`
- Persistent local storage helpers: `renderer/src/lib/storage.ts`
- i18n provider and translations: `renderer/src/i18n/index.tsx`
- Mock dictation lifecycle service: `renderer/src/services/fakeTranscriptionService.ts`
- Cross-window notification payload via storage: `renderer/src/lib/app-notifications.ts`
- Core theme tokens and drag/no-drag regions: `renderer/src/styles.css`
