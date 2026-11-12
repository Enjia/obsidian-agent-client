# Media intake implementation plan

**Goal** — Add source intake, offline transcription, explicit Agent summaries and lightweight subscriptions to the fork of 0.13.0.

**Architecture** — `src/media` owns intake, saved material and subscription state. The plugin supplies an Obsidian command and the existing upstream chat handoff. The media module runs tools with argument arrays and scoped temporary directories.

**Verification** — Every increment gets a focused regression test and fresh independent review. Blocking findings require a reachable product failure or a violated acceptance criterion.

1. Local audio. Test the FFmpeg-to-Whisper pipeline and timestamped Markdown. Wire recording, file selection, preview and save through the media command. Check real audio separately from process fixtures.
2. URL intake and summary. Test article extraction and provider precedence, including failure versus absent captions. Connect summary to the existing Agent setup and chat flow. Keep the original material after failure.
3. Subscriptions and legacy import. Test RSS/Atom and supported platform normalization, repeat refresh, persistence and idempotent import. Wire add, remove, refresh and open-item controls.
4. Integration. Run the upstream test suite and production build. Exercise public sources, local audio, Codex configuration and summary. Verify a test vault before deploying or reporting platform limitations. Push the reviewed branch to Enjia's fork.
