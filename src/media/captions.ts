import type { TranscriptSegment } from "./material";

function decodeText(text: string): string {
	// Strip caption markup without interpreting arbitrary HTML or inserting it into the app.
	return (
		new DOMParser()
			.parseFromString(
				text.replace(/<\d{2}:\d{2}[^>]*>/g, ""),
				"text/html",
			)
			.body.textContent?.replace(/\s+/g, " ")
			.trim() ?? ""
	);
}

function timeMs(value: string): number {
	const parts = value.replace(",", ".").split(":").map(Number);
	return Math.round(
		parts.reduce((seconds, part) => seconds * 60 + part, 0) * 1000,
	);
}

function push(
	segments: TranscriptSegment[],
	startMs: number,
	endMs: number,
	raw: string,
): void {
	const text = decodeText(raw);
	if (
		!text ||
		!Number.isFinite(startMs) ||
		!Number.isFinite(endMs) ||
		startMs < 0 ||
		endMs < startMs
	)
		return;
	const previous = segments[segments.length - 1];
	if (previous?.text === text && startMs <= previous.endMs + 250) {
		previous.endMs = Math.max(previous.endMs, endMs);
		return;
	}
	segments.push({ startMs, endMs, text });
}

export function parseCaptionSegments(
	raw: string,
	format: string,
): TranscriptSegment[] {
	const kind = format.toLowerCase();
	const segments: TranscriptSegment[] = [];
	if (kind.includes("json")) {
		const data = JSON.parse(raw) as {
			events?: Array<{
				tStartMs: number;
				dDurationMs?: number;
				segs?: Array<{ utf8: string }>;
			}>;
			segments?: Array<{
				startTime: number;
				endTime: number;
				body: string;
			}>;
			body?: Array<{ from: number; to: number; content: string }>;
		};
		for (const row of data.events ?? []) {
			const text = row.segs?.map((part) => part.utf8).join("") ?? "";
			push(
				segments,
				row.tStartMs,
				row.tStartMs + (row.dDurationMs ?? 0),
				text,
			);
		}
		for (const row of data.segments ?? [])
			push(
				segments,
				Math.round(row.startTime * 1000),
				Math.round(row.endTime * 1000),
				row.body,
			);
		for (const row of data.body ?? [])
			push(
				segments,
				Math.round(row.from * 1000),
				Math.round(row.to * 1000),
				row.content,
			);
		return segments;
	}
	const timing =
		/^((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/;
	for (const block of raw.replace(/\r/g, "").split(/\n[ \t]*\n/)) {
		const lines = block.split("\n");
		const index = lines.findIndex((line) => timing.test(line.trim()));
		if (index < 0) continue;
		const match = lines[index].trim().match(timing);
		if (match)
			push(
				segments,
				timeMs(match[1]),
				timeMs(match[2]),
				lines.slice(index + 1).join(" "),
			);
	}
	return segments;
}

export function plainCaptionText(raw: string, format: string): string {
	if (/json|vtt|srt|subrip/i.test(format)) return "";
	if (/html/i.test(format) || /^\s*<(?:!doctype|html|body)\b/i.test(raw)) {
		const doc = new DOMParser().parseFromString(raw, "text/html");
		doc.querySelectorAll("script,style,nav,header,footer").forEach(
			(element) => element.remove(),
		);
		return doc.body.textContent?.trim() ?? "";
	}
	return raw.trim();
}
