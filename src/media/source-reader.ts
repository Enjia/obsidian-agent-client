import { Readability } from "@mozilla/readability";
import { join } from "path";
import { parseCaptionSegments, plainCaptionText } from "./captions";
import type { Material } from "./material";
import {
	resolveMediaTool,
	runMediaTool,
	withMediaDirectory,
	type RunTool,
} from "./media-tools";
import {
	defaultTranscriptionTools,
	transcribeAudio,
	type TranscriptionTools,
} from "./transcription";

export interface SourceLink {
	url: string;
	title?: string;
	audioUrl?: string;
	transcriptUrl?: string;
	transcriptType?: string;
}

export type FetchSourceText = (
	url: string,
	headers?: Record<string, string>,
) => Promise<string>;

interface ReadOptions {
	get: FetchSourceText;
	signal: AbortSignal;
	tools?: TranscriptionTools;
	run?: RunTool;
	progress?: (status: string) => void;
}

export function webUrl(input: string, base?: string): URL {
	const url = new URL(input.trim(), base);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	) {
		throw new Error("Enter a public HTTP or HTTPS URL.");
	}
	return url;
}

export function siteIs(url: URL, domain: string): boolean {
	return url.hostname === domain || url.hostname.endsWith("." + domain);
}

export function videoToolArgs(): string[] {
	return ["--ignore-config", "--js-runtimes", "node", "--no-warnings"];
}

function isVideoLink(url: URL): boolean {
	return [
		"youtube.com",
		"youtu.be",
		"bilibili.com",
		"b23.tv",
		"vimeo.com",
	].some((domain) => siteIs(url, domain));
}

export function isMediaFile(url: URL): boolean {
	return /\.(mp3|m4a|aac|ogg|opus|wav|flac|mp4|webm|m4v|mov|m3u8)$/i.test(
		url.pathname,
	);
}

interface CaptionTrack {
	url?: string;
	ext?: string;
	data?: string;
}
interface VideoMetadata {
	title?: string;
	language?: string;
	subtitles?: Record<string, CaptionTrack[]>;
	automatic_captions?: Record<string, CaptionTrack[]>;
	http_headers?: Record<string, string>;
}

function captionTrack(
	tracks: Record<string, CaptionTrack[]> | undefined,
	language?: string,
) {
	const formats = ["json3", "vtt", "srt", "json"];
	const rank = (lang: string) => {
		const code = lang.replace(/-orig$/i, "").toLowerCase();
		const preferred = language?.toLowerCase();
		if (/-orig$/i.test(lang)) return 0;
		if (code === preferred) return 1;
		if (preferred && code.split("-")[0] === preferred.split("-")[0])
			return 2;
		if (/^(zh|en)(-|$)/.test(code)) return 3;
		return 4;
	};
	const languages = Object.keys(tracks ?? {}).filter(
		(lang) => lang !== "live_chat",
	);
	languages.sort((a, b) => rank(a) - rank(b));
	for (const lang of languages) {
		const variants = tracks?.[lang] ?? [];
		for (const ext of formats) {
			const track = variants.find(
				(variant) =>
					variant.ext === ext && (variant.url || variant.data),
			);
			if (track) return { track, language: lang.replace(/-orig$/i, "") };
		}
	}
	return undefined;
}

function article(doc: Document, url: string): Material {
	const base = doc.createElement("base");
	base.href = url;
	doc.head.prepend(base);
	const data = new Readability(doc).parse();
	const parsed =
		data?.content &&
		new DOMParser().parseFromString(data.content, "text/html");
	const paragraphs = parsed
		? Array.from(parsed.querySelectorAll("p,li,h1,h2,h3,h4,pre,blockquote"))
				.filter(
					(node) =>
						!node.querySelector("p,li,h1,h2,h3,h4,pre,blockquote"),
				)
				.map((node) => node.textContent?.trim())
				.filter(Boolean)
		: [];
	const text = paragraphs.length
		? paragraphs.join("\n\n")
		: data?.textContent?.trim();
	if (!data || !text) throw new Error("No readable article text found.");
	return {
		title: data.title || url,
		source: url,
		method: "article",
		text,
		language: data.lang ?? undefined,
	};
}

