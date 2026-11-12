import {
	requireXml,
	type FeedEntry,
	type FeedHistory,
	type ReadFeedOptions,
	type SourceFeed,
} from "./feed-reader";
import { webUrl } from "./source-reader";

function episodePath(link: string): string {
	const url = webUrl(link);
	return url.origin + url.pathname;
}

async function xiaoyuzhouArchive(
	title: string,
	known: FeedEntry[],
	options: ReadFeedOptions,
): Promise<SourceFeed> {
	const search = new URL("https://itunes.apple.com/search");
	search.search = new URLSearchParams({
		term: title,
		media: "podcast",
		entity: "podcast",
		country: "cn",
		limit: "8",
	}).toString();
	const raw = await options.get(search.href, { Accept: "application/json" });
	options.signal.throwIfAborted();
	const { results } = JSON.parse(raw) as {
		results?: Array<{ collectionName?: string; feedUrl?: string }>;
	};
	const knownEpisodes = new Map(
		known.map((entry) => [entry.id, episodePath(entry.url)]),
	);
	for (const row of results ?? []) {
		if (
			!row.feedUrl ||
			row.collectionName?.trim().normalize("NFKC") !==
				title.trim().normalize("NFKC")
		)
			continue;
		let feed: SourceFeed;
		try {
			feed = await requireXml(webUrl(row.feedUrl).href, options);
		} catch {
			options.signal.throwIfAborted();
			continue;
		}
		const firstKnown = feed.entries.findIndex(
			(entry) => knownEpisodes.get(entry.id) === episodePath(entry.url),
		);
		if (firstKnown >= 0)
			return { ...feed, entries: feed.entries.slice(firstKnown) };
	}
	throw new Error(
		"未找到能与该节目核对的公开历史 RSS。可直接添加节目发布者提供的 RSS 链接。",
	);
}

async function wordpressArchive(
	history: Extract<FeedHistory, { kind: "wordpress" }>,
	known: FeedEntry[],
	{ get, signal }: ReadFeedOptions,
): Promise<SourceFeed> {
	const address = webUrl(history.url);
	address.searchParams.set("per_page", "40");
	address.searchParams.set("page", String(history.page));
	address.searchParams.set("_fields", "id,link,title");
	address.searchParams.set("_envelope", "1");
	const raw = await get(address.href, { Accept: "application/json" });
	signal.throwIfAborted();
	const data = JSON.parse(raw) as {
		status: number;
		headers?: Record<string, number | string>;
		body?:
			| Array<{ id: number; link: string; title?: { rendered?: string } }>
			| { code?: string };
	};
	if (
		data.status === 400 &&
		!Array.isArray(data.body) &&
		data.body?.code === "rest_post_invalid_page_number"
	) {
		return { title: "", entries: [] };
	}
	if (data.status !== 200 || !Array.isArray(data.body)) {
		throw new Error(`该博客未返回可读的公开归档（HTTP ${data.status}）。`);
	}
	const total = Object.entries(data.headers ?? {}).find(
		([name]) => name.toLowerCase() === "x-wp-totalpages",
	)?.[1];
	const entries = data.body.map((post) => ({
		id: "wp:" + post.id,
		url: webUrl(post.link).href,
		title:
			new DOMParser()
				.parseFromString(post.title?.rendered ?? "", "text/html")
				.body.textContent?.trim() || post.link,
	}));
	const seekKnown = Boolean(
		known.length && (history.page === 1 || history.seekKnown),
	);
	const knownLinks = new Set(known.map(({ url }) => url));
	const start = seekKnown
		? entries.findIndex(({ url }) => knownLinks.has(url))
		: 0;
	return {
		title: "",
		entries: start < 0 ? [] : entries.slice(start),
		history:
			history.page < Number(total)
				? { ...history, page: history.page + 1, seekKnown: start < 0 }
				: undefined,
	};
}

export async function readFeedHistory(
	history: FeedHistory,
	known: FeedEntry[],
	options: ReadFeedOptions,
): Promise<SourceFeed> {
	options.signal.throwIfAborted();
	switch (history.kind) {
		case "feed":
			return requireXml(history.url, options);
		case "wordpress":
			return wordpressArchive(history, known, options);
		case "xiaoyuzhou":
			return xiaoyuzhouArchive(history.title, known, options);
	}
}
