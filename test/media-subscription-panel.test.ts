// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { App } from "obsidian";
import {
	mountSubscriptions,
	SubscriptionModal,
} from "../src/media/SubscriptionPanel";
import { readFeedHistory } from "../src/media/feed-history";
import { readFeed } from "../src/media/feed-reader";
import { MediaStore } from "../src/media/media-store";

vi.mock("../src/media/feed-history", () => ({ readFeedHistory: vi.fn() }));
vi.mock("../src/media/feed-reader", () => ({ readFeed: vi.fn() }));
vi.mock("obsidian", () => ({
	App: class {},
	Modal: class {
		modalEl = document.createElement("div");
		contentEl = this.modalEl.appendChild(document.createElement("div"));
		setTitle() {}
		open() {
			(this as unknown as SubscriptionModal).onOpen();
		}
		close() {
			(this as unknown as SubscriptionModal).onClose();
		}
	},
	setIcon: (element: HTMLElement, icon: string) => {
		element.dataset.icon = icon;
	},
}));

function installElementHelpers() {
	type Options = {
		text?: string;
		cls?: string;
		attr?: Record<string, string>;
	};
	const create = (parent: HTMLElement, tag: string, options?: Options) => {
		const child = document.createElement(tag);
		child.textContent = options?.text ?? "";
		if (options?.cls) child.className = options.cls;
		for (const [name, value] of Object.entries(options?.attr ?? {}))
			child.setAttribute(name, value);
		return parent.appendChild(child);
	};
	const helpers = {
		createEl(this: HTMLElement, tag: string, options?: Options) {
			return create(this, tag, options);
		},
		createDiv(this: HTMLElement, options?: Options) {
			return create(this, "div", options);
		},
		createSpan(this: HTMLElement, options?: Options) {
			return create(this, "span", options);
		},
		setText(this: HTMLElement, text: string) {
			this.textContent = text;
		},
		empty(this: HTMLElement) {
			this.replaceChildren();
		},
	};
	Object.assign(HTMLElement.prototype, helpers);
	return () => {
		for (const key of Object.keys(helpers))
			Reflect.deleteProperty(HTMLElement.prototype, key);
	};
}

