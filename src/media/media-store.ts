import type { FeedEntry, SourceFeed } from "./feed-reader";
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

	async updateFeed(
		url: string,
		feed: SourceFeed,
		existingOnly = false,
	): Promise<FeedEntry[]> {
		const normalized = subscriptionUrl(url);
		return this.change(async () => {
			const data = await this.readFile();
			const previous = data.subscriptions.find(
				(subscription) => subscription.url === normalized,
			);
			if (!previous && existingOnly) return [];
			const seen = new Set(previous?.seen);
			const entries = Array.from(
				new Map(
					feed.entries.map((entry) => [entry.id, entry]),
				).values(),
			);
			const added = previous?.seen
				? entries.filter((entry) => !seen.has(entry.id))
				: [];
			for (const entry of entries) seen.add(entry.id);
			const next: Subscription = {
				url: normalized,
				title: previous?.label ?? feed.title,
				label: previous?.label,
				entries,
				seen: Array.from(seen),
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
