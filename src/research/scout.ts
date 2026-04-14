/**
 * Scout subagent for deep web research.
 *
 * Provenance: pi-surf/extensions/index.ts
 * Borrowed: Subagent spawn pattern (pi --mode json --no-session),
 * JSONL event parsing, scout model auto-detection table, usage tracking.
 *
 * Key differences:
 * - Sets PI_INTERNET_SCOUT=1 to prevent web_research recursion
 * - Passes --no-extensions to avoid loading user's other extensions
 * - Uses this extension's own path so scout has web_search + fetch_url
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ── Scout model resolution ─────────────────────────────────────

const SCOUT_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
  google: "gemini-2.0-flash",
  groq: "llama-3.3-70b-versatile",
  xai: "grok-3-mini-fast",
  mistral: "mistral-small-latest",
  openrouter: "anthropic/claude-haiku-4-5",
};

const DEFAULT_SCOUT_MODEL = "claude-haiku-4-5";

export function resolveScoutModel(
  explicitModel: string | undefined,
  currentProvider: string | undefined,
): string {
  if (explicitModel) return explicitModel;
  if (currentProvider && SCOUT_MODELS[currentProvider]) return SCOUT_MODELS[currentProvider];
  return DEFAULT_SCOUT_MODEL;
}

// ── Subagent runner ────────────────────────────────────────────

export interface ScoutResult {
  output: string;
  exitCode: number;
  usage: { input: number; output: number; cost: number; turns: number; model?: string };
  error?: string;
}

export async function runScout(
  task: string,
  systemPrompt: string,
  model: string,
  extensionDir: string,
  cwd: string,
  signal?: AbortSignal,
  onUpdate?: (text: string) => void,
): Promise<ScoutResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-scout-"));
  const promptPath = join(tmpDir, "scout-prompt.md");
  writeFileSync(promptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });

  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--model", model,
    "--tools", "read,bash",
    "-e", extensionDir,
    "--append-system-prompt", promptPath,
    `Task: ${task}`,
  ];

  const result: ScoutResult = {
    output: "",
    exitCode: 0,
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
  };

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_INTERNET_SCOUT: "1", PI_WEB_SURF_SCOUT: "1" },
      });

      let buffer = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "message_end" && event.message?.role === "assistant") {
              result.usage.turns++;
              if (event.message.usage) {
                result.usage.input += event.message.usage.input || 0;
                result.usage.output += event.message.usage.output || 0;
                result.usage.cost += event.message.usage.cost?.total || 0;
              }
              if (event.message.model) result.usage.model = event.message.model;
              for (const part of event.message.content) {
                if (part.type === "text") {
                  result.output = part.text;
                  onUpdate?.(part.text);
                }
              }
            }
          } catch {
            // skip unparseable lines
          }
        }
      });

      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        // Flush remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (event.type === "message_end" && event.message?.role === "assistant") {
              for (const part of event.message.content) {
                if (part.type === "text") result.output = part.text;
              }
            }
          } catch {}
        }
        if (stderr.trim() && !result.output) result.error = stderr.trim();
        resolve(code ?? 0);
      });

      proc.on("error", (err) => {
        if (!result.error) {
          result.error = `Failed to start scout subprocess: ${err.message}`;
        }
        resolve(1);
      });

      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
  } finally {
    try { unlinkSync(promptPath); } catch {}
    try { rmdirSync(tmpDir); } catch {}
  }

  return result;
}

// ── System prompt builder ──────────────────────────────────────

export function buildScoutPrompt(
  task: string,
  hasSearch: boolean,
  urls?: string[],
  query?: string,
): string {
  const tools = ["fetch_url"];
  if (hasSearch) tools.push("web_search");

  let prompt = `You are a web research specialist. You have these tools: ${tools.join(", ")}.

Your workflow:`;

  if (query && hasSearch) {
    prompt += `
1. Use web_search to search for: ${query}
2. Pick the most relevant results (usually 2-4)
3. Use fetch_url to read the full content of those pages`;
  }

  if (urls?.length) {
    const step = query ? "4" : "1";
    prompt += `
${step}. Use fetch_url to retrieve content from each URL:
${urls.map((u, i) => `   ${i + 1}. ${u}`).join("\n")}`;
  }

  prompt += `

Then:
- Analyze all the content you've gathered
- Return ONLY the information relevant to the research task
- Discard everything else (navigation, ads, boilerplate, tangential info)

Output rules:
- Be concise — the caller has limited context
- Use bullet points and headers for scannability
- Include specific code examples, API signatures, or config when relevant
- Quote exact values (version numbers, URLs, commands) — don't paraphrase technical details
- If content is too long, prioritize the most relevant sections`;

  return prompt;
}