it("opens on cached subscriptions and highlights new items with a retry on the failed source", async () => {
	const reset = installElementHelpers();
	const box = document.createElement("div");
	const scrollRegion = document.createElement("div");
	scrollRegion.append(box);
	let saved = "";
	const store = new MediaStore(
		{
			exists: async () => Boolean(saved),
			read: async () => saved,
			write: async (_path, content) => {
				saved = content;
			},
		},
		"media.json",
	);
	const blog = "https://example.org/feed";
	const podcast = "https://example.net/feed";
	const oldEntry = {
		id: "old",
		title: "Previously seen",
		url: "https://example.org/old",
	};
	const newEntry = {
		id: "new",
		title: "Newly published",
		url: "https://example.org/new",
	};
	const episode = {
		id: "episode",
		title: "Episode",
		url: "https://example.net/episode",
		audioUrl: "https://example.net/audio.mp3",
	};
	await store.updateFeed(blog, { title: "Blog", entries: [oldEntry] });
	await store.updateFeed(podcast, { title: "Podcast", entries: [episode] });
	const mockedRead = vi.mocked(readFeed).mockImplementation(async (url) => {
		if (url === podcast) throw new Error("HTTP 503");
		return { title: "Blog", entries: [oldEntry, newEntry] };
	});
	const open = vi.fn();
	const controller = new AbortController();
	const results = {
		newEntries: new Map<string, Set<string>>(),
		failures: new Map<string, string>(),
		expandedSources: new Map<string, boolean>(),
		visibleCounts: new Map<string, number>(),
		historyNotices: new Map<string, string>(),
		scrollTop: 0,
	};
	const button = (name: string) => {
		const match = Array.from(box.querySelectorAll("button")).find(
			(button) => button.textContent === name,
		);
		expect(match).toBeDefined();
		return match!;
	};
	try {
		mountSubscriptions(
			box,
			store,
			open,
			controller.signal,
			results,
			scrollRegion,
		);
		await vi.waitFor(() =>
			expect(box.textContent).toContain("Previously seen"),
		);
		expect(button("检查更新").closest("details")).toBeNull();
		expect(mockedRead).not.toHaveBeenCalled();
		expect(box.querySelector('[data-icon="newspaper"]')).toBeTruthy();
		expect(box.querySelector('[data-icon="headphones"]')).toBeTruthy();

		button("检查更新").click();
		await vi.waitFor(() =>
			expect(box.textContent).toContain("1 条新增，1 个来源检查失败。"),
		);
		const badge = box.querySelector(".agent-client-media-subscription-new");
		expect(badge?.parentElement?.textContent).toContain("Newly published");
		expect(badge?.closest("details")?.open).toBe(false);
		expect(button("重试此来源").closest("details")?.open).toBe(false);
		const podcastRow = button("重试此来源").closest("details");
		if (!podcastRow) throw new Error("Podcast row missing");
		podcastRow.open = true;
		expect(button("重试此来源").closest("details")?.textContent).toContain(
			"Podcast",
		);
		expect(button("重试此来源").closest("details")?.textContent).toContain(
			"Episode",
		);

		mockedRead
			.mockClear()
			.mockResolvedValue({ title: "Podcast", entries: [episode] });
		button("重试此来源").click();
		await vi.waitFor(() =>
			expect(box.textContent).not.toContain("查新失败"),
		);
		expect(mockedRead).toHaveBeenCalledTimes(1);
		expect(mockedRead.mock.calls[0][0]).toBe(podcast);
		const blogRow = button("Newly published").closest("details");
		if (!blogRow) throw new Error("Blog row missing");
		blogRow.open = false;
		scrollRegion.scrollTop = 120;
		button("Episode").click();
		expect(open).toHaveBeenCalledWith(episode);

		box.replaceChildren();
		scrollRegion.scrollTop = 0;
		mountSubscriptions(
			box,
			store,
			open,
			controller.signal,
			results,
			scrollRegion,
		);
		await vi.waitFor(() =>
			expect(button("Episode").closest("details")?.open).toBe(true),
		);
		expect(button("Newly published").closest("details")?.open).toBe(false);
		expect(scrollRegion.scrollTop).toBe(120);
		await vi.waitFor(() =>
			expect(
				box.querySelector(".agent-client-media-subscription-new")
					?.parentElement?.textContent,
			).toContain("Newly published"),
		);
	} finally {
		controller.abort();
		reset();
	}
});

