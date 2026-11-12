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

it("opens media intake from a labeled sidebar toolbar button", async () => {
	const el = document.createElement("div");
	const root = createRoot(el);
	const openMedia = vi.fn();
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
				}),
			),
		);
		const button = el.querySelector<HTMLButtonElement>(
			'button[aria-label="外部资源转换"]',
		);
		expect(button?.querySelector('[data-icon="file-input"]')).toBeTruthy();
		button?.click();
		expect(openMedia).toHaveBeenCalledOnce();
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});
