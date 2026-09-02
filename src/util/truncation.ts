import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

type FullOutputOptions =
  | { existingPath: string }
  | { prefix: string; filename: string };

interface TruncateToolTextOptions {
  continuation: string;
  fullOutput?: FullOutputOptions;
}

export interface TruncatedToolText {
  text: string;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export async function truncateToolText(
  text: string,
  options: TruncateToolTextOptions,
): Promise<TruncatedToolText> {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    if (options.fullOutput && "existingPath" in options.fullOutput) {
      return { text, fullOutputPath: options.fullOutput.existingPath };
    }
    return { text };
  }

  let fullOutputPath: string | undefined;
  if (options.fullOutput) {
    if ("existingPath" in options.fullOutput) {
      fullOutputPath = options.fullOutput.existingPath;
    } else {
      const directory = await mkdtemp(join(tmpdir(), options.fullOutput.prefix));
      fullOutputPath = join(directory, options.fullOutput.filename);
      await writeFile(fullOutputPath, text, { encoding: "utf8", mode: 0o600 });
    }
  }

  const location = fullOutputPath ? ` Full output: ${fullOutputPath}.` : "";
  const notice = `[Output truncated to the 50KB/2000-line limit.${location} ${options.continuation}]`;
  const separator = "\n\n";
  const contentBudget = DEFAULT_MAX_BYTES - Buffer.byteLength(separator + notice, "utf8");
  const finalTruncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES - 2,
    maxBytes: contentBudget,
  });

  return {
    text: `${finalTruncation.content}${separator}${notice}`,
    truncation: finalTruncation,
    fullOutputPath,
  };
}

export async function throwTruncatedToolError(error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  const output = await truncateToolText(message, {
    continuation: "Narrow the request and try again if more error detail is needed.",
  });
  throw new Error(output.text);
}
