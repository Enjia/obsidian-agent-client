// @vitest-environment jsdom
import { App } from "obsidian";
import { expect, it, vi } from "vitest";
import { transcribeWithBailian } from "../src/media/bailian-transcription";
import { MediaModal } from "../src/media/MediaModal";
import { MediaStore } from "../src/media/media-store";
import { transcribeSource } from "../src/media/transcription";
import { TranscriptionTask } from "../src/media/transcription-task";

vi.mock("../src/media/bailian-transcription", () => ({
	transcribeWithBailian: vi.fn(),
}));

vi.mock("../src/media/transcription", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/media/transcription")>()),
	transcribeSource: vi.fn(),
}));

vi.mock("obsidian", () => {
	function createElement(
		this: HTMLElement,
		tag: string,
		options?: {
			text?: string;
			cls?: string;
			attr?: Record<string, string>;
		},
	): HTMLElement {
		const element = Object.assign(document.createElement(tag), {
			createEl: createElement,
			setText(this: HTMLElement, value: string) {
				this.textContent = value;
			},
		});
		element.textContent = options?.text ?? "";
		if (options?.cls) element.className = options.cls;
		for (const [name, value] of Object.entries(options?.attr ?? {})) {
			element.setAttribute(name, value);
		}
		return this.appendChild(element);
	}
	return {
		App: class {
			secretStorage = {
				getSecret: (id: string) =>
					id === "bailian-test" ? "test-key" : null,
			};
		},
		SecretComponent: class {
			setValue() {
				return this;
			}
			onChange() {
				return this;
			}
		},
		Modal: class {
			constructor(readonly app: App) {}
			contentEl = Object.assign(document.createElement("div"), {
				createEl: createElement,
				createDiv(
					this: HTMLElement & { createEl: typeof createElement },
					options: Parameters<typeof createElement>[1],
				) {
					return this.createEl("div", options);
				},
				empty: () => this.contentEl.replaceChildren(),
			});
			setTitle() {}
			open() {
				(this as unknown as MediaModal).onOpen();
			}
			close() {
				(this as unknown as MediaModal).onClose();
			}
		},
		Setting: class {
			constructor(private parent: HTMLElement) {}
			setName() {
				return this;
			}
			setDesc() {
				return this;
			}
			addComponent(callback: (el: HTMLElement) => unknown) {
				callback(this.parent);
				return this;
			}
			addText(
				callback: (component: {
					inputEl: HTMLInputElement;
					setPlaceholder(value: string): unknown;
					setValue(value: string): unknown;
				}) => void,
			) {
				const inputEl = this.parent.appendChild(
					document.createElement("input"),
				);
				callback({
					inputEl,
					setPlaceholder(this: object, value) {
						inputEl.placeholder = value;
						return this;
					},
					setValue(this: object, value) {
						inputEl.value = value;
						return this;
					},
				});
				return this;
			}
			addButton(
				callback: (component: {
					setButtonText(value: string): unknown;
					onClick(handler: () => void): unknown;
					setCta(): unknown;
				}) => void,
			) {
				const button = this.parent.appendChild(
					document.createElement("button"),
				);
				callback({
					setButtonText(this: object, value) {
						button.textContent = value;
						return this;
					},
					onClick(this: object, handler) {
						button.addEventListener("click", handler);
						return this;
					},
					setCta(this: object) {
						return this;
					},
				});
				return this;
			}
			addDropdown(
				callback: (component: {
					addOption(): unknown;
					setValue(): unknown;
					onChange(): unknown;
				}) => void,
			) {
				callback({
					addOption(this: object) {
						return this;
					},
					setValue(this: object) {
						return this;
					},
					onChange(this: object) {
						return this;
					},
				});
				return this;
			}
		},
	};
});

