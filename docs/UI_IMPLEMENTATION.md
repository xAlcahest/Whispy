# UI Implementation (Current State)

This document tracks what is currently implemented in the frontend codebase.

## 1) UI architecture and windows

- App architecture is Electron `main` + `preload` + React `renderer`, with hash routes (`#/overlay`, `#/control`).
- Two BrowserWindows are created at startup:
  - **Overlay window**: frameless, transparent, always-on-top, skip-taskbar, visible on all workspaces.
  - **Control panel window**: frameless main workspace with custom header and full settings/history UI.
- Overlay size is controlled via IPC size keys (`BASE`, `WITH_MENU`, `EXPANDED`; `WITH_TOAST` exists but is not used in renderer state flow).
- Renderer uses typed `electronAPI` bridge with a browser-safe fallback implementation.
- External links are forced to open in the OS browser:
  - `openExternal` IPC path is validated (`http/https`) and routed through `shell.openExternal`.
  - `setWindowOpenHandler` denies Electron popups and redirects links externally.

## 2) Main UI flows

### Overlay flow

- Overlay states are `IDLE -> RECORDING -> PROCESSING -> IDLE` driven by a mock transcription service.
- Primary interactions:
  - Left click toggles start/stop dictation.
  - Right click opens context menu (start/stop, open control panel, hide overlay).
  - Hover while active shows cancel action.
  - `Esc` closes menu first, then hides overlay.
- Overlay interactivity/size updates dynamically:
  - Captures mouse only while active/hovered/menu open.
  - Auto-hide timer hides overlay when idle if enabled.
- On mock transcription result:
  - Entry is appended to local history.
  - Auto-paste path copies text to clipboard (with destructive notification fallback if clipboard fails).

### Control panel flow

- First-run onboarding (localStorage flag) has 4 steps:
  1. Welcome
  2. Provider/model/language
  3. Permissions (mock)
  4. Hotkey + activation mode
- Post-onboarding top sections:
  - **Conversations**
  - **Settings**

## 3) Settings workspace and layout behavior

- Settings uses fixed two-column layout:
  - Left sidebar navigation (always left, fixed width)
  - Right content panel
- Responsive/scroll behavior:
  - Settings keeps internal scrolling (content panel scrolls; full page does not scroll in settings context).
  - Sidebar has its own internal scroll.
  - Sidebar labels are `whitespace-nowrap` to preserve visual consistency in narrow windows.
- Current sidebar groups/items:
  - **App**: `Preferences`
  - **Speech**: `AI Models`, `Dictionary`
  - **Post-Processing**: `AI Models`, `Agent`, `Prompts`
  - **System**: `Privacy`, `Developer`, `Shortcuts`
- Account code still exists but is hidden through `SHOW_ACCOUNT_SECTION = false`.

## 4) Preferences, translation mode, and autopaste

- Preferences includes:
  - UI language
  - Transcription language (with auto-detect capability guard)
  - Activation controls (hotkey + tap/hold mode)
  - Auto-paste backend selector (dropdown)
  - Microphone access toggle
  - Auto-hide floating icon toggle
  - Launch at login toggle
  - Sounds toggle
