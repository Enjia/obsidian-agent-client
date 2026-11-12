// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { readFeed } from "../src/media/feed-reader";
import { readFeedHistory } from "../src/media/feed-history";
import { MediaStore } from "../src/media/media-store";

const rss = `<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>Test podcast</title>
<item><guid>one</guid><title>Episode 1</title><link>https://example.org/episode</link>
<enclosure url="https://example.org/episode.mp3" type="audio/mpeg"/>
<podcast:transcript url="https://example.org/transcript.vtt" type="text/vtt"/>
</item></channel></rss>`;
const url = "https://example.org/feed.xml";

function storeFixture() {
	let data: string | undefined;
	const adapter = {
		exists: async () => data !== undefined,
		read: async () => data ?? "",
		write: vi.fn(async (_path: string, value: string) => {
			data = value;
		}),
	};
	return { adapter, create: () => new MediaStore(adapter, "media.json") };
}

it("preserves RSS podcast audio and published transcript references", async () => {
	const feed = await readFeed(url, {
		get: async () => rss,
		signal: new AbortController().signal,
	});
	expect(feed).toEqual({
		title: "Test podcast",
		entries: [
			{
				id: "one",
				title: "Episode 1",
				url: "https://example.org/episode",
				audioUrl: "https://example.org/episode.mp3",
				transcriptUrl: "https://example.org/transcript.vtt",
				transcriptType: "text/vtt",
			},
		],
	});
});

it("opens Atom entries and resolves relative links", async () => {
	const feed = await readFeed(url, {
		get: async () =>
			'<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><entry><id>urn:item:2</id><title>New post</title><link href="/post" rel="alternate"/></entry></feed>',
		signal: new AbortController().signal,
	});
	expect(feed.entries).toEqual([
		{
			id: "urn:item:2",
			title: "New post",
			url: "https://example.org/post",
		},
	]);
});

it("reports only newly observed entries, including after restart", async () => {
	const { create } = storeFixture();
	const store = create();
	const first = { id: "1", title: "First", url: "https://example.org/1" };
	const second = { id: "2", title: "Second", url: "https://example.org/2" };
	expect(
		await store.updateFeed(url, { title: "Blog", entries: [first] }),
	).toEqual([]);
	expect(
		await store.updateFeed(url, {
			title: "Blog",
			entries: [second, first, second],
		}),
	).toEqual([second]);
	const restarted = create();
	expect(
		await restarted.updateFeed(url, {
			title: "Blog",
			entries: [first, second],
		}),
	).toEqual([]);
	expect((await restarted.read()).subscriptions[0].entries).toHaveLength(2);
});

it("imports legacy subscriptions once and keeps an intentional deletion", async () => {
	const { create } = storeFixture();
	const old = {
		blogTracking: {
			subscriptions: [
				{
					url: "https://example.org",
					feedUrl: url,
					title: "My blog",
				},
			],
		},
		youtubeTracking: {
			subscriptions: [
				{
					url: "https://www.youtube.com/@Example",
					title: "Videos",
				},
			],
		},
		microPodcastTracking: {
			subscriptions: [
				{
					url: "https://www.xiaoyuzhoufm.com/podcast/abc",
					title: "Pod",
				},
			],
		},
	};
	const store = create();
	await store.importLegacy(old);
	expect((await store.read()).subscriptions.map(({ url }) => url)).toEqual([
		url,
		"https://www.youtube.com/@Example",
		"https://www.xiaoyuzhoufm.com/podcast/abc",
	]);
	await store.updateFeed(url, { title: "Public feed name", entries: [] });
	expect((await store.read()).subscriptions[0].title).toBe("My blog");
	await store.remove(url);
	const restarted = create();
	await restarted.importLegacy(old);
	expect((await restarted.read()).subscriptions).toHaveLength(2);
});

it("counts the first entry from a previously empty feed", async () => {
	const store = storeFixture().create();
	await store.updateFeed(url, { title: "New feed", entries: [] });
	expect(
		await store.updateFeed(url, {
			title: "New feed",
			entries: [
				{
					id: "1",
					title: "First post",
					url: "https://example.org/first",
				},
			],
		}),
	).toMatchObject([{ id: "1" }]);
});

it("resolves a YouTube handle through the published channel feed", async () => {
	const get = vi.fn(async (address: string) =>
		address.includes("/feeds/")
			? '<feed xmlns="http://www.w3.org/2005/Atom"><title>Channel</title><entry><id>yt:video:One</id><title>Video</title><link href="https://www.youtube.com/watch?v=One"/></entry></feed>'
			: '<meta itemprop="channelId" content="UC-example">',
	);
	const feed = await readFeed("https://www.youtube.com/@example", {
		get,
		signal: new AbortController().signal,
	});
	expect(get.mock.calls[1][0]).toContain("channel_id=UC-example");
	expect(feed.entries[0]).toMatchObject({
		id: "yt:video:One",
		url: "https://www.youtube.com/watch?v=One",
	});
});

