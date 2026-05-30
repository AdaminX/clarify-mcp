import { getState } from "../browser.js";
import { logEvidence } from "../evidence/logger.js";

export type InspectDomInput = { selector: string };

export type DomSummary = {
  found: boolean;
  tag: string | null;
  attributes: Record<string, string>;
  textPreview: string | null;
  textTruncated: boolean;
  childCount: number;
};

const TEXT_PREVIEW_MAX = 200;

export async function inspectDom(input: InspectDomInput): Promise<DomSummary> {
  const ts = new Date().toISOString();

  try {
    const state = getState();
    if (!state) {
      throw new Error("no active browser session — call browser_open first");
    }

    // Run the summary inside the page so we never serialize the full DOM
    // tree across the CDP boundary.
    const summary = await state.page.evaluate(
      ({ selector, max }) => {
        const el = document.querySelector(selector);
        if (!el) {
          return {
            found: false as const,
            tag: null,
            attributes: {} as Record<string, string>,
            textPreview: null as string | null,
            textTruncated: false,
            childCount: 0,
          };
        }
        const attrs: Record<string, string> = {};
        for (const attr of Array.from(el.attributes)) {
          attrs[attr.name] = attr.value;
        }
        const fullText = (el.textContent ?? "").trim().replace(/\s+/g, " ");
        const truncated = fullText.length > max;
        return {
          found: true as const,
          tag: el.tagName.toLowerCase(),
          attributes: attrs,
          textPreview: truncated ? fullText.slice(0, max) + "…" : fullText,
          textTruncated: truncated,
          childCount: el.children.length,
        };
      },
      { selector: input.selector, max: TEXT_PREVIEW_MAX },
    );

    await logEvidence({
      ts,
      tool: "browser_dom_summary",
      input,
      ok: true,
      summary: summary.found
        ? `${summary.tag} matched ${input.selector} (${summary.childCount} children)`
        : `no element matched ${input.selector}`,
      screenshot: null,
      error: null,
    });

    return summary;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await logEvidence({
      ts,
      tool: "browser_dom_summary",
      input,
      ok: false,
      summary: `dom inspection failed for ${input.selector}`,
      screenshot: null,
      error,
    });
    throw err;
  }
}