- Translation mode config is embedded in Preferences (not a separate sidebar node).
- Auto-paste behavior:
  - Treated as always-on in settings migration/load logic.
  - Backend selection supports: `wtype`, `xdotools`, `ydotools`.
  - Wayland + `wtype` displays warning:
    - `wtype /!\`
    - "wtype isn't supported in your current compositor, consider using xdotools or ydotools (recommended)"
- Display server detection (`wayland` / `x11` / `unknown`) is exposed from main via IPC and consumed in renderer.

## 5) Model configuration UX (Speech + Post-Processing)

Model configuration remains split by pipeline and runtime:

- Pipelines:
  - **Transcriptions**
  - **Post-processing**
- Runtime modes:
  - **Cloud**
  - **Local**

Current behavior:

- Cloud mode:
  - Provider selectors are responsive grid cards (no long single-row overflow dependency).
  - Model selectors are responsive grids (`auto-fit/minmax`) to keep models visible on narrow widths.
  - Works the same for both Speech and Post-processing model sections.
- Local mode:
  - Model cards use wrapped metadata chips (`size`, `speed`, `quality`) instead of cramped inline metadata.
  - Action buttons (`Download/Remove`, `Use local`) are responsive and avoid overflow in narrow layouts.
- Auto-detect language guard:
  - `Auto-detect` is enabled only for ids in `AUTO_DETECT_SUPPORTED_TRANSCRIPTION_MODELS`.
  - If unsupported model is active while `Auto-detect` is selected, UI falls back to `English`.

## 6) Provider/API key behavior and model scanning

Shared cloud behavior for both pipelines:

- Non-custom providers (`openai`, `grok`, `groq`, `meta`):
  - API key field only.
  - Inline helper link opens provider docs for key creation in external browser.
- Custom provider:
  - Fields for base URL, API key, model id.
  - `Scan models` action tries to discover models from a derived models endpoint.
  - Endpoint derivation supports common OpenAI-style paths (`/v1/transcriptions`, `/v1/chat/completions`, etc.) and maps toward `/v1/models`/`/models`.
  - If endpoint fails or response has no models, UI shows explicit fetch error:
    - "Unable to fetch models because the API used does not respond to this endpoint call, or the endpoint does not exist."
  - Scanned models are selectable directly from UI list.

Important current storage behavior:

- API keys are still persisted in localStorage (plain JSON settings).

## 7) Dictionary workflow

- Dictionary lives under **Speech** and controls replacement rules used in post-processing pipeline logic.
- Features implemented:
  - Enable/disable dictionary replacements toggle.
  - Add/remove replacement rules (`source -> target`).
  - Save icon per rule (only shown when rule has unsaved changes and valid fields).
  - Save icon disappears once rule is saved; reappears on subsequent edits.
  - Preview input/output block (visible only when dictionary is enabled).
- Disabled-state behavior:
  - Existing rules remain visible but are grayed-out (read-only).
  - Rule editing, save/delete actions, and add-rule are disabled while dictionary is off.

## 8) Prompts workspace and agent section

- Prompts remains a dedicated workspace with `Preview`, `Customize`, `Test`.
- Tabs are rendered in one horizontal row and remain side-by-side with horizontal overflow handling in narrow widths.
- Agent identity remains a dedicated section under Post-Processing.
- Prompt test route logic:
  - Agent route if input contains agent name.
  - Translation route if translation mode is enabled and input starts with `translate:`.
  - Normal route otherwise.

## 9) Developer/Info updates

- `Developer` section now includes **Bug logs** card above runtime status:
  - Debug mode toggle (`debugModeEnabled`)
  - Show/hide log paths action
  - Mock paths for renderer/main/crash logs
- Runtime status now includes provider context when transcription runtime is cloud:
  - Example: `Cloud (OpenAI)`

## 10) Conversations, i18n, and known risks

- Conversations/history supports search, filters, copy, delete, clear-all, and header count badge.
- i18n scaffolding is present; language options remain effectively English-only today.

Current known risks / TODOs:

- Dictation/runtime/download behaviors are still mock implementations.
- API keys are stored in localStorage (no secure keychain integration yet).
- Cross-window sync still relies heavily on storage events.
- Legacy onboarding fields (`provider`, `modelId`) still coexist with newer split settings.
- Cloud provider catalogs are still frontend static for non-custom providers (custom endpoint scan exists; full backend discovery is pending).

## 11) Where in code

- Window lifecycle + IPC handlers: `main/index.ts`
- Preload bridge: `preload/index.ts`
- Shared IPC contracts: `shared/ipc.ts`
- Shared bridge interface: `shared/electron-api.ts`
- Overlay UI: `renderer/src/views/OverlayView.tsx`
- Control panel and settings UX: `renderer/src/views/ControlPanelView.tsx`
- Settings defaults/catalogs: `renderer/src/lib/constants.ts`
- Settings/history persistence and migrations: `renderer/src/lib/storage.ts`
- App settings types: `renderer/src/types/app.ts`
- Renderer electron fallback API: `renderer/src/lib/electron-api.ts`
