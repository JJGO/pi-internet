/**
 * Lightweight DOM helpers using linkedom.
 *
 * Provenance: proxyfetch-ts/src/parsers/dom.ts
 * Borrowed: parse(), getText(), getAttr(), normalizeText() helpers.
 */

import { parseHTML } from "linkedom";

export type Doc = ReturnType<typeof parseHTML>["document"];

export function parse(html: string): Doc {
  return parseHTML(html).document;
}

export function getText(el: Element | null): string {
  if (!el) return "";
  return normalizeText(el.textContent || "");
}

export function getAttr(el: Element | null, name: string): string | undefined {
  if (!el) return undefined;
  const val = el.getAttribute(name);
  return val ?? undefined;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
