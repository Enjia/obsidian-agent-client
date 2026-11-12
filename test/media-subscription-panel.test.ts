// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { mountSubscriptions } from "../src/media/SubscriptionPanel";
import { readFeed } from "../src/media/feed-reader";
import { MediaStore } from "../src/media/media-store";

vi.mock("../src/media/feed-reader", () => ({ readFeed: vi.fn() }));
vi.mock("obsidian", () => ({
	Modal: class {},
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
	const create = function (
		this: HTMLElement,
		tag: string,
		options?: Options,
	) {
		const child = document.createElement(tag);
		child.textContent = options?.text ?? "";
		if (options?.cls) child.className = options.cls;
		for (const [name, value] of Object.entries(options?.attr ?? {}))
			child.setAttribute(name, value);
		return this.appendChild(child);
	};
	const helpers = {
		createEl: create,
		createDiv(this: HTMLElement, options?: Options) {
			return create.call(this, "div", options);
		},
		createSpan(this: HTMLElement, options?: Options) {
			return create.call(this, "span", options);
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
		scrollTop: 0,
	};
	const button = (name: string) => {
		const match = [...box.querySelectorAll("button")].find(
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
		expect(badge?.closest("details")?.open).toBe(true);
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
