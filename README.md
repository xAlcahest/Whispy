# Whispy

Whispy is a local-first desktop dictation assistant built for fast voice capture, polished UX, and production-ready workflow control.

It combines a floating always-on overlay for instant speech capture with a full control center for conversations, settings, models, prompts, and personalization.

## Highlights

- Dual-window Electron experience:
  - Floating Dictation Panel (always-on-top, compact, draggable, context actions)
  - Control Panel (full management workspace)
- Real-time dictation lifecycle UX:
  - Idle
  - Recording
  - Processing
- Advanced settings workspace with tree navigation for fast access to granular options
- Dedicated prompts workspace with:
  - Preview
  - Customize
  - Test
- Dedicated agent identity section to define a personal agent trigger name
- Cloud + local model orchestration for both:
  - Transcriptions
  - Post-processing
- Provider-specific cloud tabs with iconized navigation:
  - OpenAI
  - Grok (xAI)
  - Meta
  - Custom
- Local model management with backend download/remove actions
- Embedded local `whisper-server` runtime orchestration with CPU/CUDA selection
- Runtime diagnostics for local STT (PID, RSS, CUDA/VRAM visibility via `nvidia-smi`)
- Conversation history with expand/collapse, copy, delete, and bulk clear flow
- Onboarding wizard for first-run setup
- Dark/light theme support with consistent design tokens and custom scrollbar styling
- Backend persistence and runtime services:
  - SQLite state store (`better-sqlite3`)
  - OS keychain secret storage (`keytar`) with emergency plaintext `.env` fallback only when keyring access fails
  - Main-process dictation runtime and prompt pipeline
  - Real auto-paste execution by selected backend

## Product Experience

### Dictation Panel

The floating overlay is designed for minimal interruption and maximum speed:

- One-click start/stop behavior
- Visual status indicators for recording and processing
- Right-click quick menu actions
- Cancel affordance while active
- Auto-hide support when idle

### Control Panel

The control center organizes the full product surface:

- Conversations
- Settings
  - General
  - Models
    - Transcriptions (Cloud + Local)
    - Post-processing (Cloud + Local)
  - Prompts
  - Agent name
  - Shortcuts
  - Info

## Prompting and Agent Routing

Whispy supports two independent prompt layers:

- Normal Prompt: default post-processing behavior for everyday dictation output
- Agent Prompt: specialized behavior triggered when the configured agent name is detected in input

The Prompts workspace includes built-in testing to validate routing behavior and output formatting before applying changes.

## Architecture

Whispy is built with a clean three-part Electron architecture:

- `main/` - window lifecycle, overlay behavior, app shell orchestration
- `preload/` - secure typed bridge via `contextBridge`
- `renderer/` - React UI, state, interaction model, design system components

Core stack:

- Electron + Vite + React + TypeScript
- Tailwind CSS v4 with tokenized design variables
- Lucide icon set
- Reusable component primitives (button, card, dialog, toast, tabs, input, textarea, switch, dropdown)
- `better-sqlite3` for local state persistence
- `openai` for cloud transcription/post-processing provider compatibility
- `node-record-lpcm16` for microphone capture in main process
- `keytar` for secure API key storage on supported systems

## Privacy and Local-First Design

Whispy is designed around local-first operation and user control:

- On-device workflow support
- Transparent model/runtime selection
- Fine-grained post-processing controls

## Getting Started

```bash
npm install
npm run doctor
npm run dev
```

### Optional local runtime commands

Set these environment variables only if you want local runtime execution:

- `WHISPY_LOCAL_STT_COMMAND`: command used for local speech-to-text (receives audio file path as first argument)
- `WHISPY_LOCAL_LLM_COMMAND`: command used for local post-processing (receives JSON `{ prompt, input }` on stdin)
- `WHISPY_WHISPER_SERVER_COMMAND`: explicit `whisper-server` binary path override
- `WHISPY_WHISPER_RUNTIME_CPU_URL`: override CPU runtime download URL used by build-time runtime preparation
- `WHISPY_WHISPER_RUNTIME_CUDA_URL`: override CUDA runtime download URL used by build-time runtime preparation

