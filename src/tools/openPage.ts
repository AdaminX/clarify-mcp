import { ensureBrowser, getRecentNetworkErrors, persistStorageState, resetBuffers } from "../browser.js";
import {
  isLoginPath,
  loginViaForm,
  readCreds,
} from "../auth.js";
import { logEvidence } from "../evidence/logger.js";

export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

export type OpenPageInput = {
  url: string;
  waitUntil?: WaitUntil;
  timeoutMs?: number;
  // Additional ms to wait AFTER navigation returns, before reading. Default 0.
  // Use ~2500 for SPAs that hydrate after `load`.
  extraWaitMs?: number;
};

export type OpenPageOutput = {
  title: string;
  url: string;
  statusCode: number | null;
  // Surfaced when storageState was stale and we silently re-logged the user
  // in. The caller can ignore this; it's purely informational so debugging
  // sessions know auth was refreshed.
  reauthenticated?: boolean;
};

// SPAs that poll on a timer (heartbeat, inbox stream, agent registry refresh,
// etc.) will *never* reach Playwright's `networkidle` state. Default to `load`
// so navigation actually returns. Caller can opt into `networkidle` for static
// pages where it's meaningful.
const DEFAULT_WAIT_UNTIL: WaitUntil = "load";
const DEFAULT_TIMEOUT_MS = 15_000;

// Number of /api/auth/me 401 responses in the current page load that
// constitute a "stale auth" signal, even when the page didn't redirect to
// /login (i.e. cached localStorage state masks the expired cookie).
// Lower → more sensitive (more false positives); higher → less sensitive.
const AUTH_ME_401_THRESHOLD = 3;

async function navigate(input: OpenPageInput) {
  const { page } = await ensureBrowser();
  resetBuffers();
  const response = await page.goto(input.url, {
    waitUntil: input.waitUntil ?? DEFAULT_WAIT_UNTIL,
    timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (input.extraWaitMs && input.extraWaitMs > 0) {
    await new Promise((r) => setTimeout(r, input.extraWaitMs));
  }
  return { page, response };
}

export async function openPage(input: OpenPageInput): Promise<OpenPageOutput> {
  const ts = new Date().toISOString();
  try {
    let { page, response } = await navigate(input);
    let reauthenticated = false;

    // The dashboard auto-redirects unauthenticated users to /login. If we
    // landed on a login surface despite asking for something else, attempt
    // to refresh auth using saved creds. If the caller actually requested a
    // /login URL, we trust them and don't try to authenticate.
    if (isLoginPath(page.url()) && !isLoginPath(input.url)) {
      const creds = readCreds();
      if (creds) {
        await loginViaForm(page, creds);
        await persistStorageState();
        reauthenticated = true;
        // Re-navigate to the originally requested URL now that we're in.
        ({ page, response } = await navigate(input));
      }
    }

    // 401 cascade detection: the page may render from cached localStorage state
    // but have an expired cookie, causing all /api/auth/me calls to return 401.
    // We don't get a /login redirect in this case — detect it via the network
    // error buffer and re-authenticate proactively.
    if (!reauthenticated && !isLoginPath(input.url)) {
      const authMe401Count = getRecentNetworkErrors().filter(
        (e) => e.status === 401 && e.url.includes("/api/auth/me"),
      ).length;
      if (authMe401Count >= AUTH_ME_401_THRESHOLD) {
        const creds = readCreds();
        if (creds) {
          await loginViaForm(page, creds);
          await persistStorageState();
          reauthenticated = true;
          ({ page, response } = await navigate(input));
        }
      }
    }

    const out: OpenPageOutput = {
      title: await page.title(),
      url: page.url(),
      statusCode: response?.status() ?? null,
      ...(reauthenticated ? { reauthenticated: true } : {}),
    };

    await logEvidence({
      ts,
      tool: "browser_open",
      input,
      ok: true,
      summary: `navigated to ${out.url} (status ${out.statusCode ?? "n/a"})${
        reauthenticated ? " — reauthenticated mid-flow" : ""
      }`,
      screenshot: null,
      error: null,
    });

    return out;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await logEvidence({
      ts,
      tool: "browser_open",
      input,
      ok: false,
      summary: `failed to open ${input.url}`,
      screenshot: null,
      error,
    });
    throw err;
  }
}
