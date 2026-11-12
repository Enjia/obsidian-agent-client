import { Modal, normalizePath, Notice, Setting, type App } from "obsidian";
import { writeFile } from "fs/promises";
import { extname, join } from "path";
import { materialMarkdown, type Material } from "./material";
import { withMediaDirectory } from "./media-tools";
import {
	defaultTranscriptionTools,
	transcribeAudio,
	type TranscriptionTools,
} from "./transcription";

export class MediaModal extends Modal {
	private job?: AbortController;
	private recorder?: MediaRecorder;
	private stream?: MediaStream;
	private microphoneRequest = false;
	private discardRecording = false;
	private closed = false;
	private material?: Material;
	private preview!: HTMLTextAreaElement;
	private status!: HTMLElement;

	constructor(
		app: App,
		private tools: TranscriptionTools = defaultTranscriptionTools(),
	) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		this.setTitle("Read, transcribe and summarize");
		new Setting(this.contentEl)
			.setName("Whisper model")
			.setDesc("Path to a multilingual whisper.cpp model file.")
			.addText((text) =>
				text.setValue(this.tools.model).onChange((value) => {
					this.tools.model = value.trim();
				}),
			);
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
			if (input)
				void this.transcribe(input, input.name, extname(input.name));
		});
		const record = controls.createEl("button", { text: "Record" });
		record.addEventListener("click", () => void this.record(record));
		controls
			.createEl("button", { text: "Cancel task" })
			.addEventListener("click", () => {
				this.job?.abort();
				if (this.recorder || this.microphoneRequest) {
					this.discardRecording = true;
					if (this.recorder?.state === "recording")
						this.recorder.stop();
					this.report("Recording cancelled.");
				}
			});
		this.status = this.contentEl.createDiv({ attr: { role: "status" } });
		this.preview = this.contentEl.createEl("textarea", {
			cls: "agent-client-media-preview",
			attr: { readonly: "", "aria-label": "Source material preview" },
		});
		this.contentEl
			.createEl("button", { text: "Save as note" })
			.addEventListener("click", () => void this.save());
	}

	onClose(): void {
		this.closed = true;
		this.job?.abort();
		if (this.recorder?.state === "recording") this.recorder.stop();
		this.stream?.getTracks().forEach((track) => track.stop());
		this.contentEl.empty();
	}

	private async record(button: HTMLButtonElement): Promise<void> {
		if (this.recorder?.state === "recording") {
			this.recorder.stop();
			return;
		}
		if (this.job || this.recorder || this.microphoneRequest) return;
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
					void this.transcribe(
						blob,
						"Recording " + new Date().toLocaleString(),
						suffix,
					);
				}
			};
			recorder.start();
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

	private async transcribe(
		file: Blob,
		title: string,
		extension: string,
	): Promise<void> {
		if (this.job || this.recorder || this.microphoneRequest) {
			this.report("Finish the current recording or task first.");
			return;
		}
		await this.run((signal) =>
			withMediaDirectory(async (directory) => {
				const path = join(directory, "input" + extension);
				await writeFile(
					path,
					new Uint8Array(await file.arrayBuffer()),
					{ signal },
				);
				return transcribeAudio({
					path,
					title,
					tools: this.tools,
					signal,
					progress: (status) => this.report(status),
				});
			}),
		);
	}

	private async run(
		operation: (signal: AbortSignal) => Promise<Material>,
	): Promise<void> {
		const job = new AbortController();
		this.job = job;
		try {
			const material = await operation(job.signal);
			if (job.signal.aborted || this.closed) return;
			this.material = material;
			this.preview.value = materialMarkdown(material);
			this.report("Ready to preview or save.");
		} catch (error) {
			this.report(
				job.signal.aborted
					? "Task cancelled."
					: error instanceof Error
						? error.message
						: String(error),
			);
		} finally {
			this.job = undefined;
		}
	}

	private async save(): Promise<void> {
		if (!this.material) return;
		const name =
			this.material.title
				.replace(/[\\/:*?"<>|#[\]\r\n]/g, "-")
				.trim()
				.slice(0, 100) || "Source material";
		const base = normalizePath("Media - " + name);
		let path = base + ".md";
		for (let index = 2; this.app.vault.getAbstractFileByPath(path); index++)
			path = `${base} (${index}).md`;
		try {
			await this.app.vault.create(path, materialMarkdown(this.material));
			new Notice(`Saved ${path}`);
		} catch (error) {
			this.report(error instanceof Error ? error.message : String(error));
		}
	}

	private report(text: string): void {
		if (!this.closed) this.status.setText(text);
	}
}