async function downloadAndTranscribe(
	audioUrl: string,
	source: string,
	title: string,
	{
		signal,
		run = runMediaTool,
		tools = defaultTranscriptionTools(),
		progress,
	}: ReadOptions,
): Promise<Material> {
	return withMediaDirectory(async (directory) => {
		progress?.("Downloading audio…");
		const { stdout } = await run(
			resolveMediaTool("yt-dlp"),
			[
				...videoToolArgs(),
				"--no-playlist",
				"--no-progress",
				"--no-simulate",
				"-f",
				"bestaudio/best",
				"--print",
				"after_move:filepath",
				"-o",
				join(directory, "audio.%(ext)s"),
				"--",
				audioUrl,
			],
			signal,
			30 * 60_000,
		);
		const path = stdout.trim().split(/\r?\n/).pop();
		if (!path)
			throw new Error("The downloader did not return an audio file.");
		const material = await transcribeAudio({
			path,
			title,
			tools,
			signal,
			run,
			progress,
		});
		return { ...material, source };
	});
}

export async function readSource(
	link: SourceLink,
	options: ReadOptions,
): Promise<Material> {
	const { signal, get, run = runMediaTool, progress } = options;
	signal.throwIfAborted();
	const url = webUrl(link.url);
	const source = url.href;
	const title = link.title || source;

	if (link.transcriptUrl) {
		progress?.("Fetching published transcript…");
		const transcriptUrl = webUrl(link.transcriptUrl, source);
		const raw = await get(transcriptUrl.href);
		signal.throwIfAborted();
		const format =
			link.transcriptType ||
			transcriptUrl.pathname.split(".").pop() ||
			"";
		const segments = parseCaptionSegments(raw, format);
		if (segments.length)
			return { title, source, method: "published-transcript", segments };
		const text = plainCaptionText(raw, format);
		if (!text)
			throw new Error("The published transcript is empty or unreadable.");
		return { title, source, method: "published-transcript", text };
	}

	if (link.audioUrl || isMediaFile(url)) {
		return downloadAndTranscribe(
			webUrl(link.audioUrl || source, source).href,
			source,
			title,
			options,
		);
	}

	if (isVideoLink(url)) {
		progress?.("Checking available captions…");
		const { stdout } = await run(
			resolveMediaTool("yt-dlp"),
			[
				...videoToolArgs(),
				"--no-playlist",
				"--skip-download",
				"--write-subs",
				"--write-auto-subs",
				"--dump-single-json",
				"--",
				source,
			],
			signal,
			120_000,
		);
		const data = JSON.parse(stdout) as VideoMetadata;
		const humanTracks: Record<string, CaptionTrack[]> = {};
		const automaticTracks = { ...data.automatic_captions };
		const isBilibili = siteIs(url, "bilibili.com") || siteIs(url, "b23.tv");
		for (const [language, tracks] of Object.entries(data.subtitles ?? {})) {
			if (isBilibili && language.startsWith("ai-")) {
				automaticTracks[language.slice(3)] = tracks;
			} else {
				humanTracks[language] = tracks;
			}
		}
		const human = captionTrack(humanTracks, data.language);
		const caption = human ?? captionTrack(automaticTracks, data.language);
		if (caption) {
			const { track, language } = caption;
			const raw =
				track.data ??
				(await get(
					webUrl(track.url || "", source).href,
					data.http_headers,
				));
			signal.throwIfAborted();
			const segments = parseCaptionSegments(raw, track.ext ?? "");
			if (!segments.length)
				throw new Error(
					"The available caption track is empty or unreadable.",
				);
			return {
				title: data.title || title,
				source,
				method: human ? "human-captions" : "automatic-captions",
				language,
				segments,
			};
		}
		return downloadAndTranscribe(
			source,
			source,
			data.title || title,
			options,
		);
	}

	progress?.("Reading source page…");
	const html = await get(source);
	signal.throwIfAborted();
	const doc = new DOMParser().parseFromString(html, "text/html");
	const episodeAudio = doc
		.querySelector(
			'meta[property="og:audio"],meta[property="og:audio:url"]',
		)
		?.getAttribute("content");
	if (episodeAudio) {
		return downloadAndTranscribe(
			webUrl(episodeAudio, source).href,
			source,
			doc
				.querySelector('meta[property="og:title"]')
				?.getAttribute("content") ||
				doc.title ||
				title,
			options,
		);
	}
	if (
		siteIs(url, "xiaoyuzhoufm.com") &&
		url.pathname.startsWith("/episode/")
	) {
		throw new Error(
			"This Xiaoyuzhou episode did not publish a readable audio URL. Use its RSS entry or a local audio file.",
		);
	}
	return article(doc, source);
}
