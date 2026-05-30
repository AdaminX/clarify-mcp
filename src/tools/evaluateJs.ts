// DANGER ZONE.
// browser_eval_js executes arbitrary JavaScript in the page context. There
// are no allowlists or sandboxes — the script can read storage, mutate the
// DOM, fire requests, anything. We log the script verbatim so the JSONL
// trail is the durable receipt of what ran.

import { getState } from "../browser.js";
import { logEvidence } from "../evidence/logger.js";

export type EvaluateJsInput = { script: string };
export type EvaluateJsOutput = { result: unknown };

export async function evaluateJs(
  input: EvaluateJsInput,
): Promise<EvaluateJsOutput> {
  const ts = new Date().toISOString();

  try {
    const state = getState();
    if (!state) {
      throw new Error("no active browser session — call browser_open first");
    }

    // Wrap in an async IIFE so the caller can use both `return` and
    // top-level `await fetch(...)` / `await page.something()` naturally —
    // most useful inspections need to await something. Sync IIFE was the
    // original wrapper but kept rejecting `await is only valid in async
    // functions` for very common probes.
    const wrapped = `(async () => { ${input.script} })()`;
    const raw = await state.page.evaluate(wrapped);

    // Some return values (functions, DOM nodes, circular refs) won't survive
    // structured-clone serialization. Coerce to a JSON-safe shape.
    let result: unknown;
    try {
      result = JSON.parse(JSON.stringify(raw));
    } catch {
      result = String(raw);
    }

    await logEvidence({
      ts,
      tool: "browser_eval_js",
      input,
      ok: true,
      summary: `executed script (${input.script.length} chars)`,
      screenshot: null,
      error: null,
    });

    return { result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await logEvidence({
      ts,
      tool: "browser_eval_js",
      input,
      ok: false,
      summary: `script execution failed`,
      screenshot: null,
      error,
    });
    throw err;
  }
}
