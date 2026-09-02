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
  maxLines?: number;
  maxBytes?: number;
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
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const truncation = truncateHead(text, { maxLines, maxBytes });

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
  const limitLabel = `${Math.round(maxBytes / 1024)}KB/${maxLines}-line`;
  const notice = `[Output truncated to the ${limitLabel} limit.${location} ${options.continuation}]`;
  const separator = "\n\n";
  const contentBudget = maxBytes - Buffer.byteLength(separator + notice, "utf8");
  const finalTruncation = truncateHead(text, {
    maxLines: maxLines - 2,
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
