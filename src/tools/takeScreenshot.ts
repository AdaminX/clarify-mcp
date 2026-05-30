import { join } from "node:path";
import { getState } from "../browser.js";
import { getScreenshotsDir, logEvidence } from "../evidence/logger.js";

export type TakeScreenshotInput = { name: string };
export type TakeScreenshotOutput = { path: string };

export async function takeScreenshot(
  input: TakeScreenshotInput,
): Promise<TakeScreenshotOutput> {
  const ts = new Date().toISOString();

  try {
    const state = getState();
    if (!state) {
      throw new Error("no active browser session — call browser_open first");
    }

    // Sanitize so callers can't escape the screenshots directory.
    const safeName = input.name.replace(/[^a-zA-Z0-9_-]/g, "_") || "screenshot";
    const stamp = ts.replace(/[:.]/g, "-");
    const path = join(getScreenshotsDir(), `${safeName}-${stamp}.png`);

    await state.page.screenshot({ path, fullPage: true });

    await logEvidence({
      ts,
      tool: "browser_screenshot",
      input,
      ok: true,
      summary: `saved screenshot to ${path}`,
      screenshot: path,
      error: null,
    });

    return { path };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await logEvidence({
      ts,
      tool: "browser_screenshot",
      input,
      ok: false,
      summary: `screenshot failed`,
      screenshot: null,
      error,
    });
    throw err;
  }
}
