const disabledProviders = new Map<string, string>();

export function resetSearchProviderState(): void {
  disabledProviders.clear();
}

export function isSearchProviderDisabled(name: string): boolean {
  return disabledProviders.has(name);
}

export function disableSearchProvider(name: string, reason: string): void {
  disabledProviders.set(name, reason);
}

export function getDisabledSearchProviders(): { name: string; reason: string }[] {
  return Array.from(disabledProviders.entries()).map(([name, reason]) => ({ name, reason }));
}

export function getSearchProviderDisableReason(name: string): string | undefined {
  return disabledProviders.get(name);
}
