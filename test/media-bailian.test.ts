import { requestUrl } from "obsidian";
import { expect, it, vi } from "vitest";
import { transcribeWithBailian } from "../src/media/bailian-transcription";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
vi.mock("timers/promises", () => ({
	setTimeout: (
		ms: number,
		_value: undefined,
		{ signal }: { signal: AbortSignal },
	) =>
		ms === 5_000
			? Promise.resolve()
			: new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(new Error("Aborted")),
					);
				}),
}));

const audio = {
	title: "Episode",
	source: "https://example.com/episode",
	audioUrl: "https://example.com/audio.mp3",
};

it("submits the audio URL, polls the job and keeps the API key off the result request", async () => {
	const mock = vi.mocked(requestUrl).mockReset();
	const resultUrl = "https://example.net/transcript.json?signature=example";
	const reply = (body: unknown) => ({
		status: 200,
		text: JSON.stringify(body),
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json: body,
	});
	mock.mockResolvedValueOnce(reply({ output: { task_id: "task" } }))
		.mockResolvedValueOnce(reply({ output: { task_status: "RUNNING" } }))
		.mockResolvedValueOnce(
			reply({
				output: {
					task_status: "SUCCEEDED",
					results: [
						{
							subtask_status: "SUCCEEDED",
							transcription_url: resultUrl,
						},
					],
				},
			}),
		)
		.mockResolvedValueOnce(
			reply({
				transcripts: [
					{
						sentences: [
							{ begin_time: 100, end_time: 1500, text: " 你好 " },
						],
					},
				],
			}),
		);
	const progress = vi.fn();
	const result = await transcribeWithBailian(
		audio,
		"test-key",
		new AbortController().signal,
		progress,
	);
	expect(result).toEqual({
		title: "Episode",
		source: audio.source,
		method: "bailian-transcription",
		segments: [{ startMs: 100, endMs: 1500, text: "你好" }],
	});
	expect(mock).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({
			method: "POST",
			body: JSON.stringify({
				model: "paraformer-v2",
				input: { file_urls: [audio.audioUrl] },
			}),
		}),
	);
	expect(mock).toHaveBeenNthCalledWith(4, { url: resultUrl, throw: false });
	expect(progress).toHaveBeenCalledWith("百炼正在转录…");
});

it("does not submit a video page as a direct audio URL", async () => {
	const mock = vi.mocked(requestUrl).mockReset();
	await expect(
		transcribeWithBailian(
			{ ...audio, requiresDownload: true },
			"test-key",
			new AbortController().signal,
			vi.fn(),
		),
	).rejects.toThrow("公开音频直链");
	expect(mock).not.toHaveBeenCalled();
});
