import { resolveMediaTool, runMediaTool, type RunTool } from "./media-tools";
import {
	siteIs,
	videoToolArgs,
	webUrl,
	type FetchSourceText,
	type SourceLink,
} from "./source-reader";

export interface FeedEntry extends SourceLink {
	id: string;
	title: string;
}
export interface SourceFeed {
	title: string;
	entries: FeedEntry[];
}

interface ReadFeedOptions {
	get: FetchSourceText;
	signal: AbortSignal;
	run?: RunTool;
}

function child(node: Element, name: string): Element | undefined {
	return Array.from(node.children).find(
		(element) => element.localName === name,
	);
}

function text(node: Element, name: string): string | undefined {
	return child(node, name)?.textContent?.trim() || undefined;
}

function optionalUrl(
	value: string | null | undefined,
	base: string,
): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		return webUrl(value, base).href;
	} catch {
		return undefined;
	}
}

function parseFeed(body: string, base: string): SourceFeed | undefined {
	const root = new DOMParser().parseFromString(
		body,
		"application/xml",
	).documentElement;
	const isAtom = root.localName === "feed";
	const channel = isAtom
		? root
		: root.localName === "rss"
			? child(root, "channel")
			: undefined;
	if (!channel) return undefined;
	const entries: FeedEntry[] = [];
	for (const entry of Array.from(channel.children)) {
		if (entry.localName !== (isAtom ? "entry" : "item")) continue;
		const links = Array.from(entry.children).filter(
			(element) => element.localName === "link",
		);
		const enclosure = isAtom
			? links.find((link) => link.getAttribute("rel") === "enclosure")
			: child(entry, "enclosure");
		const alternate = isAtom
			? links
					.find((link) =>
						[null, "alternate"].includes(link.getAttribute("rel")),
					)
					?.getAttribute("href")
			: text(entry, "link");
		const audioUrl = optionalUrl(
			enclosure?.getAttribute(isAtom ? "href" : "url"),
			base,
		);
		const transcript = child(entry, "transcript");
		const transcriptUrl = optionalUrl(
			transcript?.getAttribute("url"),
			base,
		);
		const url = optionalUrl(alternate, base) ?? audioUrl ?? transcriptUrl;
		if (!url) continue;
		entries.push({
			id: text(entry, isAtom ? "id" : "guid") || url,
			title: text(entry, "title") || url,
			url,
			audioUrl,
			transcriptUrl,
			transcriptType: transcript?.getAttribute("type") ?? undefined,
		});
	}
	return { title: text(channel, "title") || base, entries };
}

interface XiaoyuzhouEpisode {
	eid?: string;
	title?: string;
	enclosure?: { url?: string };
	isPrivateMedia?: boolean;
}

function xiaoyuzhouFeed(doc: Document, url: URL): SourceFeed {
	const raw = doc.querySelector("script#__NEXT_DATA__")?.textContent;
	if (!raw)
		throw new Error(
			"This Xiaoyuzhou page does not expose public episodes. Use its RSS feed if available.",
		);
	const { props } = JSON.parse(raw) as {
		props?: {
			pageProps?: {
				podcast?: { title?: string; episodes?: XiaoyuzhouEpisode[] };
			};
		};
	};
	const podcast = props?.pageProps?.podcast;
	if (!podcast?.episodes)
		throw new Error("Enter a Xiaoyuzhou podcast show URL.");
	return {
		title: podcast.title || url.href,
		entries: podcast.episodes.flatMap((episode) =>
			episode.eid
				? [
						{
							id: episode.eid,
							title: episode.title || episode.eid,
							url: new URL(
								"/episode/" + encodeURIComponent(episode.eid),
								url,
							).href,
							audioUrl: episode.isPrivateMedia
								? undefined
								: optionalUrl(episode.enclosure?.url, url.href),
						},
					]
				: [],
		),
	};
}

async function bilibiliFeed(
	mid: string,
	{ run = runMediaTool, signal }: ReadFeedOptions,
): Promise<SourceFeed> {
	const url = `https://space.bilibili.com/${mid}/video`;
	const { stdout } = await run(
		resolveMediaTool("yt-dlp"),
		[
			...videoToolArgs(),
			"--flat-playlist",
			"--playlist-end",
			"20",
			"--dump-single-json",
			"--",
			url,
		],
		signal,
		120_000,
	);
	const listing = JSON.parse(stdout) as {
		title?: string;
		entries?: Array<{ id?: string; title?: string; url?: string } | null>;
	};
	if (!listing.entries)
		throw new Error("Bilibili did not return a channel feed.");
	return {
		title: listing.title || url,
		entries: listing.entries.flatMap((entry) => {
			if (!entry?.id) return [];
			const link =
				optionalUrl(entry.url, url) ??
				`https://www.bilibili.com/video/${encodeURIComponent(entry.id)}`;
			return [
				{ id: entry.id, title: entry.title || entry.id, url: link },
			];
		}),
	};
}

async function requireXml(
	url: string,
	{ get, signal }: ReadFeedOptions,
): Promise<SourceFeed> {
	const raw = await get(url);
	signal.throwIfAborted();
	const feed = parseFeed(raw, url);
	if (!feed)
		throw new Error("The source did not return a valid RSS or Atom feed.");
	return feed;
}

export async function readFeed(
	input: string,
	options: ReadFeedOptions,
): Promise<SourceFeed> {
	const { get, signal } = options;
	signal.throwIfAborted();
	const url = webUrl(input);
	if (url.hostname === "space.bilibili.com") {
		const mid = url.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1];
		if (!mid) throw new Error("Enter a Bilibili creator space URL.");
		return bilibiliFeed(mid, options);
	}
	if (siteIs(url, "youtube.com") && url.pathname.startsWith("/channel/")) {
		const channel = url.pathname.split("/")[2];
		if (!/^UC[\w-]+$/.test(channel ?? ""))
			throw new Error("Enter a YouTube channel URL.");
		return requireXml(
			`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`,
			options,
		);
	}

	const raw = await get(url.href);
	signal.throwIfAborted();
	const xml = parseFeed(raw, url.href);
	if (xml) return xml;
	const html = new DOMParser().parseFromString(raw, "text/html");
	if (siteIs(url, "xiaoyuzhoufm.com")) return xiaoyuzhouFeed(html, url);
	const alternate = html.querySelector(
		'link[rel~="alternate"][type="application/rss+xml"],link[rel~="alternate"][type="application/atom+xml"]',
	);
	const feedUrl = optionalUrl(alternate?.getAttribute("href"), url.href);
	if (feedUrl) return requireXml(feedUrl, options);
	if (siteIs(url, "youtube.com")) {
		const channel =
			html
				.querySelector('meta[itemprop="channelId"]')
				?.getAttribute("content") ??
			raw.match(/"externalId"\s*:\s*"(UC[\w-]+)"/)?.[1];
		if (channel && /^UC[\w-]+$/.test(channel)) {
			return requireXml(
				`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`,
				options,
			);
		}
	}
	throw new Error(
		"No RSS or Atom feed found. Try the feed URL, a YouTube channel, a Bilibili space, or a Xiaoyuzhou show URL.",
	);
}
