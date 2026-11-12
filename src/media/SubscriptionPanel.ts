import { Setting } from "obsidian";
import { readFeed } from "./feed-reader";
import type { MediaStore, Subscription } from "./media-store";
import { fetchSourceText } from "./source-fetch";
import type { SourceLink } from "./source-reader";

export function mountSubscriptions(
	container: HTMLElement,
	store: MediaStore,
	openEntry: (link: SourceLink) => void,
	signal: AbortSignal,
): void {
	const section = container.createEl("details", {
		cls: "agent-client-media-subscriptions",
	});
	section.createEl("summary", { text: "Subscriptions" });
	let input: HTMLInputElement;
	const controls = new Setting(section)
		.setName("Subscription source")
		.addText((text) => {
			input = text.setPlaceholder("Feed, channel or show URL").inputEl;
		});
	const status = section.createDiv({ attr: { role: "status" } });
	const list = section.createDiv();
	let busy = false;

	const read = (url: string) =>
		readFeed(url, {
			get: (url, headers) => fetchSourceText(url, headers, signal),
			signal,
		});
	const render = (subscriptions: Subscription[]) => {
		if (signal.aborted) return;
		list.empty();
		for (const source of subscriptions) {
			const details = list.createEl("details");
			details.createEl("summary", { text: source.title });
			const items = details.createEl("ul");
			for (const entry of source.entries.slice(0, 20)) {
				items
					.createEl("li")
					.createEl("button", { text: entry.title })
					.addEventListener("click", () => openEntry(entry));
			}
			details
				.createEl("button", { text: "Remove subscription" })
				.addEventListener(
					"click",
					() =>
						void act(async () => {
							await store.remove(source.url);
							return "Subscription removed.";
						}),
				);
		}
	};
	const act = async (operation: () => Promise<string>) => {
		if (busy || signal.aborted) return;
		busy = true;
		status.setText("Checking source…");
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
			busy = false;
		}
	};
	controls.addButton((button) =>
		button.setButtonText("Add").onClick(
			() =>
				void act(async () => {
					const url = input.value.trim();
					if (!url) throw new Error("Enter a subscription URL.");
					const feed = await read(url);
					signal.throwIfAborted();
					await store.updateFeed(url, feed);
					input.value = "";
					return `Saved ${feed.title}.`;
				}),
		),
	);
	controls.addButton((button) =>
		button.setButtonText("Check updates").onClick(
			() =>
				void act(async () => {
					let count = 0;
					const errors: string[] = [];
					const { subscriptions } = await store.read();
					for (const source of subscriptions) {
						signal.throwIfAborted();
						try {
							const feed = await read(source.url);
							signal.throwIfAborted();
							count += await store.updateFeed(
								source.url,
								feed,
								true,
							);
						} catch (error) {
							errors.push(
								`${source.title}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
					return [
						`${count} new item${count === 1 ? "" : "s"}.`,
						...errors,
					].join(" ");
				}),
		),
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
