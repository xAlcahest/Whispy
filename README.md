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
- Local model management with download/remove actions and progress simulation
- Conversation history with filters, search, expand/collapse, copy, delete, and bulk clear flow
- Onboarding wizard for first-run setup
- Dark/light theme support with consistent design tokens and custom scrollbar styling

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

## Privacy and Local-First Design

Whispy is designed around local-first operation and user control:

- On-device workflow support
- Transparent model/runtime selection
- Fine-grained post-processing controls

## Getting Started

```bash
npm install
npm run dev
```

Build production bundles:

```bash
npm run build
```

## License

Private repository. All rights reserved.
