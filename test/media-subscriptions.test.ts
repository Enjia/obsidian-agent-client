// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { readFeed } from "../src/media/feed-reader";
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
	).toBe(0);
	expect(
		await store.updateFeed(url, {
			title: "Blog",
			entries: [second, first, second],
		}),
	).toBe(1);
	const restarted = create();
	expect(
		await restarted.updateFeed(url, {
			title: "Blog",
			entries: [first, second],
		}),
	).toBe(0);
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
					displayName: "My blog",
				},
			],
		},
		youtubeTracking: {
			subscriptions: [
				{
					url: "https://www.youtube.com/@Example",
					displayName: "Videos",
				},
			],
		},
		microPodcastTracking: {
			subscriptions: [
				{
					url: "https://www.xiaoyuzhoufm.com/podcast/abc",
					displayName: "Pod",
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
	).toBe(1);
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
			title: "Creator",
			entries: [{ id: "BV123", title: "Video" }],
		}),
		stderr: "",
	}));
	const feed = await readFeed("https://space.bilibili.com/42", {
		get: vi.fn(),
		run,
		signal: new AbortController().signal,
	});
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
