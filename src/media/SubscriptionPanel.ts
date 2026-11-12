import { Modal, setIcon, type App } from "obsidian";
import { readFeedHistory } from "./feed-history";
import { readFeed } from "./feed-reader";
import type { MediaStore, Subscription } from "./media-store";
import { fetchSourceText } from "./source-fetch";
import { siteIs, type SourceLink } from "./source-reader";

const PAGE_SIZE = 20;

interface SubscriptionCheckResults {
	newEntries: Map<string, Set<string>>;
	failures: Map<string, string>;
	expandedSources: Map<string, boolean>;
	visibleCounts: Map<string, number>;
	historyNotices: Map<string, string>;
	scrollTop: number;
}

export class SubscriptionModal extends Modal {
	private view?: AbortController;
	private readonly results: SubscriptionCheckResults = {
		newEntries: new Map(),
		failures: new Map(),
		expandedSources: new Map(),
		visibleCounts: new Map(),
		historyNotices: new Map(),
		scrollTop: 0,
	};

	constructor(
		app: App,
		private store: MediaStore,
		private openEntry: (link: SourceLink) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("订阅");
		this.view = new AbortController();
		mountSubscriptions(
			this.contentEl,
			this.store,
			(link) => {
				this.close();
				this.openEntry(link);
			},
			this.view.signal,
			this.results,
			this.modalEl,
		);
	}

	onClose(): void {
		this.view?.abort();
		this.contentEl.empty();
	}
}

function sourceIcon(source: Subscription): { icon: string; label: string } {
	const url = new URL(source.url);
	const videoDomains = [
		"youtube.com",
		"youtu.be",
		"bilibili.com",
		"b23.tv",
		"vimeo.com",
	];
	if (videoDomains.some((domain) => siteIs(url, domain))) {
		return { icon: "video", label: "视频" };
	}
	if (
		siteIs(url, "xiaoyuzhoufm.com") ||
		url.hostname === "podcasts.apple.com" ||
		source.entries.some((entry) => entry.audioUrl || entry.transcriptUrl)
	) {
		return { icon: "headphones", label: "播客" };
	}
	return { icon: "newspaper", label: "文章" };
}

