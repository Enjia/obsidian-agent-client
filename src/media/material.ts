export interface TranscriptSegment {
	startMs: number;
	endMs: number;
	text: string;
}

export interface Material {
	title: string;
	source?: string;
	method:
		| "article"
		| "published-transcript"
		| "human-captions"
		| "automatic-captions"
		| "local-transcription";
	text?: string;
	segments?: TranscriptSegment[];
	language?: string;
}

const methodLabels: Record<Material["method"], string> = {
	article: "Extracted article",
	"published-transcript": "Published transcript",
	"human-captions": "Human captions",
	"automatic-captions": "Automatic captions",
	"local-transcription": "Local transcription (Whisper)",
};

function timestamp(ms: number): string {
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor(ms / 60_000) % 60;
	const seconds = Math.floor(ms / 1000) % 60;
	const parts = [hours, minutes, seconds].map((part) =>
		String(part).padStart(2, "0"),
	);
	return parts.join(":") + "." + String(ms % 1000).padStart(3, "0");
}

export function materialMarkdown(material: Material): string {
	const metadata = [
		`Method: ${methodLabels[material.method]}`,
		material.source && `Source: ${material.source}`,
		material.language && `Language: ${material.language}`,
	]
		.filter(Boolean)
		.join("\n");
	const body =
		material.segments
			?.map(({ startMs, text }) => `[${timestamp(startMs)}] ${text}`)
			.join("\n\n") ??
		material.text ??
		"";
	return `# ${material.title.replace(/\s+/g, " ").trim()}\n\n${metadata}\n\n${body}\n`;
}
