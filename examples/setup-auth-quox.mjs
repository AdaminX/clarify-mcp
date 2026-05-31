#!/usr/bin/env node
// EXAMPLE — product-specific. Adapt before reusing.
//
// One-time auth bootstrap for clarify-mcp, written against the Quox dashboard
// (https://github.com/quoxai). It's here as a reference for how to wire up
// persistent login to YOUR app — the shape generalises even though the
// signup/login flow doesn't.
//
// What it does:
//   1. Reads CLARIFY_EMAIL / CLARIFY_PASSWORD / CLARIFY_DASHBOARD_URL from
//      .env.local (or env). If creds are missing, generates a stable demo
//      user and writes them back to .env.local.
//   2. Uses the `quox --insecure` CLI to signup → login → org-create →
//      org-switch → re-login. THIS PART IS PRODUCT-SPECIFIC. Replace with
//      whatever signup/login your API exposes, or skip if you already have
//      a user.
//   3. Drives Playwright through the dashboard's email/password form so
//      cookies and localStorage land in the persistent state.
//   4. Saves Playwright storageState to output/storage-state.json. From here
//      on, every clarify-mcp browser_open will start authenticated.
//
// Idempotent: if the user already exists, signup fails harmlessly and we
// continue. If the org already exists, we just switch into it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_LOCAL = join(ROOT, ".env.local");
const STORAGE_STATE = join(ROOT, "output", "storage-state.json");

// ---------- env handling ----------
function readEnvLocal() {
  if (!existsSync(ENV_LOCAL)) return {};
  const out = {};
  for (const raw of readFileSync(ENV_LOCAL, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

function writeEnvLocal(values) {
  const merged = { ...readEnvLocal(), ...values };
  const body = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(ENV_LOCAL, body, { mode: 0o600 });
}

const fileEnv = readEnvLocal();
const env = (k, fallback) => process.env[k] ?? fileEnv[k] ?? fallback;

let email = env("CLARIFY_EMAIL");
let password = env("CLARIFY_PASSWORD");
const dashboardUrl = env("CLARIFY_DASHBOARD_URL", "https://localhost:3000");

if (!email || !password) {
  // Stable, identifiable, single-user demo account.
  email = `clarify-mcp-${process.pid}-${Date.now()}@quox.local`;
  password = "ClarifyMCP-2026!";
  console.log(`[setup-auth] no creds in env/.env.local — generated ${email}`);
}

writeEnvLocal({
  CLARIFY_EMAIL: email,
  CLARIFY_PASSWORD: password,
  CLARIFY_DASHBOARD_URL: dashboardUrl,
});
console.log(`[setup-auth] creds saved to ${ENV_LOCAL} (mode 0600)`);

// ---------- quox CLI helpers ----------
function quox(args, { allowFail = false } = {}) {
  const r = spawnSync("quox", ["--insecure", ...args], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0 && !allowFail) {
    throw new Error(`quox ${args.join(" ")} failed:\n${out}`);
  }
  return { code: r.status, out };
}

// signup is allowed to fail (account may already exist).
{
  console.log(`[setup-auth] quox signup ${email} (ok if already exists)`);
  const { code, out } = quox(
    ["signup", "--email", email, "--password", password, "--name", "Clarify MCP"],
    { allowFail: true },
  );
  if (code !== 0) console.log(`[setup-auth]   ↳ signup non-zero (likely exists): ${out.trim().split("\n").slice(-3).join(" | ")}`);
}

console.log(`[setup-auth] quox login ${email}`);
quox(["login", "--email", email, "--password", password]);

// org create — also allowed to fail if it exists.
const slug = (email.split("@")[0] || "clarify").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
{
  console.log(`[setup-auth] quox org create ${slug} (ok if already exists)`);
  const { code } = quox(
    ["org", "create", "--name", "Clarify MCP", "--slug", slug],
    { allowFail: true },
  );
  if (code !== 0) console.log(`[setup-auth]   ↳ org create non-zero (likely exists)`);
}

console.log(`[setup-auth] quox org list → pick first, switch`);
const { out: orgListJson } = quox(["--json", "org", "list"]);
let orgId = null;
try {
  const orgs = JSON.parse(orgListJson);
  orgId = orgs?.[0]?.id ?? null;
} catch {
  /* fall through */
}
if (orgId) {
  quox(["org", "switch", orgId]);
  console.log(`[setup-auth]   ↳ switched to org ${orgId}`);
} else {
  console.log("[setup-auth]   ↳ no orgs returned; dashboard may handle this fine");
}

console.log(`[setup-auth] quox login (re-login for org-aware JWT)`);
quox(["login", "--email", email, "--password", password]);

// ---------- Playwright form login + storageState save ----------
console.log(`[setup-auth] launching headless chromium → ${dashboardUrl}/login`);
const browser = await chromium.launch({ headless: true, args: ["--no-first-run"] });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

try {
  await page.goto(`${dashboardUrl}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1500);

  // dismiss cookie banner best-effort
  for (const sel of [
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("Necessary Only")',
    'button:has-text("Got it")',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 400 })) { await btn.click({ timeout: 1500 }); break; }
    } catch { /* continue */ }
  }

  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Sign in")').first().click();

  await page
    .waitForURL((u) => !/\/(login|signin|auth)\b/.test(u.pathname), { timeout: 20_000 })
    .catch(() => {});
  await page.waitForSelector('nav, [role="navigation"], aside, [data-testid="sidebar"]', { timeout: 20_000 });

  console.log(`[setup-auth] logged in. URL=${page.url()}`);

  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  await context.storageState({ path: STORAGE_STATE });
  console.log(`[setup-auth] storage state saved → ${STORAGE_STATE}`);
} catch (err) {
  console.error(`[setup-auth] FAILED: ${err.message ?? err}`);
  console.error(`[setup-auth] page URL was: ${page.url()}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

console.log(`[setup-auth] done.`);
