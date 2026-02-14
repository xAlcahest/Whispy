# Project Status

This document tracks what is already implemented and what should be improved next.

## Done

- Electron three-part architecture (`main`, `preload`, `renderer`)
- Floating dictation overlay with mock recording/processing states
- Control Panel with onboarding and local history
- Settings workspace with tree navigation
- Separate model flows for:
  - Transcriptions
  - Post-processing
- Separate mode views inside each flow:
  - Cloud view
  - Local view
- Prompt workspace (Preview / Customize / Test)
- Dedicated Agent name section
- Conversation counter badge in Conversations header
- Horizontal centered provider tabs with visible separators
- LobeHub provider logos integrated for cloud providers

## In Progress / Open Improvements

- Fine-tune provider logo visual parity across light and dark themes
- Add additional UI locales and full translation dictionaries
- Add persistent in-app changelog/history for UX changes
- Improve model metadata density for advanced users

## Next Candidate Work

- Add search/filter inside settings tree for faster navigation
- Add per-provider capability badges (streaming, autodetect language, tool use)
- Add mock analytics panel for usage stats and model selection trends
- Add export/import for settings and prompts
