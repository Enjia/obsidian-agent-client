import { Modal, setIcon, type App } from "obsidian";
import { readFeed } from "./feed-reader";
import type { MediaStore, Subscription } from "./media-store";
import { fetchSourceText } from "./source-fetch";
import { siteIs, type SourceLink } from "./source-reader";

interface SubscriptionCheckResults {
	newEntries: Map<string, Set<string>>;
	failures: Map<string, string>;
}

export class SubscriptionModal extends Modal {
	private view?: AbortController;
	private readonly results: SubscriptionCheckResults = {
		newEntries: new Map(),
		failures: new Map(),
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
		source.entries.some((entry) => entry.audioUrl || entry.transcriptUrl)
	) {
		return { icon: "headphones", label: "播客" };
	}
	return { icon: "newspaper", label: "文章" };
}

export function mountSubscriptions(
	container: HTMLElement,
	store: Pick<MediaStore, "read" | "updateFeed" | "remove">,
	openEntry: (link: SourceLink) => void,
	signal: AbortSignal,
	{ newEntries, failures }: SubscriptionCheckResults,
): void {
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
	let busy = false;

	const read = (url: string) =>
		readFeed(url, {
			get: (url, headers) => fetchSourceText(url, headers, signal),
			signal,
		});
	const render = (subscriptions: Subscription[]) => {
		if (signal.aborted) return;
		const expanded = new Set(
			Array.from(displayed)
				.filter(([, row]) => row.open)
				.map(([url]) => url),
		);
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
				expanded.has(source.url) || Boolean(latest?.size || failure);
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
			for (const entry of entries) {
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
				}).addEventListener("click", () => openEntry(entry));
			}
			details
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
							return "已移除订阅。";
						}),
				);
		}
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
				count += updated.length;
			} catch (error) {
				signal.throwIfAborted();
				failures.set(
					source.url,
					error instanceof Error ? error.message : String(error),
				);
				failed++;
			}
		}
		return `${count} 条新增${failed ? `，${failed} 个来源检查失败` : ""}。`;
	};

	const act = async (operation: () => Promise<string>) => {
		if (busy || signal.aborted) return;
		busy = refresh.disabled = submit.disabled = true;
		status.setText("正在处理订阅…");
		try {
			const message = await operation();
			render((await store.read()).subscriptions);
			if (!signal.aborted) status.setText(message);
		} catch (error) {
			if (!signal.aborted)
				status.setText(
					error instanceof Error ? error.message : String(error),
				);
		} finally {
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
