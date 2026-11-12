import type { FeedEntry, FeedHistory, SourceFeed } from "./feed-reader";
import { webUrl } from "./source-reader";

interface MediaStorage {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

export interface Subscription {
	url: string;
	title: string;
	label?: string;
	entries: FeedEntry[];
	seen?: string[];
	history?: FeedHistory | null;
}

interface MediaData {
	version: 1;
	model?: string;
	subscriptions: Subscription[];
}

function subscriptionUrl(raw: string): string {
	const url = webUrl(raw);
	url.hash = "";
	return url.href;
}

function sameWordPressPost(
	entry: FeedEntry,
	other: FeedEntry | undefined,
): boolean {
	return Boolean(
		other && (/^wp:\d+$/.test(entry.id) || /^wp:\d+$/.test(other.id)),
	);
}

function uniqueEntries(entries: FeedEntry[]): FeedEntry[] {
	const ids = new Set<string>();
	const links = new Map<string, FeedEntry>();
	return entries.filter((entry) => {
		if (ids.has(entry.id) || sameWordPressPost(entry, links.get(entry.url)))
			return false;
		ids.add(entry.id);
		links.set(entry.url, entry);
		return true;
	});
}

function legacySubscriptions(raw: Record<string, unknown>): Subscription[] {
	const sources = new Map<string, Subscription>();
	for (const key of [
		"blogTracking",
		"youtubeTracking",
		"microPodcastTracking",
	]) {
		const section = raw[key] as { subscriptions?: unknown[] } | undefined;
		if (!Array.isArray(section?.subscriptions)) continue;
		for (const record of section.subscriptions) {
			if (!record || typeof record !== "object") continue;
			const { url, feedUrl, title, displayName } = record as Record<
				string,
				unknown
			>;
			const address =
				typeof feedUrl === "string" && feedUrl.trim() ? feedUrl : url;
			if (typeof address !== "string") continue;
			let normalized: string;
			try {
				normalized = subscriptionUrl(address);
			} catch {
				continue;
			}
			const savedLabel = typeof title === "string" ? title : displayName;
			const label =
				typeof savedLabel === "string"
					? savedLabel.trim() || undefined
					: undefined;
			sources.set(normalized, {
				url: normalized,
				title: label || normalized,
				label,
				entries: [],
			});
		}
	}
	return Array.from(sources.values());
}

export class MediaStore {
	private pending = Promise.resolve();

	constructor(
		private readonly adapter: MediaStorage,
		private readonly path: string,
	) {}

	async importLegacy(raw: Record<string, unknown>): Promise<void> {
		await this.change(async () => {
			if (await this.adapter.exists(this.path)) return;
			const subscriptions = legacySubscriptions(raw);
			if (subscriptions.length)
				await this.write({ version: 1, subscriptions });
		});
	}

	async read(): Promise<MediaData> {
		await this.pending;
		return this.readFile();
	}

	async setModel(model: string): Promise<void> {
		await this.change(async () => {
			const data = await this.readFile();
			await this.write({ ...data, model: model || undefined });
		});
	}

	updateFeed(
		url: string,
		feed: SourceFeed,
		existingOnly = false,
	): Promise<FeedEntry[]> {
		return this.saveFeed(url, feed, existingOnly, false);
	}

	appendHistory(url: string, feed: SourceFeed): Promise<FeedEntry[]> {
		return this.saveFeed(url, feed, true, true);
	}

	private saveFeed(
		url: string,
		feed: SourceFeed,
		existingOnly: boolean,
		append: boolean,
	): Promise<FeedEntry[]> {
		const normalized = subscriptionUrl(url);
		return this.change(async () => {
			const data = await this.readFile();
			const previous = data.subscriptions.find(
				(subscription) => subscription.url === normalized,
			);
			if (!previous && existingOnly) return [];
			const known = previous?.entries ?? [];
			const seen = new Set([
				...(previous?.seen ?? []),
				...known.map(({ id }) => id),
			]);
			const links = new Map(known.map((entry) => [entry.url, entry]));
			const incoming = uniqueEntries(feed.entries);
			const added =
				previous?.seen || append
					? incoming.filter(
							(entry) =>
								!seen.has(entry.id) &&
								!sameWordPressPost(entry, links.get(entry.url)),
						)
					: [];
			for (const entry of incoming) seen.add(entry.id);
			const next: Subscription = {
				url: normalized,
				title:
					previous?.label ??
					(append ? previous?.title : feed.title) ??
					feed.title,
				label: previous?.label,
				entries: append
					? uniqueEntries([...known, ...incoming])
					: uniqueEntries([...incoming, ...known]),
				seen: Array.from(seen),
				history:
					!append && previous?.history !== undefined
						? previous.history
						: (feed.history ?? null),
			};
			await this.write({
				...data,
				subscriptions: previous
					? data.subscriptions.map((subscription) =>
							subscription === previous ? next : subscription,
						)
					: [...data.subscriptions, next],
			});
			return added;
		});
	}

	async remove(url: string): Promise<void> {
		await this.change(async () => {
			const data = await this.readFile();
			await this.write({
				...data,
				subscriptions: data.subscriptions.filter(
					(item) => item.url !== url,
				),
			});
		});
	}

	private change<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation);
		this.pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async readFile(): Promise<MediaData> {
		if (!(await this.adapter.exists(this.path)))
			return { version: 1, subscriptions: [] };
		const data = JSON.parse(
			await this.adapter.read(this.path),
		) as MediaData;
		if (data.version !== 1 || !Array.isArray(data.subscriptions))
			throw new Error("Unsupported media settings file.");
		return data;
	}

	private async write(data: MediaData): Promise<void> {
		await this.adapter.write(this.path, JSON.stringify(data, null, 2));
	}
}
