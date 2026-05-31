// Form-login + persisted-session helpers for clarify-mcp.
//
// Two surfaces:
//   1. `saveStorageState` / `getStorageStatePath` — persist Playwright's
//      cookie + localStorage state to disk so the singleton browser starts
//      already logged-in across MCP sessions.
//   2. `loginViaForm` — drive a generic email/password login form. Used by
//      one-time bootstrap scripts and the auto-relogin path inside
//      `browser_open` when the saved state has expired.
//
// Selectors are deliberately generic (`input[type="email"]`, etc.) so this
// works against most off-the-shelf login pages. Override SEL_* in a fork
// if your form uses bespoke selectors.

import type { BrowserContext, Page } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(here, "..");
const STORAGE_STATE_PATH = join(PROJECT_ROOT, "output", "storage-state.json");
const ENV_LOCAL_PATH = join(PROJECT_ROOT, ".env.local");

export type AuthCreds = {
  dashboardUrl: string;
  email: string;
  password: string;
};

/** Read .env.local KEY=VALUE pairs into process.env (lazy, idempotent). */
let envLoaded = false;
export function loadEnvLocal(): void {
  if (envLoaded) return;
  envLoaded = true;
  if (!existsSync(ENV_LOCAL_PATH)) return;
  const text = readFileSync(ENV_LOCAL_PATH, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function readCreds(): AuthCreds | null {
  loadEnvLocal();
  const email = process.env.CLARIFY_EMAIL;
  const password = process.env.CLARIFY_PASSWORD;
  const dashboardUrl =
    process.env.CLARIFY_DASHBOARD_URL ?? "https://localhost:3000";
  if (!email || !password) return null;
  return { dashboardUrl, email, password };
}

export function getStorageStatePath(): string {
  return STORAGE_STATE_PATH;
}

export function hasStorageState(): boolean {
  return existsSync(STORAGE_STATE_PATH);
}

export async function saveStorageState(context: BrowserContext): Promise<void> {
  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
  await context.storageState({ path: STORAGE_STATE_PATH });
}

// Generic login-form selectors. Override in a fork if your app differs.
const SEL_EMAIL = 'input[type="email"]';
const SEL_PASSWORD = 'input[type="password"]';
const SEL_SUBMIT =
  'button[type="submit"], button:has-text("Sign In"), button:has-text("Sign in")';
const SEL_POST_LOGIN =
  'nav, [role="navigation"], aside, [data-testid="sidebar"]';
const COOKIE_BUTTONS = [
  'button:has-text("Accept All")',
  'button:has-text("Accept")',
  'button:has-text("Necessary Only")',
  'button:has-text("Reject")',
  'button:has-text("Got it")',
  '[aria-label*="cookie" i] button',
];

async function dismissCookieBanner(page: Page): Promise<void> {
  for (const sel of COOKIE_BUTTONS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ timeout: 1500 });
        return;
      }
    } catch {
      /* keep trying */
    }
  }
}

/** Path-only check: is this URL a login/auth surface? */
export function isLoginPath(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    return /\/(login|signin|auth)\b/.test(p);
  } catch {
    return false;
  }
}

/**
 * Drive the login form on whatever page is currently loaded. Caller is
 * responsible for navigating to the login URL first. Throws if the login
 * surface is still showing 15 s after submit.
 */
export async function loginViaForm(
  page: Page,
  creds: AuthCreds,
): Promise<void> {
  await dismissCookieBanner(page);

  const email = page.locator(SEL_EMAIL).first();
  const pw = page.locator(SEL_PASSWORD).first();
  await email.waitFor({ state: "visible", timeout: 15_000 });
  await email.fill(creds.email);
  await pw.fill(creds.password);

  await page.locator(SEL_SUBMIT).first().click();

  await page
    .waitForURL((u) => !/\/(login|signin|auth)\b/.test(u.pathname), {
      timeout: 15_000,
    })
    .catch(() => {});

  await page.waitForSelector(SEL_POST_LOGIN, { timeout: 15_000 });
}

export function writeEnvLocal(values: Record<string, string>): void {
  // Preserve existing keys; overwrite ones we own; add new ones.
  const existing: Record<string, string> = {};
  if (existsSync(ENV_LOCAL_PATH)) {
    for (const raw of readFileSync(ENV_LOCAL_PATH, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      existing[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  const merged = { ...existing, ...values };
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(ENV_LOCAL_PATH, body, { mode: 0o600 });
}
