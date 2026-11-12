import type { MediaStore } from "./media-store";
import { fetchSourceText } from "./source-fetch";
import { Modal, normalizePath, Notice, Setting, type App } from "obsidian";
import { extname } from "path";
import {
	INLINE_SUMMARY_LIMIT,
	materialMarkdown,
	summaryPrompt,
	type Material,
} from "./material";
import { readSource, type SourceAudio, type SourceLink } from "./source-reader";
import {
	defaultTranscriptionTools,
	type TranscriptionTools,
} from "./transcription";
import {
	type TranscriptionTask,
	type TranscriptionInput,
	type TranscriptionState,
} from "./transcription-task";

interface SummaryChat {
	agents(): Array<{ id: string; displayName: string }>;
	defaultAgentId(): string;
	start(agentId: string, prompt: string): Promise<void>;
}

export class MediaModal extends Modal {
	private readJob?: AbortController;
	private view?: AbortController;
	private pendingSource?: { link?: SourceLink; back?: () => void };
	private unsubscribeTask?: () => void;
	private followingTask = false;
	private recorder?: MediaRecorder;
	private stream?: MediaStream;
	private microphoneRequest = false;
	private discardRecording = false;
	private closed = false;
	private material?: Material;
	private pendingTranscription?: SourceAudio;
	private sourceInput!: HTMLInputElement;
	private transcribeButton!: HTMLButtonElement;
	private preview!: HTMLTextAreaElement;
	private status!: HTMLElement;
	private summarizing = false;
	private agentId?: string;

	constructor(
		app: App,
		private chat: SummaryChat,
		private store: MediaStore,
		private transcription: TranscriptionTask,
		private tools: TranscriptionTools = defaultTranscriptionTools(),
	) {
		super(app);
	}

	openSource(link?: SourceLink, back?: () => void): void {
		this.pendingSource = { link, back };
		this.open();
	}

