import { Platform } from "obsidian";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";

export type RunTool = (
	command: string,
	args: string[],
	signal: AbortSignal,
	timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

const toolDirectories = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	join(homedir(), ".local", "bin"),
	join(homedir(), "anaconda3", "bin"),
];

export function resolveMediaTool(command: string): string {
	return (
		toolDirectories
			.map((directory) => join(directory, command))
			.find((path) => existsSync(path)) ?? command
	);
}

export const runMediaTool: RunTool = (command, args, signal, timeoutMs) => {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: {
				...process.env,
				PATH: [...toolDirectories, process.env.PATH ?? ""].join(
					delimiter,
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: !Platform.isWin,
		});
		let stdout = "";
		let stderr = "";
		let failure: Error | undefined;
		const stop = (error: Error) => {
			if (failure) return;
			failure = error;
			if (!child.pid) return;
			try {
				if (Platform.isWin) {
					const killer = spawn(
						"taskkill",
						["/PID", String(child.pid), "/T", "/F"],
						{ stdio: "ignore", windowsHide: true },
					);
					killer.once("error", () => child.kill("SIGKILL"));
				} else {
					process.kill(-child.pid, "SIGKILL");
				}
			} catch {
				child.kill("SIGKILL");
			}
		};
		const abort = () => stop(new Error("Operation cancelled."));
		const timer = setTimeout(
			() => stop(new Error(`${command} timed out.`)),
			timeoutMs,
		);
		signal.addEventListener("abort", abort, { once: true });
		child.stdout.setEncoding("utf8").on("data", (data: string) => {
			stdout += data;
			if (stdout.length > 16 * 1024 * 1024)
				stop(new Error(`${command} returned too much output.`));
		});
		child.stderr.setEncoding("utf8").on("data", (data: string) => {
			stderr = (stderr + data).slice(-8192);
		});
		child.on("error", (error) => {
			failure ??= new Error(`Could not run ${command}: ${error.message}`);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (code !== 0)
				reject(
					new Error(
						`${command} exited with code ${code}: ${stderr.trim().slice(-1200)}`,
					),
				);
			else resolve({ stdout, stderr });
		});
	});
};

export async function withMediaDirectory<T>(
	operation: (directory: string) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "agent-client-media-"));
	try {
		return await operation(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export function videoToolArgs(): string[] {
	return ["--ignore-config", "--js-runtimes", "node", "--no-warnings"];
}
