import { requestUrl } from "obsidian";

export async function fetchSourceText(
	url: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Operation cancelled."));
		const timeout = setTimeout(
			() => reject(new Error("Source request timed out.")),
			45_000,
		);
		signal?.addEventListener("abort", abort, { once: true });
		void requestUrl({ url, headers, throw: false })
			.then((response) => {
				if (response.status >= 400)
					reject(
						new Error(
							`Source request failed (HTTP ${response.status}).`,
						),
					);
				else resolve(response.text);
			}, reject)
			.finally(() => {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", abort);
			});
	});
}