it("normalizes public Bilibili creator videos from the playlist extractor", async () => {
	const run = vi.fn(async () => ({
		stdout: JSON.stringify({
			entries: [{ id: "BV123" }],
		}),
		stderr: "",
	}));
	const get = vi.fn(
		async (_address: string, _headers?: Record<string, string>) =>
			'{"data":{"title":"Video","owner":{"name":"Creator"}}}',
	);
	const feed = await readFeed("https://space.bilibili.com/42", {
		get,
		run,
		signal: new AbortController().signal,
	});
	expect(get.mock.calls[0]?.[0]).toBe(
		"https://api.bilibili.com/x/web-interface/view?bvid=BV123",
	);
	expect(get.mock.calls[0]?.[1]?.["User-Agent"]).toContain("Chrome/");
	expect(feed.title).toBe("Creator");
	expect(feed.entries[0]).toEqual({
		id: "BV123",
		title: "Video",
		url: "https://www.bilibili.com/video/BV123",
	});
});

it("reads Xiaoyuzhou episodes and their public audio enclosure", async () => {
	const feed = await readFeed("https://www.xiaoyuzhoufm.com/podcast/show", {
		get: async () =>
			'<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"podcast":{"title":"Show","episodes":[{"eid":"e1","title":"Episode","enclosure":{"url":"https://example.org/audio.mp3"}}]}}}}</script>',
		signal: new AbortController().signal,
	});
	expect(feed.entries[0]).toMatchObject({
		id: "e1",
		url: "https://www.xiaoyuzhoufm.com/episode/e1",
		audioUrl: "https://example.org/audio.mp3",
	});
});

it("keeps blog thumbnail enclosures out of the media path", async () => {
	const feed = await readFeed(url, {
		get: async () =>
			rss
				.replace('type="audio/mpeg"', 'type="image/jpeg"')
				.replace("episode.mp3", "cover.jpg")
				.replace(/<podcast:transcript[^>]+\/>/, ""),
		signal: new AbortController().signal,
	});
	expect(feed.entries[0].audioUrl).toBeUndefined();
	expect(feed.entries[0].url).toBe("https://example.org/episode");
});

it("resolves an Apple Podcasts episode link to its show's public RSS", async () => {
	const get = vi.fn(async (address: string) =>
		address.startsWith("https://itunes.apple.com/lookup")
			? JSON.stringify({ results: [{ feedUrl: url }] })
			: rss,
	);
	const signal = new AbortController().signal;
	const feed = await readFeed(
		"https://podcasts.apple.com/gb/podcast/example-show/id12345?i=99999",
		{ get, signal },
	);
	const lookup = new URL(get.mock.calls[0][0]);
	expect(lookup.origin + lookup.pathname).toBe(
		"https://itunes.apple.com/lookup",
	);
	expect(lookup.searchParams.get("id")).toBe("12345");
	expect(lookup.searchParams.get("country")).toBe("gb");
	expect(get.mock.calls[1][0]).toBe(url);
	expect(feed.entries[0]).toMatchObject({
		title: "Episode 1",
		audioUrl: "https://example.org/episode.mp3",
		transcriptUrl: "https://example.org/transcript.vtt",
	});
});

it("explains when Apple Podcasts has no public feed", async () => {
	const get = vi.fn(async () => '{"results":[]}');
	await expect(
		readFeed("https://podcasts.apple.com/us/podcast/example/id12345", {
			get,
			signal: new AbortController().signal,
		}),
	).rejects.toThrow("没有找到公开 RSS");
	expect(get).toHaveBeenCalledOnce();
});

it("follows an explicit relative Atom next page", async () => {
	const get = vi.fn(async (address: string) =>
		address.endsWith("?page=2")
			? rss
			: '<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><link rel="next" href="?page=2"/></feed>',
	);
	const options = { get, signal: new AbortController().signal };
	const first = await readFeed(url, options);
	expect(first.history).toEqual({ kind: "feed", url: url + "?page=2" });
	if (!first.history) throw new Error("Missing next page");
	const older = await readFeedHistory(first.history, first.entries, options);
	expect(older.entries[0].title).toBe("Episode 1");
});

it("matches a Xiaoyuzhou show to its public RSS using a known episode", async () => {
	const show = "https://www.xiaoyuzhoufm.com/podcast/abc";
	const recent = {
		id: "one",
		url: "https://www.xiaoyuzhoufm.com/episode/one",
		title: "Recent",
	};
	const archive = rss
		.replace(
			"<item>",
			"<item><guid>newer</guid><title>Newer episode</title><link>https://www.xiaoyuzhoufm.com/episode/newer</link></item><item>",
		)
		.replace("https://example.org/episode</link>", recent.url + "</link>");
	const get = vi.fn(async (address: string) => {
		if (address.startsWith("https://itunes.apple.com/search")) {
			return JSON.stringify({
				results: [
					{
						collectionName: "Podcast",
						feedUrl: "https://example.org/unrelated.xml",
					},
					{ collectionName: "Podcast", feedUrl: url },
				],
			});
		}
		return address === url ? archive : rss;
	});
	const result = await readFeedHistory(
		{ kind: "xiaoyuzhou", url: show, title: "Podcast" },
		[recent],
		{
			get,
			signal: new AbortController().signal,
		},
	);
	expect(result.entries.map((entry) => entry.url)).toEqual([recent.url]);
	expect(result.entries[0].transcriptUrl).toBe(
		"https://example.org/transcript.vtt",
	);
});

