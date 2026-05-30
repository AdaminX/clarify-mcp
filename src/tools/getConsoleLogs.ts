import { getState, type ConsoleEntry } from "../browser.js";
import { logEvidence } from "../evidence/logger.js";

export type GetConsoleLogsOutput = { logs: ConsoleEntry[] };

export async function getConsoleLogs(): Promise<GetConsoleLogsOutput> {
  const ts = new Date().toISOString();
  const state = getState();
  const logs = state ? [...state.consoleLogs] : [];

  await logEvidence({
    ts,
    tool: "browser_console_read",
    input: {},
    ok: true,
    summary: state
      ? `returned ${logs.length} console entr${logs.length === 1 ? "y" : "ies"}`
      : "no active browser session",
    screenshot: null,
    error: null,
  });

  return { logs };
}