it("waits for confirmation, keeps processing after closing, and reopens the latest progress", async () => {
	const store = new MediaStore(
		{
			exists: async () => false,
			read: async () => "",
			write: async () => {},
		},
		"media.json",
	);
	const task = new TranscriptionTask();
	const modal = new MediaModal(
		new App(),
		{ agents: () => [], defaultAgentId: () => "", start: vi.fn() },
		store,
		task,
		{ ffmpeg: "ffmpeg", whisper: "whisper", model: "model.bin" },
	);
	const audio = {
		title: "Episode One",
		url: "https://example.org/episode",
		audioUrl: "https://example.org/audio.mp3",
	};
	const back = vi.fn();
	const transcribe = vi.mocked(transcribeSource).mockReset();
	const button = (name: string) => {
		const element = Array.from(
			modal.contentEl.querySelectorAll("button"),
		).find((node) => node.textContent === name);
		if (!element) throw new Error("Missing button " + name);
		return element;
	};
	const confirm = async () => {
		await vi.waitFor(() =>
			expect(button("开始本地转录").hidden).toBe(false),
		);
		button("开始本地转录").click();
	};
	modal.openSource(audio, back);
	await vi.waitFor(() => expect(button("开始本地转录").hidden).toBe(false));
	expect(transcribe).not.toHaveBeenCalled();
	expect(button("云端转录（百炼）").hidden).toBe(false);
	expect(modal.contentEl.querySelector('[role="status"]')?.textContent).toBe(
		"Episode One",
	);
	button("云端转录（百炼）").click();
	expect(
		modal.contentEl.querySelector('[role="status"]')?.textContent,
	).toContain("普通百炼 API Key");
	expect(task.current).toBeUndefined();
	button("← 返回订阅").click();
	expect(back).toHaveBeenCalledOnce();
	expect(transcribe).not.toHaveBeenCalled();

	let reportProgress: ((status: string) => void) | undefined;
	let taskSignal: AbortSignal | undefined;
	let finish: (() => void) | undefined;
	transcribe.mockImplementationOnce((_audio, { signal, progress }) => {
		taskSignal = signal;
		reportProgress = progress;
		return new Promise((resolve) => {
			finish = () =>
				resolve({
					title: audio.title,
					method: "local-transcription",
					text: "First transcript",
				});
		});
	});
	modal.openSource(audio, back);
	await confirm();
	expect(transcribe).toHaveBeenCalledOnce();
	expect(taskSignal?.aborted).toBe(false);

	button("← 返回订阅").click();
	expect(taskSignal?.aborted).toBe(false);
	expect(back).toHaveBeenCalledTimes(2);
	reportProgress?.("Transcribing locally…");
	const rejected = task.start(
		{
			kind: "source",
			audio: {
				title: "Second",
				source: "https://example.org/second",
				audioUrl: "https://example.org/second.mp3",
			},
		},
		{ ffmpeg: "ffmpeg", whisper: "whisper", model: "model.bin" },
	);
	expect(rejected).toBe(false);

	modal.openSource(undefined, back);
	expect(
		modal.contentEl.querySelector('[role="status"]')?.textContent,
	).toContain("Episode One · Transcribing locally…");
	expect(button("开始本地转录").hidden).toBe(true);
	modal.close();
	finish?.();
	await vi.waitFor(() => expect(task.current?.phase).toBe("ready"));
	modal.openSource();
	expect(modal.contentEl.querySelector("textarea")?.value).toContain(
		"First transcript",
	);
	modal.close();

	transcribe.mockImplementationOnce((_audio, { signal }) => {
		taskSignal = signal;
		return new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () =>
				reject(new Error("Cancelled")),
			);
		});
	});
	modal.openSource(
		{
			...audio,
			title: "Episode Two",
			url: "https://example.org/second",
		},
		back,
	);
	expect(modal.contentEl.querySelector("textarea")?.value).toBe("");
	await confirm();
	expect(taskSignal?.aborted).toBe(false);
	button("Cancel task").click();
	expect(taskSignal?.aborted).toBe(true);
	await vi.waitFor(() =>
		expect(
			modal.contentEl.querySelector('[role="status"]')?.textContent,
		).toContain("Episode Two · 已取消转录。"),
	);
	modal.close();
});

it("starts the cloud task with the selected Obsidian secret only after clicking the button", async () => {
	const cloud = vi
		.mocked(transcribeWithBailian)
		.mockReset()
		.mockResolvedValue({
			title: "Public episode",
			method: "bailian-transcription",
			text: "云端逐字稿",
		});
	const store = new MediaStore(
		{
			exists: async () => true,
			read: async () =>
				JSON.stringify({
					version: 1,
					subscriptions: [],
					bailianSecretId: "bailian-test",
				}),
			write: async () => {},
		},
		"media.json",
	);
	const modal = new MediaModal(
		new App(),
		{ agents: () => [], defaultAgentId: () => "", start: vi.fn() },
		store,
		new TranscriptionTask(),
		{ ffmpeg: "ffmpeg", whisper: "whisper", model: "model.bin" },
	);
	try {
		modal.openSource({
			url: "https://example.com/episode",
			title: "Public episode",
			audioUrl: "https://example.com/audio.mp3",
		});
		const button = Array.from(
			modal.contentEl.querySelectorAll("button"),
		).find((node) => node.textContent === "云端转录（百炼）");
		await vi.waitFor(() => expect(button?.hidden).toBe(false));
		expect(cloud).not.toHaveBeenCalled();
		button?.click();
		await vi.waitFor(() =>
			expect(modal.contentEl.querySelector("textarea")?.value).toContain(
				"云端逐字稿",
			),
		);
		expect(cloud).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				audioUrl: "https://example.com/audio.mp3",
			}),
			"test-key",
			expect.any(AbortSignal),
			expect.any(Function),
		);
	} finally {
		modal.close();
	}
});