it("uses a WordPress site's public posts API for older blog entries", async () => {
	const blog = "https://example.org/en/feed/";
	const signal = new AbortController().signal;
	const get = vi.fn(async (address: string) => {
		if (address === blog)
			return `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
				<title>Blog</title><atom:link rel="self" href="${blog}" />
				<link>https://example.org/en/</link><generator>https://wordpress.org/?v=6</generator>
			</channel></rss>`;
		return JSON.stringify({
			status: 200,
			headers: { "X-WP-TotalPages": 3 },
			body: [
				{
					id: 12,
					link: "https://example.org/en/old/",
					title: { rendered: "Past &amp; present" },
				},
			],
		});
	});
	const first = await readFeed(blog, { get, signal });
	expect(first.history).toEqual({
		kind: "wordpress",
		url: "https://example.org/en/wp-json/wp/v2/posts",
		page: 1,
	});
	if (!first.history) throw new Error("Missing WordPress archive");
	const older = await readFeedHistory(first.history, first.entries, {
		get,
		signal,
	});
	expect(older.entries[0]).toMatchObject({ title: "Past & present" });
	expect(older.history).toMatchObject({ page: 2 });
});

it.each(["/?feed=rss2&cat=123", "/?feed=rss2&tag=foo", "/category/news/feed/"])(
	"does not use the entire WordPress site history for a filtered feed at %s",
	async (path) => {
		const get = vi.fn(
			async () =>
				'<rss version="2.0"><channel><title>Blog</title><link>https://example.org/</link><generator>https://wordpress.org/?v=6</generator></channel></rss>',
		);
		const feed = await readFeed("https://example.org" + path, {
			get,
			signal: new AbortController().signal,
		});
		expect(feed.history).toBeUndefined();
	},
);

it("retains loaded history across refresh and never counts overlapping history as new", async () => {
	const store = storeFixture().create();
	const head = {
		id: "newest",
		title: "Newest",
		url: "https://example.org/1",
	};
	const old = { id: "wp:2", title: "Old", url: "https://example.org/2" };
	await store.updateFeed(url, {
		title: "Blog",
		entries: [head],
		history: { kind: "feed", url: url + "?page=2" },
	});
	expect(
		await store.appendHistory(url, { title: "Blog", entries: [head, old] }),
	).toEqual([old]);
	expect(
		await store.updateFeed(url, {
			title: "Blog",
			entries: [head, { ...old, id: "rss:2" }],
		}),
	).toEqual([]);
	const [source] = (await store.read()).subscriptions;
	expect(source.entries.map((entry) => entry.url)).toEqual([
		head.url,
		old.url,
	]);
	expect(source.history).toBeNull();
});

it("retains podcast episodes with distinct GUIDs and a shared public link", async () => {
	const store = storeFixture().create();
	const episode = (id: string) => ({
		id,
		title: id,
		url: "https://example.org/podcast",
		audioUrl: `https://example.org/${id}.mp3`,
	});
	const first = episode("first");
	const second = episode("second");
	await store.updateFeed(url, { title: "Podcast", entries: [second] });
	expect(
		await store.appendHistory(url, {
			title: "Podcast",
			entries: [second, first],
		}),
	).toEqual([first]);
	expect((await store.read()).subscriptions[0].entries).toEqual([
		second,
		first,
	]);
	const third = episode("third");
	expect(
		await store.updateFeed(url, {
			title: "Podcast",
			entries: [third, second],
		}),
	).toEqual([third]);
	expect((await store.read()).subscriptions[0].entries).toEqual([
		third,
		second,
		first,
	]);
});

it("skips newer WordPress posts when history is opened before checking for updates", async () => {
	const get = vi.fn(async (address: string) => {
		const query = new URL(address).searchParams;
		expect(query.get("rest_route")).toBe("/wp/v2/posts");
		const post = (id: number) => ({
			id,
			link: `https://example.org/?p=${id}`,
		});
		return JSON.stringify({
			status: 200,
			headers: { "X-WP-TotalPages": 3 },
			body:
				query.get("page") === "1"
					? [post(5), post(4)]
					: [post(3), post(2), post(1)],
		});
	});
	const signal = new AbortController().signal;
	const first = await readFeed("https://example.org/?feed=rss2", {
		get: async () =>
			'<rss version="2.0"><channel><title>Blog</title><link>https://example.org/</link><generator>WordPress</generator><item><link>https://example.org/?p=2</link><title>Latest seen</title></item></channel></rss>',
		signal,
	});
	if (!first.history) throw new Error("Missing WordPress archive");
	const newer = await readFeedHistory(first.history, first.entries, {
		get,
		signal,
	});
	expect(newer.entries).toEqual([]);
	if (!newer.history) throw new Error("Missing next archive page");
	const older = await readFeedHistory(newer.history, first.entries, {
		get,
		signal,
	});
	expect(older.entries.map((entry) => entry.id)).toEqual(["wp:2", "wp:1"]);
});
