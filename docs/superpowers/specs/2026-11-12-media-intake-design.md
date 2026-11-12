# Media intake for Agent Client 0.13.0

Provide one Obsidian command for obtaining article text and transcripts, and a second tab in the same dialog for manually checking subscriptions. Retain the upstream chat and Agent configuration.

- Audio files and microphone recordings go through FFmpeg and whisper.cpp locally. Users can preview or save Markdown before opening a summary chat.
- Article text comes from readable HTML. Video and podcast sources prefer published transcripts or human captions, then automatic captions, then local transcription. Results include their source, acquisition method and available timestamps.
- An explicit Summary action opens an upstream chat using the selected agent. The media module never needs an ACP client to acquire or save content.
- RSS/Atom, YouTube, Bilibili and Xiaoyuzhou subscriptions use manual refresh and stable entry IDs. Preserve existing subscriptions when installing over DataAlchemy, with independent media settings and state.
- Media processing reports failed acquisition explicitly, terminates local commands on cancel, and keeps the source material available after chat failure.
- Keep media code in `src/media`. The upstream plugin entry mounts it and supplies chat handoff. Reuse existing vault, chat and credential functionality through narrow interfaces.

Adapted architecture principles from the wire-harness project's Wave 2B lessons and architecture review policy: the producer owns source identity and diagnostics, orchestration stays separate from extraction, and review blockers need concrete evidence on a supported path.
