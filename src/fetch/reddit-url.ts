/** Reddit's media subdomains need a non-navigation Accept header. */
export function isRedditMediaUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".redd.it");
  } catch {
    return false;
  }
}
