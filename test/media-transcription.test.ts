import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { transcribeAudio } from "../src/media/transcription";
import { runMediaTool } from "../src/media/media-tools";
import { materialMarkdown } from "../src/media/material";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

it("normalizes audio then returns original timestamped Whisper segments", async () => {
	const directory = await mkdtemp(join(tmpdir(), "media-test-"));
	directories.push(directory);
	const model = join(directory, "model.bin");
	await writeFile(model, "test model");
	const run = vi.fn(async (command: string, args: string[]) => {
		if (command === "whisper") {
			const output = args[args.indexOf("-of") + 1];
			await writeFile(
				output + ".json",
				JSON.stringify({
					result: { language: "zh" },
					transcription: [
						{ offsets: { from: 1234, to: 2789 }, text: " 你好 " },
						{ offsets: { from: 2789, to: 3000 }, text: " " },
					],
				}),
			);
		}
		return { stdout: "", stderr: "" };
	});
	const material = await transcribeAudio({
		path: join(directory, "input with spaces.webm"),
		title: "Recording",
		tools: { ffmpeg: "ffmpeg", whisper: "whisper", model },
		signal: new AbortController().signal,
		run,
	});
	expect(run.mock.calls[0][1]).toContain("16000");
	expect(run.mock.calls[1][1]).toContain("auto");
	expect(material).toMatchObject({
		method: "local-transcription",
		language: "zh",
		segments: [{ startMs: 1234, endMs: 2789, text: "你好" }],
	});
	expect(materialMarkdown(material)).toContain("[00:00:01.234] 你好");
});

it("reports a missing model before running an audio command", async () => {
	const run = vi.fn();
	await expect(
		transcribeAudio({
			path: "/audio.wav",
			title: "Audio",
			tools: { ffmpeg: "ffmpeg", whisper: "whisper", model: "" },
			signal: new AbortController().signal,
			run,
		}),
	).rejects.toThrow(/model/i);
	expect(run).not.toHaveBeenCalled();
});

it("cancels a downloader and the subprocess holding its output open", async () => {
	const directory = await mkdtemp(join(tmpdir(), "media-cancel-test-"));
	directories.push(directory);
	const ready = join(directory, "ready");
	const controller = new AbortController();
	const result = runMediaTool(
		process.execPath,
		[
			"-e",
			"require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {stdio: 'inherit'}); require('fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);",
			ready,
		],
		controller.signal,
		4_000,
	).catch((error: unknown) => error);
	try {
		await vi.waitFor(
			async () => expect(await readFile(ready, "utf8")).toBe("ready"),
			{ timeout: 2_000 },
		);
		const started = Date.now();
		controller.abort();
		expect(await result).toMatchObject({ message: "Operation cancelled." });
		expect(Date.now() - started).toBeLessThan(2_000);
	} finally {
		controller.abort();
		await result;
	}
});
