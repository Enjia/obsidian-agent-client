// @vitest-environment jsdom
import { App } from "obsidian";
import { expect, it, vi } from "vitest";
import { MediaModal } from "../src/media/MediaModal";
import { MediaStore } from "../src/media/media-store";
import { transcribeSource } from "../src/media/source-reader";

vi.mock("../src/media/source-reader", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/media/source-reader")>()),
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
		App: class {},
		Modal: class {
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

it("waits for manual confirmation, cancels on return and clears the old preview for the next episode", async () => {
	const store = new MediaStore(
		{
			exists: async () => false,
			read: async () => "",
			write: async () => {},
		},
		"media.json",
	);
	const modal = new MediaModal(
		new App(),
		{ agents: () => [], defaultAgentId: () => "", start: vi.fn() },
		store,
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
	button("← 返回订阅").click();
	expect(back).toHaveBeenCalledOnce();
	expect(transcribe).not.toHaveBeenCalled();

	transcribe.mockResolvedValueOnce({
		title: audio.title,
		method: "local-transcription",
		text: "First transcript",
	});
	modal.openSource(audio, back);
	await confirm();
	await vi.waitFor(() =>
		expect(modal.contentEl.querySelector("textarea")?.value).toContain(
			"First transcript",
		),
	);
	expect(transcribe).toHaveBeenCalledOnce();
	modal.close();

	let taskSignal: AbortSignal | undefined;
	transcribe.mockImplementationOnce((_audio, { signal }) => {
		taskSignal = signal;
		return new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () =>
				reject(new Error("Cancelled")),
			);
		});
	});
	modal.openSource({ ...audio, title: "Episode Two" }, back);
	expect(modal.contentEl.querySelector("textarea")?.value).toBe("");
	await confirm();
	expect(taskSignal?.aborted).toBe(false);
	button("← 返回订阅").click();
	expect(taskSignal?.aborted).toBe(true);
	expect(back).toHaveBeenCalledTimes(2);
});
