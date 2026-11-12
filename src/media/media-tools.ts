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
		});
		let stdout = "";
		let stderr = "";
		let failure: Error | undefined;
		const stop = (error: Error) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const abort = () => stop(new Error("Operation cancelled."));
		const timer = setTimeout(
			() => stop(new Error(`${command} timed out.`)),
			timeoutMs,
		);
		signal.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
			if (stdout.length > 16 * 1024 * 1024)
				stop(new Error(`${command} returned too much output.`));
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString()).slice(-8192);
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
