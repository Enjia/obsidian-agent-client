// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { readSource } from "../src/media/source-reader";
import { summaryPrompt } from "../src/media/material";

const signal = new AbortController().signal;
const cues = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n原始字幕\n";

it("preserves article title, source and separated paragraphs", async () => {
	const text =
		"This is the first full paragraph of a technical article describing how to identify the underlying source of an external document.";
	const next =
		"This is the second paragraph with enough detail about verifying the content and checking where the information comes from.";
	const material = await readSource(
		{ url: "https://example.org/article" },
		{
			signal,
			get: async () =>
				`<!doctype html><html><head><title>Source article</title></head><body><nav>Ignore menu</nav><article><p>${text}</p><p>${next}</p></article></body></html>`,
		},
	);
	expect(material).toMatchObject({
		title: "Source article",
		source: "https://example.org/article",
		method: "article",
	});
	expect(material.text).toContain(text + "\n\n" + next);
	expect(material.text).not.toContain("Ignore menu");
});

it("uses published podcast transcripts before opening media tools", async () => {
	const run = vi.fn();
	const material = await readSource(
		{
			url: "https://example.org/episode",
			title: "Episode",
			audioUrl: "https://example.org/episode.mp3",
			transcriptUrl: "https://example.org/episode.vtt",
		},
		{ signal, get: async () => cues, run },
	);
	expect(material).toMatchObject({
		method: "published-transcript",
		segments: [{ startMs: 1000, text: "原始字幕" }],
	});
	expect(run).not.toHaveBeenCalled();
});

it("chooses human captions before automatic captions and prefers the original language", async () => {
	const run = vi.fn(async () => ({
		stdout: JSON.stringify({
			title: "Video",
			language: "zh",
			subtitles: {
				en: [{ ext: "vtt", url: "https://example.org/en" }],
				zh: [{ ext: "vtt", url: "https://example.org/zh" }],
			},
			automatic_captions: {
				"zh-orig": [{ ext: "vtt", url: "https://example.org/auto" }],
			},
		}),
		stderr: "",
	}));
	const get = vi.fn(async () => cues);
	const material = await readSource(
		{ url: "https://www.youtube.com/watch?v=example" },
		{ signal, get, run },
	);
	expect(get.mock.calls[0][0]).toBe("https://example.org/zh");
	expect(material).toMatchObject({
		method: "human-captions",
		language: "zh",
	});
	expect(run).toHaveBeenCalledTimes(1);
	expect(run).toHaveBeenCalledWith(
		expect.any(String),
		expect.arrayContaining([
			"--skip-download",
			"--write-subs",
			"--write-auto-subs",
		]),
		signal,
		expect.any(Number),
	);
});

it("surfaces a caption fetch failure without triggering a full download", async () => {
	const run = vi.fn(async () => ({
		stdout: JSON.stringify({
			title: "Video",
			subtitles: { en: [{ ext: "vtt", url: "https://example.org/en" }] },
		}),
		stderr: "",
	}));
	await expect(
		readSource(
			{ url: "https://www.youtube.com/watch?v=example" },
			{
				signal,
				run,
				get: async () => {
					throw new Error("HTTP 429");
				},
			},
		),
	).rejects.toThrow("HTTP 429");
	expect(run).toHaveBeenCalledTimes(1);
});

it("includes full timestamped evidence in an explicit summary prompt", () => {
	const prompt = summaryPrompt({
		title: "Clip",
		method: "human-captions",
		source: "https://example.org/clip",
		segments: [{ startMs: 5200, endMs: 6200, text: "Last sentence." }],
	});
	expect(prompt).toContain("[00:00:05.200] Last sentence.");
	expect(prompt).toContain("https://example.org/clip");
	expect(prompt).toContain("untrusted source material");
});

it("prefers real Bilibili subtitles over ai-prefixed machine captions", async () => {
	const run = vi.fn(async () => ({
		stdout: JSON.stringify({
			title: "Video",
			language: "zh",
			subtitles: {
				"ai-zh": [
					{
						ext: "srt",
						data: "1\n00:00:01,000 --> 00:00:03,000\n自动字幕",
					},
				],
				ja: [
					{
						ext: "srt",
						data: "1\n00:00:01,000 --> 00:00:03,000\n字幕",
					},
				],
			},
		}),
		stderr: "",
	}));
	const material = await readSource(
		{ url: "https://www.bilibili.com/video/BV1234" },
		{ signal, get: vi.fn(), run },
	);
	expect(material).toMatchObject({
		method: "human-captions",
		language: "ja",
		segments: [{ text: "字幕" }],
	});
});

it("labels an ai-prefixed Bilibili track as automatic", async () => {
	const run = vi.fn(async () => ({
		stdout: JSON.stringify({
			title: "Video",
			subtitles: {
				"ai-zh": [
					{
						ext: "srt",
						data: "1\n00:00:01,000 --> 00:00:03,000\n自动字幕",
					},
				],
			},
		}),
		stderr: "",
	}));
	const material = await readSource(
		{ url: "https://www.bilibili.com/video/BV1234" },
		{ signal, get: vi.fn(), run },
	);
	expect(material).toMatchObject({
		method: "automatic-captions",
		language: "zh",
	});
});
