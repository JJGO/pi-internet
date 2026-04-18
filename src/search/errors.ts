export type SearchProviderErrorCode = "rate_limited" | "auth" | "http" | "network" | "unknown";

export interface SearchProviderErrorOptions {
  provider: string;
  message: string;
  statusCode?: number;
  code?: SearchProviderErrorCode;
  disableForSession?: boolean;
  disableReason?: string;
  userMessage?: string;
  cause?: unknown;
}

export class SearchProviderError extends Error {
  provider: string;
  statusCode?: number;
  code: SearchProviderErrorCode;
  disableForSession: boolean;
  disableReason?: string;
  userMessage?: string;
  override cause?: unknown;

  constructor(options: SearchProviderErrorOptions) {
    super(options.message);
    this.name = "SearchProviderError";
    this.provider = options.provider;
    this.statusCode = options.statusCode;
    this.code = options.code ?? "unknown";
    this.disableForSession = options.disableForSession ?? false;
    this.disableReason = options.disableReason;
    this.userMessage = options.userMessage;
    this.cause = options.cause;
  }
}

export function isSearchProviderError(error: unknown): error is SearchProviderError {
  return error instanceof SearchProviderError;
}

export function normalizeSearchProviderError(provider: string, error: unknown): SearchProviderError {
  if (isSearchProviderError(error)) return error;
  return new SearchProviderError({
    provider,
    message: error instanceof Error ? error.message : String(error),
    code: "unknown",
    cause: error,
  });
}