You can start from `.env.example` and export the values in your shell before running `npm run dev`.

Whispy also persists selected non-sensitive preferences into the user `.env` (for easier portability/editing), including:

- `WHISPY_HOTKEY`
- `WHISPY_ACTIVATION_MODE`
- `WHISPY_AUTO_HIDE_FLOATING_ICON`
- `WHISPY_OVERLAY_RUNTIME_BADGE_ENABLED`
- `WHISPY_THEME`
- `WHISPY_DEBUG_MODE`
- `WHISPY_LAUNCH_AT_LOGIN`

If these variables are not set, Whispy attempts built-in local CLI fallbacks:

- `whisper-cli` for local STT
- `llama-cli` for local post-processing

Whispy prefers `whisper-server` for local STT when available (keeps model loaded in memory/VRAM),
then falls back to `whisper-cli` if needed.

### Preparing Whisper runtime artifacts for builds

Build helper scripts always prepare both Whisper CPU and CUDA runtimes into `resources/bin/whispercpp/`.

`npm run dev` and `npm run build` automatically run runtime preparation first.

```bash
npm run prepare:whisper-runtime
npm run dev
npm run build
```

Platform-targeted wrappers (always CPU + CUDA):

```bash
npm run build:linux
npm run build:win
npm run build:mac
```

### Launching from terminal

Linux packages expose the app executable as:

```bash
whispy
```

This command is available after installing the built package (`.rpm`, `.deb`, AppImage unpacked environment).

### Notes storage

Notes are persisted in the Whispy app data folder:

- `~/.config/whispy-ui/notes/entries/<note-id>.raw.md`
- `~/.config/whispy-ui/notes/entries/<note-id>.processed.md`
- metadata: `~/.config/whispy-ui/notes/folders.json`, `~/.config/whispy-ui/notes/notes-index.json`, `~/.config/whispy-ui/notes/actions.json`

### Preparing local Whisper runtime prerequisites

Use this when you want the app package to already include everything needed for local Whisper transcription:

```bash
npm run prepare:whisper
```

Default behavior:

- prepares Whisper runtime/server binaries for current platform (`cpu,cuda`)
- does not download transcription model files automatically

Optional overrides:

```bash
npm run prepare:whisper -- --variants=cpu
npm run prepare:whisper -- --variants=cpu,cuda --force
```

Notes:

- Runtime binaries are sourced from `OpenWhispr/whisper.cpp` release `0.0.6` when an official prebuilt exists for the target platform.
- Runtime binaries are managed by npm build/package pipeline (in-app runtime download/remove is disabled).
- Linux app icon is sourced from `assets4app/Web/android-chrome-512x512.png` during packaging.
- Packaged app artifacts ship runtime binaries under `<app resources>/bin/whispercpp` for direct execution.
- If no official prebuilt exists for a platform/variant, prepare fails unless you set `WHISPY_WHISPER_RUNTIME_CPU_URL` or `WHISPY_WHISPER_RUNTIME_CUDA_URL`.
- Set `WHISPY_REQUIRE_CUDA_RUNTIME=1` to hard-fail when CUDA artifacts are unavailable.
- Temporary download/extract files are stored under system temp directories (not in project `.cache`).

### FFmpeg in this setup

Current default recording path writes 16kHz mono WAV directly, so local STT does not require FFmpeg for normal dictation.
FFmpeg is still surfaced in diagnostics for compatibility/future conversion paths and custom workflows.

Build production bundles:

```bash
npm run build
npm run dist:linux
```

## Credits

- Whisper runtime binaries and source attribution: `https://github.com/OpenWhispr/whisper.cpp/releases/tag/0.0.6`
- CPU binary assets used by default:
  - `https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-linux-x64-cpu.zip`
  - `https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-win32-x64-cpu.zip`
  - `https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-darwin-arm64.zip`
  - `https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-darwin-x64.zip`
- CUDA binary assets used by default:
  - `https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-linux-x64-cuda.zip`
  - `https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-win32-x64-cuda.zip`

## License

Private repository. All rights reserved.