	onOpen(): void {
		this.closed = false;
		const view = new AbortController();
		this.view = view;
		this.setTitle("Read, transcribe and summarize");
		const pending = this.pendingSource;
		this.pendingSource = undefined;
		const source = pending?.link;
		const back = pending?.back;
		const task = this.transcription.current;
		this.followingTask = Boolean(
			task && (!source || source.url === task.source),
		);
		this.pendingTranscription = undefined;
		if (source || this.followingTask) this.material = undefined;
		if (back) {
			this.contentEl
				.createEl("button", {
					text: "← 返回订阅",
					attr: { type: "button" },
				})
				.addEventListener("click", () => {
					this.close();
					back();
				});
		}
		const readLink = () => {
			const url = this.sourceInput.value.trim();
			void this.readLink(source?.url === url ? source : { url });
		};
		new Setting(this.contentEl)
			.setName("Article, podcast or video link")
			.addText((text) => {
				this.sourceInput = text
					.setPlaceholder("Source URL")
					.setValue(
						source?.url ??
							(this.followingTask ? (task?.source ?? "") : ""),
					).inputEl;
				this.sourceInput.addEventListener("input", () => {
					this.followingTask = false;
					this.clearSourceResult();
					this.report("");
				});
				this.sourceInput.addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						readLink();
					}
				});
			})
			.addButton((button) =>
				button.setButtonText("Read source").onClick(readLink),
			);
		new Setting(this.contentEl)
			.setName("Whisper model")
			.setDesc("Path to a multilingual whisper.cpp model file.")
			.addText((text) => {
				const input = text.setValue(this.tools.model).inputEl;
				void this.store
					.read()
					.then(({ model }) => {
						if (
							!model ||
							view.signal.aborted ||
							input.value !== this.tools.model
						)
							return;
						this.tools.model = model;
						input.value = model;
					})
					.catch((error: unknown) => {
						if (!view.signal.aborted) {
							this.report(
								error instanceof Error
									? error.message
									: String(error),
							);
						}
					});
				input.addEventListener("change", () => {
					this.tools.model =
						input.value.trim() || defaultTranscriptionTools().model;
					input.value = this.tools.model;
					void this.store
						.setModel(this.tools.model)
						.catch((error: unknown) =>
							this.report(
								error instanceof Error
									? error.message
									: String(error),
							),
						);
				});
			});
		const controls = this.contentEl.createDiv({
			cls: "agent-client-media-controls",
		});
		const file = controls.createEl("input", {
			attr: {
				type: "file",
				accept: "audio/*,video/*",
				"aria-label": "Audio file",
			},
		});
		file.addEventListener("change", () => {
			const input = file.files?.[0];
			file.value = "";
			if (input) {
				this.startTranscription({
					kind: "file",
					file: input,
					title: input.name,
					extension: extname(input.name),
				});
			}
		});
		const record = controls.createEl("button", { text: "Record" });
		record.addEventListener("click", () => void this.record(record));
		controls
			.createEl("button", { text: "Cancel task" })
			.addEventListener("click", () => {
				this.readJob?.abort();
				if (this.followingTask) this.transcription.cancel();
				if (this.recorder || this.microphoneRequest) {
					this.discardRecording = true;
					if (this.recorder?.state === "recording")
						this.recorder.stop();
					this.report("Recording cancelled.");
				}
			});
		this.status = this.contentEl.createDiv({ attr: { role: "status" } });
		this.transcribeButton = this.contentEl.createEl("button", {
			text: "开始本地转录",
			attr: { type: "button" },
		});
		this.transcribeButton.hidden = true;
		this.transcribeButton.addEventListener("click", () => {
			const audio = this.pendingTranscription;
			if (!audio) return;
			this.startTranscription({ kind: "source", audio });
		});
		this.preview = this.contentEl.createEl("textarea", {
			cls: "agent-client-media-preview",
			attr: { readonly: "", "aria-label": "Source material preview" },
		});
		if (this.material) this.preview.value = materialMarkdown(this.material);
		const agents = this.chat.agents();
		if (!agents.some((agent) => agent.id === this.agentId))
			this.agentId = this.chat.defaultAgentId();
		new Setting(this.contentEl)
			.setName("Result")
			.addButton((button) =>
				button
					.setButtonText("Save as note")
					.onClick(() => void this.save()),
			)
			.addDropdown((dropdown) => {
				for (const agent of agents)
					dropdown.addOption(agent.id, agent.displayName);
				dropdown.setValue(this.agentId ?? "").onChange((agentId) => {
					this.agentId = agentId;
				});
			})
			.addButton((button) =>
				button
					.setButtonText("Summarize with agent")
					.setCta()
					.onClick(() => void this.summarize()),
			);
		this.unsubscribeTask = this.transcription.subscribe((state) =>
			this.renderTask(state),
		);
		if (source && !this.followingTask) void this.readLink(source);
	}

	onClose(): void {
		this.closed = true;
		this.view?.abort();
		this.discardRecording = true;
		this.unsubscribeTask?.();
		this.unsubscribeTask = undefined;
		this.readJob?.abort();
		this.readJob = undefined;
		if (this.recorder?.state === "recording") this.recorder.stop();
		this.stream?.getTracks().forEach((track) => track.stop());
		this.contentEl.empty();
	}

	private async record(button: HTMLButtonElement): Promise<void> {
		if (this.recorder?.state === "recording") {
			this.recorder.stop();
			return;
		}
		if (this.readJob || this.recorder || this.microphoneRequest) return;
		if (this.transcription.current?.phase === "running") {
			this.report("已有转录正在进行。");
			return;
		}
		this.microphoneRequest = true;
		this.discardRecording = false;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
			});
			if (this.closed || this.discardRecording) {
				stream.getTracks().forEach((track) => track.stop());
				return;
			}
			this.stream = stream;
			const recorder = new MediaRecorder(stream);
			this.recorder = recorder;
			const chunks: Blob[] = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size) chunks.push(event.data);
			};
			recorder.onerror = () => {
				this.discardRecording = true;
				this.report("Recording failed.");
			};
			recorder.onstop = () => {
				stream.getTracks().forEach((track) => track.stop());
				this.stream = undefined;
				this.recorder = undefined;
				button.setText("Record");
				if (!this.closed && !this.discardRecording && chunks.length) {
					const blob = new Blob(chunks, { type: recorder.mimeType });
					const suffix = recorder.mimeType.includes("mp4")
						? ".m4a"
						: recorder.mimeType.includes("ogg")
							? ".ogg"
							: ".webm";
					this.startTranscription({
						kind: "file",
						file: blob,
						title: "Recording " + new Date().toLocaleString(),
						extension: suffix,
					});
				}
			};
			recorder.start();
			this.followingTask = false;
			this.clearSourceResult();
			button.setText("Stop and transcribe");
			this.report("Recording…");
		} catch (error) {
			this.stream?.getTracks().forEach((track) => track.stop());
			this.stream = undefined;
			this.recorder = undefined;
			this.report(
				error instanceof Error
					? error.message
					: "Could not start recording.",
			);
		} finally {
			this.microphoneRequest = false;
		}
	}

	private startTranscription(input: TranscriptionInput): void {
		if (this.readJob || this.recorder || this.microphoneRequest) {
			this.report("Finish the current recording or task first.");
			return;
		}
		if (!this.transcription.start(input, this.tools)) {
			this.report("已有转录正在进行。");
			return;
		}
		this.clearSourceResult();
		this.followingTask = true;
		this.renderTask(this.transcription.current);
	}

	private async readLink(link: SourceLink): Promise<void> {
		if (this.readJob || this.recorder || this.microphoneRequest) {
			this.report("Finish the current recording or task first.");
			return;
		}
		this.followingTask = false;
		this.clearSourceResult();
		const job = new AbortController();
		const { signal } = job;
		this.readJob = job;
		this.sourceInput.disabled = true;
		try {
			const result = await readSource(link, {
				get: (url, headers) => fetchSourceText(url, headers, signal),
				signal,
				progress: (status) => {
					if (!signal.aborted) this.report(status);
				},
			});
			if (signal.aborted) return;
			if ("audioUrl" in result) {
				this.pendingTranscription = result;
				this.report(
					`${result.title} · 未找到可直接使用的文字。开始本地转录后将下载音频。`,
				);
			} else {
				this.showMaterial(result);
				this.report("Ready to preview or save.");
			}
		} catch (error) {
			if (this.readJob !== job) return;
			this.report(
				signal.aborted
					? "Task cancelled."
					: error instanceof Error
						? error.message
						: String(error),
			);
		} finally {
			if (this.readJob === job) {
				this.readJob = undefined;
				this.sourceInput.disabled = false;
				this.renderTask(this.transcription.current);
			}
		}
	}

	private clearSourceResult(): void {
		this.pendingTranscription = undefined;
		this.transcribeButton.hidden = true;
		this.showMaterial(undefined);
	}

	private showMaterial(material: Material | undefined): void {
		this.material = material;
		this.preview.value = material ? materialMarkdown(material) : "";
	}

	private renderTask(state: TranscriptionState | undefined): void {
		this.transcribeButton.hidden = !this.pendingTranscription;
		this.transcribeButton.disabled = state?.phase === "running";
		this.transcribeButton.title =
			state?.phase === "running" ? "已有转录正在进行。" : "";
		if (!this.followingTask || !state) return;
		if (state.phase === "ready") {
			this.showMaterial(state.material);
			this.report(`${state.title} · 转录完成，可以预览、保存或摘要。`);
		} else {
			this.report(`${state.title} · ${state.detail}`);
		}
	}

	private async save(): Promise<void> {
		if (!this.material) {
			this.report("Read a source or transcribe audio first.");
			return;
		}
		try {
			const path = await this.saveMaterial(this.material);
			new Notice(`Saved ${path}`);
		} catch (error) {
			this.report(error instanceof Error ? error.message : String(error));
		}
	}

	private async saveMaterial(material: Material): Promise<string> {
		const name =
			material.title
				.replace(/[\\/:*?"<>|#[\]\r\n]/g, "-")
				.trim()
				.slice(0, 100) || "Source material";
		const base = normalizePath("Media - " + name);
		let path = base + ".md";
		for (let index = 2; this.app.vault.getAbstractFileByPath(path); index++)
			path = `${base} (${index}).md`;
		await this.app.vault.create(path, materialMarkdown(material));
		return path;
	}

	private async summarize(): Promise<void> {
		if (this.summarizing) return;
		const material = this.material;
		const agentId = this.agentId;
		if (!material || !agentId) {
			this.report("Read a source and select an agent first.");
			return;
		}
		this.summarizing = true;
		try {
			const notePath =
				materialMarkdown(material).length > INLINE_SUMMARY_LIMIT
					? await this.saveMaterial(material)
					: undefined;
			if (notePath) new Notice(`Saved source material to ${notePath}`);
			await this.chat.start(agentId, summaryPrompt(material, notePath));
			this.close();
		} catch (error) {
			this.report(error instanceof Error ? error.message : String(error));
		} finally {
			this.summarizing = false;
		}
	}

	private report(text: string): void {
		if (!this.closed) this.status.setText(text);
	}
}
