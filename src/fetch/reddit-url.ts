/** Reddit's media subdomains need a non-navigation Accept header. */
export function isRedditMediaUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".redd.it");
  } catch {
    return false;
  }
}

/** Only these two Reddit media → Redlib routes have been verified. */
export function redlibMediaPath(url: string): string | undefined {
  const parsed = new URL(url);
  switch (parsed.hostname.toLowerCase()) {
    case "i.redd.it": return `/img${parsed.pathname}`;
    case "preview.redd.it": return `/preview/pre${parsed.pathname}`;
    default: return undefined;
  }
}
