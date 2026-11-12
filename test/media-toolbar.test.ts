// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChatHeader } from "../src/ui/ChatHeader";

vi.mock("obsidian", () => ({
	setIcon: (el: HTMLElement, name: string) => {
		el.dataset.icon = name;
	},
	DropdownComponent: class {},
}));

it("provides separate sidebar toolbar buttons for media and subscriptions", async () => {
	const el = document.createElement("div");
	const root = createRoot(el);
	const openMedia = vi.fn();
	const openSubscriptions = vi.fn();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	try {
		await act(async () =>
			root.render(
				createElement(ChatHeader, {
					variant: "sidebar",
					agentLabel: "Codex",
					isUpdateAvailable: false,
					onNewChat: vi.fn(),
					onExportChat: vi.fn(),
					onShowMenu: vi.fn(),
					onOpenMedia: openMedia,
					onOpenSubscriptions: openSubscriptions,
				}),
			),
		);
		const button = el.querySelector<HTMLButtonElement>(
			'button[aria-label="外部资源转换"]',
		);
		expect(button?.querySelector('[data-icon="file-input"]')).toBeTruthy();
		button?.click();
		expect(openMedia).toHaveBeenCalledOnce();
		const subscriptions = el.querySelector<HTMLButtonElement>(
			'button[aria-label="订阅"]',
		);
		expect(subscriptions?.querySelector('[data-icon="rss"]')).toBeTruthy();
		subscriptions?.click();
		expect(openSubscriptions).toHaveBeenCalledOnce();
		expect(openMedia).toHaveBeenCalledOnce();
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});
