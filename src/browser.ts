// Singleton browser session. We keep one Playwright Browser + Context alive
// across MCP tool calls so that console/network listeners keep accumulating
// between calls — otherwise each tool would have to re-launch and re-navigate.
//
// Auth: if `output/storage-state.json` exists, we load it into the new context
// so the page starts already authenticated. The state file is gitignored.
// See `src/auth.ts` for the form-login helper, or `examples/` for project-
// specific bootstrap recipes.

import { chromium, type Browser, type BrowserContext, type Page, type ConsoleMessage } from "playwright";
import { getStorageStatePath, hasStorageState, saveStorageState } from "./auth.js";

export type ConsoleEntry = {
  type: string;
  text: string;
  timestamp: string;
};

export type NetworkErrorEntry = {
  url: string;
  method: string;
  status: number | null;
  errorText: string;
};

type BrowserState = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  consoleLogs: ConsoleEntry[];
  networkErrors: NetworkErrorEntry[];
};

let state: BrowserState | null = null;

function attachListeners(page: Page, ctx: BrowserState): void {
  page.on("console", (msg: ConsoleMessage) => {
    ctx.consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      timestamp: new Date().toISOString(),
    });
  });

  page.on("pageerror", (err) => {
    ctx.consoleLogs.push({
      type: "pageerror",
      text: err.message,
      timestamp: new Date().toISOString(),
    });
  });

  page.on("requestfailed", (req) => {
    ctx.networkErrors.push({
      url: req.url(),
      method: req.method(),
      status: null,
      errorText: req.failure()?.errorText ?? "request failed",
    });
  });

  page.on("response", (resp) => {
    const status = resp.status();
    if (status >= 400) {
      ctx.networkErrors.push({
        url: resp.url(),
        method: resp.request().method(),
        status,
        errorText: resp.statusText() || `HTTP ${status}`,
      });
    }
  });
}

export async function ensureBrowser(): Promise<BrowserState> {
  if (state) return state;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-default-browser-check", "--no-first-run"],
  });

  const context = await browser.newContext({
    // Local dev servers regularly run with self-signed certs (Vite + HTTPS,
    // dashboard nginx, etc). The whole point of this tool is to inspect them.
    ignoreHTTPSErrors: true,
    // Load saved auth (cookies + localStorage) if setup-auth.mjs has run.
    ...(hasStorageState() ? { storageState: getStorageStatePath() } : {}),
  });

  const page = await context.newPage();

  const newState: BrowserState = {
    browser,
    context,
    page,
    consoleLogs: [],
    networkErrors: [],
  };
  attachListeners(page, newState);

  state = newState;
  return state;
}

export function getState(): BrowserState | null {
  return state;
}

export async function persistStorageState(): Promise<void> {
  if (!state) return;
  await saveStorageState(state.context);
}

export async function closeBrowser(): Promise<{ closed: boolean }> {
  if (!state) return { closed: false };
  const { browser } = state;
  state = null;
  await browser.close().catch(() => {});
  return { closed: true };
}

// Reset console/network buffers when the user navigates to a new page so
// that browser_console_read returns "messages since this page load",
// matching the spec.
export function resetBuffers(): void {
  if (!state) return;
  state.consoleLogs.length = 0;
  state.networkErrors.length = 0;
}

// Return a snapshot of the network error buffer accumulated since the last
// resetBuffers() call. Used by openPage to inspect 401 cascades without
// clearing the buffer.
export function getRecentNetworkErrors(): readonly NetworkErrorEntry[] {
  return state?.networkErrors ?? [];
}
