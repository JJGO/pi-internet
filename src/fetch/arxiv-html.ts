import TurndownService from "turndown";
import { parse } from "../util/dom.js";

export interface ArxivHtmlResult {
  markdown: string;
  warnings: string[];
}

export function arxivHtmlToMarkdown(
  html: string,
  url: string,
  selector?: string,
  includeLinks = true,
): ArxivHtmlResult {
  const document = parse(html);
  const paper = document.querySelector("article.ltx_document");
  if (!paper) throw new Error("arXiv HTML response has no semantic paper document");
  const root = selector
    ? (paper.matches(selector) ? paper : paper.querySelector(selector))
    : paper;
  if (!root) throw new Error(`Selector not found in arXiv paper: ${selector}`);

  for (const element of root.querySelectorAll("script, style, nav, footer, iframe, canvas, video, audio, svg, noscript")) {
    element.remove();
  }
  root.querySelector("h1.ltx_title")?.remove();
  for (const heading of root.querySelectorAll(".ltx_abstract h6")) {
    const replacement = document.createElement("h2");
    replacement.innerHTML = heading.innerHTML;
    heading.replaceWith(replacement);
  }

  const warnings = Array.from(root.querySelectorAll(".ltx_ERROR, .ltx_errors, .ltx_warning"))
    .map((element) => normalize(element.textContent ?? ""))
    .filter(Boolean);

  for (const element of root.querySelectorAll("a[href], img[src]")) {
    const attribute = element.tagName.toLowerCase() === "a" ? "href" : "src";
    const value = element.getAttribute(attribute);
    if (!value) continue;
    try {
      element.setAttribute(attribute, new URL(value, url).href);
    } catch {
      // Keep malformed references as displayed text instead of inventing a URL.
    }
  }

  const mathReplacements: string[] = [];
  for (const math of root.querySelectorAll("math")) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    const fallback = math.getAttribute("alttext")?.trim() || normalize(math.textContent ?? "");
    const expression = tex || fallback;
    if (!expression) {
      math.remove();
      continue;
    }
    const display = math.getAttribute("display") === "block";
    const token = `PIARXIVMATHTOKEN${mathReplacements.length}END`;
    mathReplacements.push(display ? `\n\n$$${expression}$$\n\n` : `$${expression}$`);
    math.replaceWith(document.createTextNode(token));
  }

  for (const image of root.querySelectorAll("img")) {
    const src = image.getAttribute("src");
    const alt = normalize(image.getAttribute("alt") ?? "") || "Figure image";
    const replacement = document.createElement("a");
    replacement.textContent = alt;
    if (src) replacement.setAttribute("href", src);
    image.replaceWith(replacement);
  }

  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  if (!includeLinks) {
    service.addRule("stripLinks", {
      filter: "a",
      replacement: (_content, node) => node.textContent ?? "",
    });
  }

  service.addRule("arxivFigure", {
    filter: "figure",
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });

  service.addRule("arxivCaption", {
    filter: "figcaption",
    replacement: (content) => `\n\n**${content.trim()}**\n\n`,
  });

  service.addRule("arxivTable", {
    filter: "table",
    replacement: (_content, node) => renderTable(node as HTMLTableElement, includeLinks),
  });

  let markdown = service.turndown(root.innerHTML);
  for (let index = 0; index < mathReplacements.length; index++) {
    markdown = markdown.replaceAll(`PIARXIVMATHTOKEN${index}END`, mathReplacements[index]);
  }
  markdown = markdown
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return { markdown, warnings: [...new Set(warnings)] };
}

function renderTable(table: HTMLTableElement, includeLinks: boolean): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  const cells = rows.map((row) => Array.from(row.children).filter((cell) => {
    const tag = cell.tagName.toLowerCase();
    return tag === "td" || tag === "th";
  }));
  const width = cells[0]?.length ?? 0;
  const simple = width > 0
    && cells.every((row) => row.length === width)
    && cells.flat().every((cell) => !cell.hasAttribute("rowspan") && !cell.hasAttribute("colspan") && !cell.querySelector("table"));

  if (!simple) {
    for (const element of table.querySelectorAll("script, style")) element.remove();
    for (const element of table.querySelectorAll("*")) {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.startsWith("on") || attribute.name === "style") element.removeAttribute(attribute.name);
      }
    }
    return `\n\n${table.outerHTML}\n\n`;
  }

  const inlineMarkdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  if (!includeLinks) {
    inlineMarkdown.addRule("stripLinks", {
      filter: "a",
      replacement: (_content, node) => node.textContent ?? "",
    });
  }
  const values = cells.map((row) => row.map((cell) => escapeCell(
    inlineMarkdown.turndown(cell.innerHTML).replace(/\s+/g, " ").trim(),
  )));
  const header = values[0];
  const body = values.slice(1);
  return [
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
