<p align="center">
  <img src="assets4app/Web/android-chrome-512x512.png" alt="Whispy" width="128" height="128">
</p>

<h1 align="center">Whispy</h1>

<p align="center">
  Desktop dictation assistant. Fast voice capture, polished UX, local-first design.
</p>

---

Whispy combines a floating always-on overlay for instant speech capture with a full control center for conversations, notes, settings, models, and prompts. Built with Electron, React, and TypeScript.

## Features

**Dictation** -- press a hotkey, speak, and the transcribed text gets pasted into the focused app. Works on Linux (Wayland and X11), Windows, and macOS. Auto-detects terminals and picks the right paste shortcut.

**Cloud and local transcription** -- use OpenAI, Groq, Grok (xAI), Meta, or a custom OpenAI-compatible endpoint for cloud STT. For local transcription, Whispy bundles a whisper-server runtime with CPU and CUDA support.

**Post-processing** -- optional LLM pass on the transcription output. Supports the same cloud providers plus local llama-cli. Configurable prompts for normal dictation, agent-triggered actions, and translation.

**Notes** -- a built-in workspace for capturing and enhancing longer dictations. Notes are stored as markdown files in the app data folder.

**Privacy** -- audio is never stored. Transcriptions stay on your machine. API keys are kept in the OS keychain (with a plaintext .env fallback when the keyring is unavailable).

## Getting started

```bash
npm install
npm run doctor
npm run dev
```

The `doctor` script checks for required system dependencies (ffmpeg, recording tools, etc.).

## Building

```bash
npm run build:linux
npm run build:win
npm run build:mac
```

Linux packages (pacman, deb, rpm):

```bash
npm run dist:linux
```

Whisper runtime binaries are prepared automatically during build. Both CPU and CUDA variants are included.

## Local runtime

Whispy prefers `whisper-server` for local STT (keeps the model loaded in memory). Falls back to `whisper-cli` if the server isn't available, and to `llama-cli` for local post-processing.

Override with environment variables if needed:

```
WHISPY_LOCAL_STT_COMMAND     -- custom STT command (receives audio file path)
WHISPY_LOCAL_LLM_COMMAND     -- custom post-processing command (receives JSON on stdin)
WHISPY_WHISPER_SERVER_COMMAND -- explicit whisper-server binary path
```

See `.env.example` for the full list.

## Architecture

```
main/       -- Electron main process, window lifecycle, backend services
preload/    -- secure typed IPC bridge via contextBridge
renderer/   -- React UI, state management, design system
shared/     -- types, defaults, IPC channel definitions
```

Core dependencies: Electron, Vite, React, TypeScript, Tailwind CSS v4, better-sqlite3, keytar, dbus-next.

## Credits

Whisper runtime binaries from [OpenWhispr/whisper.cpp](https://github.com/OpenWhispr/whisper.cpp/releases/tag/0.0.6).

## License

[AGPL-3.0](LICENSE)
