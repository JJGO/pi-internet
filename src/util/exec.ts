/**
 * Shared child-process execution with timeout and AbortSignal wiring.
 * Replaces the per-module execFile wrappers in github, github-api, and youtube.
 */

import { execFile } from "node:child_process";

export interface ExecOptions {
  timeoutMs: number;
  cwd?: string;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  error?: string;
}

export function execCommand(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: options.maxBuffer, env: options.env },
      (err, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : stdout.toString();
        const errText = typeof stderr === "string" ? stderr : stderr.toString();
        if (err) {
          const nodeErr = err as NodeJS.ErrnoException & { code?: number | string | null; killed?: boolean };
          resolve({
            ok: false,
            stdout: out,
            stderr: errText,
            code: typeof nodeErr.code === "number" ? nodeErr.code : null,
            timedOut: Boolean(nodeErr.killed) && /timed out|timeout/i.test(nodeErr.message),
            error: nodeErr.message,
          });
          return;
        }
        resolve({ ok: true, stdout: out, stderr: errText, code: 0, timedOut: false });
      },
    );

    if (options.signal) {
      const signal = options.signal;
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

const availabilityCache = new Map<string, boolean>();

/** Check (and cache) whether a command is runnable, via `<command> --version`. */
export async function isCommandAvailable(command: string): Promise<boolean> {
  const cached = availabilityCache.get(command);
  if (cached !== undefined) return cached;
  const result = await execCommand(command, ["--version"], { timeoutMs: 5000 });
  availabilityCache.set(command, result.ok);
  return result.ok;
}
