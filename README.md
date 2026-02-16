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
  - OS keychain secret storage (`keytar`, encrypted fallback when available)
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
- `WHISPY_WHISPER_RUNTIME_CPU_URL`: override CPU runtime download URL used by in-app runtime installer
- `WHISPY_WHISPER_RUNTIME_CUDA_URL`: override CUDA runtime download URL used by in-app runtime installer

You can start from `.env.example` and export the values in your shell before running `npm run dev`.

If these variables are not set, Whispy attempts built-in local CLI fallbacks:

- `whisper-cli` for local STT
- `llama-cli` for local post-processing

Whispy prefers `whisper-server` for local STT when available (keeps model loaded in memory/VRAM),
then falls back to `whisper-cli` if needed.

### Preparing Whisper runtime artifacts for builds

Build helper scripts prepare official `ggml-org/whisper.cpp` artifacts into `resources/bin/whispercpp/`.

```bash
npm run prepare:whisper-runtime
```

Platform-targeted wrappers:

```bash
npm run build:linux
npm run build:win
npm run build:mac
```

Notes:

- Windows uses official prebuilt assets (`whisper-bin` / `whisper-cublas`).
- If no official prebuilt is available for the target platform, the script builds `whisper-server` from official source.
- CUDA runtime preparation is best-effort by default; set `WHISPY_REQUIRE_CUDA_RUNTIME=1` to hard-fail when unavailable.

### FFmpeg in this setup

Current default recording path writes 16kHz mono WAV directly, so local STT does not require FFmpeg for normal dictation.
FFmpeg is still surfaced in diagnostics for compatibility/future conversion paths and custom workflows.

Build production bundles:

```bash
npm run build
```

## License

Private repository. All rights reserved.
