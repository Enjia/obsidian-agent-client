import { requestUrl, type RequestUrlParam } from "obsidian";
import { setTimeout as delay } from "timers/promises";
import type { Material, TranscriptSegment } from "./material";
import type { SourceAudio } from "./source-reader";

const BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const MODEL = "paraformer-v2";
const POLL_INTERVAL_MS = 5_000;
const TASK_TIMEOUT_MS = 45 * 60_000;

interface TaskResponse {
	code?: string;
	output?: {
		task_id?: string;
		task_status?: string;
		code?: string;
		results?: Array<{
			subtask_status?: string;
			transcription_url?: string;
			code?: string;
		}>;
	};
}

interface TranscriptResponse {
	transcripts?: Array<{
		sentences?: Array<{
			begin_time: number;
			end_time: number;
			text: string;
		}>;
	}>;
}

async function readJson<T>(
	request: RequestUrlParam,
	signal: AbortSignal,
	label: string,
): Promise<T> {
	signal.throwIfAborted();
	const timeout = new AbortController();
	const stop = () => timeout.abort();
	signal.addEventListener("abort", stop, { once: true });
	try {
		const response = await Promise.race([
			requestUrl({ ...request, throw: false }).catch(() => {
				throw new Error(`${label}失败，网络请求未完成。`);
			}),
			delay(30_000, undefined, { signal: timeout.signal }).then(() => {
				throw new Error(`${label}超时。`);
			}),
		]);
		signal.throwIfAborted();
		if (response.status >= 400) {
			if (response.status === 401 || response.status === 403) {
				throw new Error(
					`${label}失败（HTTP ${response.status}）。请检查北京地域的普通 API Key、模型权限及额度。`,
				);
			}
			throw new Error(`${label}失败（HTTP ${response.status}）。`);
		}
		return JSON.parse(response.text) as T;
	} finally {
		timeout.abort();
		signal.removeEventListener("abort", stop);
	}
}

export async function transcribeWithBailian(
	audio: SourceAudio,
	apiKey: string,
	signal: AbortSignal,
	progress: (detail: string) => void,
): Promise<Material> {
	if (audio.requiresDownload) throw new Error("百炼转录需要公开音频直链。");
	const headers = { Authorization: `Bearer ${apiKey}` };
	progress("正在提交百炼转录…");
	const submitted = await readJson<TaskResponse>(
		{
			url: BASE_URL + "/services/audio/asr/transcription",
			method: "POST",
			contentType: "application/json",
			headers: { ...headers, "X-DashScope-Async": "enable" },
			body: JSON.stringify({
				model: MODEL,
				input: { file_urls: [audio.audioUrl] },
			}),
		},
		signal,
		"提交百炼任务",
	);
	const taskId = submitted.output?.task_id;
	if (!taskId) throw new Error("百炼未返回任务 ID。");
	const deadline = Date.now() + TASK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await delay(POLL_INTERVAL_MS, undefined, { signal });
		const status = await readJson<TaskResponse>(
			{ url: BASE_URL + "/tasks/" + encodeURIComponent(taskId), headers },
			signal,
			"查询百炼任务",
		);
		const task = status.output;
		if (
			task?.task_status === "PENDING" ||
			task?.task_status === "RUNNING"
		) {
			progress(
				task.task_status === "PENDING"
					? "百炼正在排队…"
					: "百炼正在转录…",
			);
			continue;
		}
		const result = task?.results?.[0];
		const resultUrl = result?.transcription_url;
		if (
			task?.task_status !== "SUCCEEDED" ||
			!resultUrl ||
			result?.subtask_status !== "SUCCEEDED"
		) {
			const code =
				result?.code ??
				task?.code ??
				status.code ??
				task?.task_status ??
				"UNKNOWN";
			throw new Error(`百炼转录失败（${code}，任务 ${taskId}）。`);
		}
		progress("正在获取百炼逐字稿…");
		const url = new URL(resultUrl);
		if (url.protocol !== "https:" || url.username || url.password) {
			throw new Error("百炼返回了无效的逐字稿地址。");
		}
		const transcript = await readJson<TranscriptResponse>(
			{ url: url.href },
			signal,
			"获取百炼逐字稿",
		);
		const segments: TranscriptSegment[] = [];
		for (const channel of transcript.transcripts ?? []) {
			for (const { begin_time, end_time, text } of channel.sentences ??
				[]) {
				if (
					text?.trim() &&
					Number.isFinite(begin_time) &&
					Number.isFinite(end_time) &&
					end_time >= begin_time
				) {
					segments.push({
						startMs: begin_time,
						endMs: end_time,
						text: text.trim(),
					});
				}
			}
		}
		if (!segments.length) throw new Error("百炼返回的逐字稿为空。");
		return {
			title: audio.title,
			source: audio.source,
			method: "bailian-transcription",
			segments,
		};
	}
	throw new Error(
		`等待百炼转录超时，已提交的任务可能仍在执行（任务 ${taskId}）。`,
	);
}
