/** Low-level transports never follow redirects: use safeFetch for validated
 * automatic following. Request's inherited default `follow` becomes `error`;
 * its manual/error modes are preserved. Explicit init.redirect=follow is rejected. */
export function singleHopRedirect(input: string | URL | Request, init: RequestInit): "error" | "manual" {
  if (init.redirect === "follow") {
    throw new Error("fetchWithProxy does not follow redirects; use safeFetch for validated redirects");
  }
  return init.redirect ?? (input instanceof Request && input.redirect === "manual" ? "manual" : "error");
}
