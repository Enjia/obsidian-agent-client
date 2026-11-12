import { readFile, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { Material, TranscriptSegment } from "./material";
import {
	resolveMediaTool,
	runMediaTool,
	withMediaDirectory,
	type RunTool,
} from "./media-tools";

export interface TranscriptionTools {
	ffmpeg: string;
	whisper: string;
	model: string;
}

export function defaultTranscriptionTools(): TranscriptionTools {
	return {
		ffmpeg: resolveMediaTool("ffmpeg"),
		whisper: resolveMediaTool("whisper-cli"),
		model: join(homedir(), ".cache", "whisper.cpp", "ggml-small-q5_1.bin"),
	};
}

interface WhisperOutput {
	result?: { language?: string };
	transcription?: Array<{
		offsets?: { from?: number; to?: number };
		text?: string;
	}>;
}

export async function transcribeAudio({
	path,
	title,
	tools,
	signal,
	run = runMediaTool,
	progress,
}: {
	path: string;
	title: string;
	tools: TranscriptionTools;
	signal: AbortSignal;
	run?: RunTool;
	progress?: (status: string) => void;
}): Promise<Material> {
	signal.throwIfAborted();
	if (
		!tools.model ||
		!(await stat(tools.model).catch(() => undefined))?.isFile()
	) {
		throw new Error(
			"Whisper model file not found. Select a downloaded multilingual model.",
		);
	}
	return withMediaDirectory(async (directory) => {
		const wav = join(directory, "audio.wav");
		const output = join(directory, "transcript");
		progress?.("Preparing audio…");
		await run(
			tools.ffmpeg,
			[
				"-nostdin",
				"-v",
				"error",
				"-i",
				path,
				"-vn",
				"-ar",
				"16000",
				"-ac",
				"1",
				"-c:a",
				"pcm_s16le",
				wav,
			],
			signal,
			30 * 60_000,
		);
		progress?.("Transcribing locally…");
		await run(
			tools.whisper,
			["-m", tools.model, "-f", wav, "-l", "auto", "-oj", "-of", output],
			signal,
			4 * 60 * 60_000,
		);
		signal.throwIfAborted();
		const result = JSON.parse(
			await readFile(output + ".json", "utf8"),
		) as WhisperOutput;
		const segments: TranscriptSegment[] = [];
		for (const row of result.transcription ?? []) {
			const text = row.text?.trim();
			if (!text) continue;
			const startMs = row.offsets?.from;
			const endMs = row.offsets?.to;
			if (
				typeof startMs !== "number" ||
				typeof endMs !== "number" ||
				!Number.isFinite(startMs) ||
				!Number.isFinite(endMs) ||
				startMs < 0 ||
				endMs < startMs
			) {
				throw new Error("Whisper returned invalid segment timestamps.");
			}
			segments.push({ startMs, endMs, text });
		}
		if (!segments.length)
			throw new Error("Whisper returned an empty transcript.");
		return {
			title,
			method: "local-transcription",
			language: result.result?.language,
			segments,
		};
	});
}