it("shows old episodes in pages and restores the page when returning from an episode", async () => {
	const reset = installElementHelpers();
	const controller = new AbortController();
	const box = document.createElement("div");
	const url = "https://www.xiaoyuzhoufm.com/podcast/example";
	const episodes = Array.from({ length: 41 }, (_, index) => ({
		id: String(257 - index),
		title: `E${257 - index}`,
		url: `https://www.xiaoyuzhoufm.com/episode/${257 - index}`,
	}));
	const state = {
		newEntries: new Map<string, Set<string>>(),
		failures: new Map<string, string>(),
		expandedSources: new Map([[url, true]]),
		visibleCounts: new Map<string, number>(),
		historyNotices: new Map<string, string>(),
		scrollTop: 0,
	};
	let saved = JSON.stringify({
		version: 1,
		subscriptions: [
			{ url, title: "Podcast", entries: episodes.slice(0, 15) },
		],
	});
	const store = new MediaStore(
		{
			exists: async () => true,
			read: async () => saved,
			write: async (_path, content) => {
				saved = content;
			},
		},
		"media.json",
	);
	const cursor = { kind: "xiaoyuzhou" as const, url, title: "Podcast" };
	const head = vi
		.mocked(readFeed)
		.mockReset()
		.mockResolvedValue({
			title: "Podcast",
			entries: episodes.slice(0, 15),
			history: cursor,
		});
	const history = vi.mocked(readFeedHistory).mockResolvedValue({
		title: "Podcast",
		entries: episodes,
	});
	const open = vi.fn();
	const mount = () =>
		mountSubscriptions(box, store, open, controller.signal, state);
	const button = (title: string) =>
		Array.from(box.querySelectorAll("button")).find(
			(entry) => entry.textContent === title,
		);
	try {
		mount();
		await vi.waitFor(() => expect(button("E243")).toBeDefined());
		expect(button("E242")).toBeUndefined();
		expect(head).not.toHaveBeenCalled();
		button("加载更早")?.click();
		await vi.waitFor(() => expect(button("E218")).toBeDefined());
		expect(button("E217")).toBeUndefined();
		expect(history).toHaveBeenCalledOnce();
		button("E242")?.click();
		expect(open).toHaveBeenCalledWith(episodes[15]);
		box.replaceChildren();
		mount();
		await vi.waitFor(() => expect(button("E218")).toBeDefined());
		expect(box.querySelector("details")?.open).toBe(true);
		button("加载更早")?.click();
		await vi.waitFor(() => expect(button("E217")).toBeDefined());
		expect(button("加载更早")).toBeUndefined();
		expect(head).toHaveBeenCalledOnce();
		expect(history).toHaveBeenCalledOnce();
	} finally {
		controller.abort();
		reset();
	}
});

it("starts with collapsed sources from the toolbar and restores the position only on Back", async () => {
	const reset = installElementHelpers();
	const url = "https://example.org/feed";
	const episode = {
		id: "episode",
		title: "Episode",
		url: "https://example.org/episode",
	};
	const store = new MediaStore(
		{
			exists: async () => true,
			read: async () =>
				JSON.stringify({
					version: 1,
					subscriptions: [
						{ url, title: "Podcast", entries: [episode] },
					],
				}),
			write: async () => {},
		},
		"media.json",
	);
	const openEntry = vi.fn();
	const modal = new SubscriptionModal(new App(), store, openEntry);
	const details = () => modal.contentEl.querySelector("details");
	const open = async (restorePosition?: boolean) => {
		modal.show(restorePosition);
		await vi.waitFor(() => expect(details()).toBeTruthy());
	};
	try {
		await open();
		expect(details()?.open).toBe(false);
		const podcast = details();
		if (!podcast) throw new Error("Podcast row missing");
		podcast.open = true;
		modal.modalEl.scrollTop = 120;
		podcast.querySelector<HTMLButtonElement>("li button")?.click();
		expect(openEntry).toHaveBeenCalledWith(episode);

		await open(true);
		expect(details()?.open).toBe(true);
		expect(modal.modalEl.scrollTop).toBe(120);
		modal.close();

		await open();
		expect(details()?.open).toBe(false);
		expect(modal.modalEl.scrollTop).toBe(0);
	} finally {
		modal.close();
		reset();
	}
});

it("offers a separate route to the latest transcription when the plugin has a task", async () => {
	const reset = installElementHelpers();
	const store = new MediaStore(
		{
			exists: async () => false,
			read: async () => "",
			write: async () => {},
		},
		"media.json",
	);
	const modal = new SubscriptionModal(new App(), store, vi.fn());
	const button = () =>
		Array.from(modal.contentEl.querySelectorAll("button")).find(
			(element) => element.textContent === "查看转录",
		);
	const resume = vi.fn();
	try {
		modal.show();
		expect(button()).toBeUndefined();
		modal.close();
		modal.show(false, resume);
		expect(button()).toBeDefined();
		button()?.click();
		expect(resume).toHaveBeenCalledOnce();
		expect(modal.contentEl.children.length).toBe(0);
	} finally {
		modal.close();
		reset();
	}
});
