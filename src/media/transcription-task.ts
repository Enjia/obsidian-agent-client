import { transcribeWithBailian } from "./bailian-transcription";
import type { Material } from "./material";
import type { SourceAudio } from "./source-reader";
import {
	transcribeBlob,
	transcribeSource,
	type TranscriptionTools,
} from "./transcription";

export type TranscriptionInput =
	| { kind: "source"; audio: SourceAudio }
	| { kind: "bailian"; audio: SourceAudio; apiKey: string }
	| { kind: "file"; file: Blob; title: string; extension: string };

interface TaskSource {
	title: string;
	source?: string;
	cloud?: true;
}

export type TranscriptionState = TaskSource &
	(
		| { phase: "running"; detail: string }
		| { phase: "ready"; material: Material }
		| { phase: "cancelled" | "failed"; detail: string }
	);

export class TranscriptionTask {
	private state?: TranscriptionState;
	private controller?: AbortController;
	private listeners = new Set<(state: TranscriptionState) => void>();

	get current(): TranscriptionState | undefined {
		return this.state;
	}

	subscribe(listener: (state: TranscriptionState) => void): () => void {
		this.listeners.add(listener);
		if (this.state) listener(this.state);
		return () => this.listeners.delete(listener);
	}

	start(input: TranscriptionInput, tools: TranscriptionTools): boolean {
		if (this.controller) return false;
		const target: TaskSource =
			input.kind === "file"
				? { title: input.title }
				: {
						title: input.audio.title,
						source: input.audio.source,
						cloud: input.kind === "bailian" ? true : undefined,
					};
		const controller = new AbortController();
		this.controller = controller;
		this.publish({ ...target, phase: "running", detail: "正在启动转录…" });
		void this.execute(input, target, controller.signal, { ...tools });
		return true;
	}

	cancel(): void {
		if (!this.controller || this.controller.signal.aborted) return;
		this.controller.abort();
		if (this.state?.phase === "running") {
			this.publish({ ...this.state, detail: "正在取消转录…" });
		}
	}

	private async execute(
		input: TranscriptionInput,
		target: TaskSource,
		signal: AbortSignal,
		tools: TranscriptionTools,
	): Promise<void> {
		let result: TranscriptionState;
		try {
			const options = {
				tools,
				signal,
				progress: (detail: string) => {
					if (!signal.aborted) {
						this.publish({ ...target, phase: "running", detail });
					}
				},
			};
			let material: Material;
			switch (input.kind) {
				case "bailian":
					material = await transcribeWithBailian(
						input.audio,
						input.apiKey,
						signal,
						options.progress,
					);
					break;
				case "source":
					material = await transcribeSource(input.audio, options);
					break;
				case "file":
					material = await transcribeBlob(
						input.file,
						input.title,
						input.extension,
						options,
					);
					break;
			}
			signal.throwIfAborted();
			result = { ...target, phase: "ready", material };
		} catch (error) {
			result = signal.aborted
				? {
						...target,
						phase: "cancelled",
						detail: target.cloud
							? "已停止查询。已提交的百炼任务可能继续执行并计费。"
							: "已取消转录。",
					}
				: {
						...target,
						phase: "failed",
						detail:
							error instanceof Error
								? error.message
								: String(error),
					};
		}
		this.controller = undefined;
		this.publish(result);
	}

	private publish(state: TranscriptionState): void {
		this.state = state;
		for (const listener of this.listeners) listener(state);
	}
}
