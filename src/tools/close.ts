import { closeBrowser } from "../browser.js";
import { logEvidence } from "../evidence/logger.js";

export type CloseOutput = { closed: boolean };

export async function close(): Promise<CloseOutput> {
  const ts = new Date().toISOString();
  const result = await closeBrowser();

  await logEvidence({
    ts,
    tool: "browser_close",
    input: {},
    ok: true,
    summary: result.closed ? "closed browser session" : "no active session",
    screenshot: null,
    error: null,
  });

  return result;
}
