import { getState, type NetworkErrorEntry } from "../browser.js";
import { logEvidence } from "../evidence/logger.js";

export type GetNetworkErrorsOutput = { errors: NetworkErrorEntry[] };

export async function getNetworkErrors(): Promise<GetNetworkErrorsOutput> {
  const ts = new Date().toISOString();
  const state = getState();
  const errors = state ? [...state.networkErrors] : [];

  await logEvidence({
    ts,
    tool: "browser_network_errors",
    input: {},
    ok: true,
    summary: state
      ? `returned ${errors.length} network error${errors.length === 1 ? "" : "s"}`
      : "no active browser session",
    screenshot: null,
    error: null,
  });

  return { errors };
}