export function mountSubscriptions(
	container: HTMLElement,
	store: Pick<MediaStore, "read" | "updateFeed" | "appendHistory" | "remove">,
	openEntry: (link: SourceLink) => void,
	signal: AbortSignal,
	state: SubscriptionCheckResults,
	scrollRegion = container,
): void {
	const {
		newEntries,
		failures,
		expandedSources,
		visibleCounts,
		historyNotices,
	} = state;
	const section = container.createDiv({
		cls: "agent-client-media-subscriptions",
	});
	const controls = section.createDiv({ cls: "agent-client-media-controls" });
	const refresh = controls.createEl("button", {
		text: "检查更新",
		attr: { type: "button" },
	});
	const add = controls.createEl("button", {
		text: "添加订阅",
		attr: { type: "button", "aria-expanded": "false" },
	});
	const form = section.createEl("form");
	const fields = form.createDiv({ cls: "agent-client-media-controls" });
	const input = fields.createEl("input", {
		attr: {
			type: "url",
			required: "",
			placeholder: "RSS、频道或节目链接",
			"aria-label": "订阅链接",
		},
	});
	const submit = fields.createEl("button", {
		text: "保存订阅",
		attr: { type: "submit" },
	});
	const setFormOpen = (open: boolean) => {
		form.hidden = !open;
		add.setAttribute("aria-expanded", String(open));
		if (open) input.focus();
	};
	setFormOpen(false);
	add.addEventListener("click", () => setFormOpen(form.hidden));
	const status = section.createDiv({ attr: { role: "status" } });
	const list = section.createDiv();
	const displayed = new Map<string, HTMLDetailsElement>();
	const revealAfterCheck = new Set<string>();
	let busy = false;

	const options = {
		get: (url: string, headers?: Record<string, string>) =>
			fetchSourceText(url, headers, signal),
		signal,
	};
	const read = (url: string) => readFeed(url, options);
	const savePosition = () => {
		for (const [url, details] of displayed) {
			expandedSources.set(url, details.open);
		}
		state.scrollTop = scrollRegion.scrollTop;
	};
	const render = (subscriptions: Subscription[]) => {
		if (signal.aborted) return;
		if (displayed.size) savePosition();
		list.empty();
		displayed.clear();
		if (!subscriptions.length) {
			list.createEl("p", {
				text: "暂无订阅。可添加博客 RSS、视频频道或播客节目链接。",
			});
		}
		for (const source of subscriptions) {
			const latest = newEntries.get(source.url);
			const failure = failures.get(source.url);
			const details = list.createEl("details");
			displayed.set(source.url, details);
			details.open =
				revealAfterCheck.has(source.url) ||
				(expandedSources.get(source.url) ??
					Boolean(latest?.size || failure));
			const heading = details.createEl("summary");
			const { icon, label } = sourceIcon(source);
			const glyph = heading.createSpan({
				cls: "agent-client-media-subscription-icon",
				attr: { title: label, role: "img", "aria-label": label },
			});
			setIcon(glyph, icon);
			heading.createSpan({ text: source.title });
			if (latest?.size)
				heading.createSpan({ text: ` · ${latest.size} 条新增` });
			if (failure) heading.createSpan({ text: " · 查新失败" });
			if (failure) {
				const issue = details.createDiv({
					cls: "agent-client-media-subscription-error",
				});
				issue.createSpan({ text: failure });
				issue
					.createEl("button", {
						text: "重试此来源",
						attr: { type: "button" },
					})
					.addEventListener(
						"click",
						() => void act(() => check([source])),
					);
			}
			const items = details.createEl("ul");
			const entries = latest?.size
				? [
						...source.entries.filter((entry) =>
							latest.has(entry.id),
						),
						...source.entries.filter(
							(entry) => !latest.has(entry.id),
						),
					]
				: source.entries;
			const limit = Math.max(
				visibleCounts.get(source.url) ?? PAGE_SIZE,
				latest?.size ?? 0,
			);
			for (const entry of entries.slice(0, limit)) {
				const item = items.createEl("li");
				if (latest?.has(entry.id))
					item.createSpan({
						cls: "agent-client-media-subscription-new",
						text: "新增",
					});
				item.createEl("button", {
					cls: "agent-client-media-subscription-entry",
					text: entry.title,
					attr: { type: "button" },
				}).addEventListener("click", () => {
					savePosition();
					openEntry(entry);
				});
			}
			const canLoadEarlier =
				entries.length > limit || source.history !== null;
			if (canLoadEarlier || historyNotices.get(source.url)) {
				const historyControls = details.createDiv({
					cls: "agent-client-media-controls",
				});
				const progress = historyControls.createSpan({
					text: historyNotices.get(source.url),
					attr: { role: "status" },
				});
				if (canLoadEarlier) {
					const earlier = historyControls.createEl("button", {
						text: "加载更早",
						attr: { type: "button" },
					});
					historyControls.prepend(earlier);
					earlier.addEventListener("click", () => {
						void act(
							async () => {
								const message = await loadEarlier(
									source,
									limit,
								);
								historyNotices.set(source.url, message);
								return message;
							},
							progress,
							earlier,
						);
					});
				}
			}
			details
				.createDiv({ cls: "agent-client-media-controls" })
				.createEl("button", {
					text: "移除订阅",
					attr: { type: "button" },
				})
				.addEventListener(
					"click",
					() =>
						void act(async () => {
							await store.remove(source.url);
							newEntries.delete(source.url);
							failures.delete(source.url);
							expandedSources.delete(source.url);
							visibleCounts.delete(source.url);
							historyNotices.delete(source.url);
							displayed.delete(source.url);
							return "已移除订阅。";
						}),
				);
		}
		revealAfterCheck.clear();
		scrollRegion.scrollTop = state.scrollTop;
	};

	const loadEarlier = async (
		source: Subscription,
		limit: number,
	): Promise<string> => {
		if (source.entries.length <= limit) {
			let history = source.history;
			let known = source.entries;
			if (history === undefined) {
				const head = await read(source.url);
				signal.throwIfAborted();
				const updated = await store.updateFeed(source.url, head, true);
				if (updated.length) {
					newEntries.set(
						source.url,
						new Set([
							...(newEntries.get(source.url) ?? []),
							...updated.map((entry) => entry.id),
						]),
					);
				}
				const current = (await store.read()).subscriptions.find(
					(item) => item.url === source.url,
				);
				history = current?.history;
				known = current?.entries ?? known;
			}
			if (history && known.length <= limit) {
				const page = await readFeedHistory(history, known, options);
				signal.throwIfAborted();
				const loaded = await store.appendHistory(source.url, page);
				if (!loaded.length && page.history)
					return "此页没有可添加的旧条目，可继续加载。";
				if (!loaded.length) return "已显示来源提供的全部条目。";
			} else if (known.length <= limit) {
				return "已显示来源提供的全部条目。";
			}
		}
		visibleCounts.set(source.url, limit + PAGE_SIZE);
		return "";
	};

	const check = async (sources: Subscription[]): Promise<string> => {
		if (!sources.length) return "暂无可检查的订阅。";
		let count = 0;
		let failed = 0;
		for (const source of sources) {
			signal.throwIfAborted();
			try {
				const feed = await read(source.url);
				signal.throwIfAborted();
				const updated = await store.updateFeed(source.url, feed, true);
				newEntries.set(
					source.url,
					new Set(updated.map((entry) => entry.id)),
				);
				failures.delete(source.url);
				if (updated.length) revealAfterCheck.add(source.url);
				count += updated.length;
			} catch (error) {
				signal.throwIfAborted();
				revealAfterCheck.add(source.url);
				failures.set(
					source.url,
					error instanceof Error ? error.message : String(error),
				);
				failed++;
			}
		}
		return `${count} 条新增${failed ? `，${failed} 个来源检查失败` : ""}。`;
	};

	const act = async (
		operation: () => Promise<string>,
		progress: HTMLElement = status,
		trigger?: HTMLButtonElement,
	) => {
		if (busy || signal.aborted) return;
		busy = refresh.disabled = submit.disabled = true;
		if (trigger) trigger.disabled = true;
		progress.setText("正在处理订阅…");
		try {
			const message = await operation();
			render((await store.read()).subscriptions);
			if (!signal.aborted && !trigger) status.setText(message);
		} catch (error) {
			if (!signal.aborted)
				progress.setText(
					error instanceof Error ? error.message : String(error),
				);
		} finally {
			if (trigger) trigger.disabled = false;
			busy = refresh.disabled = submit.disabled = false;
		}
	};
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void act(async () => {
			const url = input.value.trim();
			if (!url) throw new Error("请输入订阅链接。");
			const feed = await read(url);
			signal.throwIfAborted();
			await store.updateFeed(url, feed);
			input.value = "";
			setFormOpen(false);
			return `已保存 ${feed.title}。`;
		});
	});
	refresh.addEventListener(
		"click",
		() => void act(async () => check((await store.read()).subscriptions)),
	);
	void store
		.read()
		.then(({ subscriptions }) => render(subscriptions))
		.catch((error: unknown) => {
			if (!signal.aborted)
				status.setText(
					error instanceof Error ? error.message : String(error),
				);
		});
}
