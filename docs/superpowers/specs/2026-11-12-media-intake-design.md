# Media intake for Agent Client 0.13.0

Provide separate Obsidian toolbar entries for media intake and manual subscription checks. Retain the upstream chat and Agent configuration.

- Audio files and microphone recordings go through FFmpeg and whisper.cpp locally. Users can preview or save Markdown before opening a summary chat.
- Article text comes from readable HTML. Video and podcast sources prefer published transcripts or human captions, then automatic captions. The source reader returns an audio reference when text is unavailable. The media dialog starts local transcription only after the user confirms, and shows the result with its source, acquisition method and available timestamps.
- An explicit Summary action opens an upstream chat using the selected agent. The media module never needs an ACP client to acquire or save content.
- RSS/Atom, YouTube, Bilibili and Xiaoyuzhou subscriptions use manual refresh and stable entry IDs. Preserve existing subscriptions when installing over DataAlchemy, with independent media settings and state.
- The media feature owns one in-memory transcription task per plugin instance. The task owns its process lifetime, progress and latest result. The media dialog observes it, and the subscription dialog offers a route back to it. Closing either dialog leaves the task running. Explicit cancellation, plugin unload and application quit stop the task. Source lookup stays scoped to the media dialog. Saving material and sending it for summary are separate actions.
- Fresh subscription views open collapsed. Returning explicitly from media processing restores the prior view position and expanded rows.
- Keep media code in `src/media`. The upstream plugin entry mounts it and supplies chat handoff. Reuse existing vault, chat and credential functionality through narrow interfaces.

Adapted architecture principles from the wire-harness project's Wave 2B lessons and architecture review policy: the producer owns source identity and diagnostics, orchestration stays separate from extraction, and review blockers need concrete evidence on a supported path.
