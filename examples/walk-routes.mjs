// EXAMPLE — adapt before reusing.
//
// walk-routes.mjs — visit a list of routes against a running dev server,
// collect console logs + network errors + a screenshot for each, then emit a
// Markdown cleanliness report to output/discovery-<ISO>.md.
//
// As-written this targets one specific dashboard's route list. Edit the
// ROUTES array below (or pass routes as CLI args) to use it against your app.
//
// Spawns clarify-mcp as a child process (JSON-RPC over stdio).
//
// Usage:
//   node examples/walk-routes.mjs               # walk default route list
//   node examples/walk-routes.mjs /work /chat   # walk only the given routes
//   CLARIFY_DASHBOARD_URL=https://... node examples/walk-routes.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_DIR = join(ROOT, "output");

const ORIGIN = process.env.CLARIFY_DASHBOARD_URL ?? "https://localhost:3000";

const DEFAULT_ROUTES = [
  "/",
  "/work",
  "/monitoring",
  "/quoxvault",
  "/organisation",
  "/ai-studio",
  "/governance",
  "/marketplace",
  "/platform",
  "/workflow-builder",
  "/chat",
  "/agents",
  "/memory",
  "/plugins",
  "/settings",
];

const routes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROUTES;

// ── MCP server process ─────────────────────────────────────────────────────

const proc = spawn("node", ["dist/server.js"], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = createInterface({ input: proc.stdout });
const pending = new Map();

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

let nextId = 1;

const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const notify = (method, params) =>
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const call = async (name, args = {}) => {
  const r = await send("tools/call", { name, arguments: args });
  if (r.result?.isError) {
    return { error: r.result.content?.[0]?.text ?? "unknown MCP error" };
  }
  const text = r.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : r.result;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Helpers ────────────────────────────────────────────────────────────────

/** Turn a route into a safe filename slug, e.g. "/" → "root", "/ai-studio" → "ai-studio" */
function slug(route) {
  const s = route.replace(/^\//, "") || "root";
  return s.replace(/[^a-zA-Z0-9-_]/g, "-");
}

/**
 * Replace ULID (26 Crockford base32) and UUID segments in a URL path with {id}.
 * Collapses similar endpoints across different resource IDs.
 */
function normalizeUrl(url) {
  return url
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "{id}")           // ULID
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "{id}"); // UUID
}

// ── Walk ───────────────────────────────────────────────────────────────────

const results = [];

async function walkRoute(route) {
  const url = `${ORIGIN}${route}`;
  const rec = {
    route,
    url,
    finalUrl: null,
    title: null,
    status: "ok",
    error: null,
    consoleEntries: [],
    networkErrors: [],
    domChildCount: null,
    screenshotPath: null,
  };

  try {
    // 1. Open the page
    const opened = await call("browser_open", { url });
    if (opened?.error) {
      rec.status = "error";
      rec.error = opened.error;
    } else {
      rec.finalUrl = opened?.url ?? url;
      rec.title = opened?.title ?? null;
    }

    // 2. Let SPA hydrate
    await sleep(2500);

    // 3. Console logs
    const cons = await call("browser_console_read");
    if (cons?.error) {
      rec.consoleEntries = [];
    } else {
      rec.consoleEntries = Array.isArray(cons) ? cons : (cons?.entries ?? []);
    }

    // 4. Network errors
    const net = await call("browser_network_errors");
    if (net?.error) {
      rec.networkErrors = [];
    } else {
      rec.networkErrors = Array.isArray(net) ? net : (net?.errors ?? net?.entries ?? []);
    }

    // 5. DOM sanity check
    const dom = await call("browser_dom_summary", { selector: "body" });
    if (!dom?.error) {
      rec.domChildCount = dom?.childCount ?? dom?.children ?? null;
    }

    // 6. Screenshot
    const shotName = `discovery-${slug(route)}`;
    const shot = await call("browser_screenshot", { name: shotName });
    if (!shot?.error) {
      rec.screenshotPath = shot?.path ?? shot?.file ?? `output/screenshots/${shotName}.png`;
    }
  } catch (err) {
    rec.status = "exception";
    rec.error = err.message ?? String(err);
  }

  return rec;
}

// ── Aggregation ────────────────────────────────────────────────────────────

function aggregateConsoleErrors(results) {
  const map = new Map(); // message → { count, type, routes, firstSeen }
  for (const rec of results) {
    for (const entry of rec.consoleEntries) {
      const type = entry.type ?? entry.level ?? "log";
      if (!["error", "warning", "pageerror", "warn"].includes(type)) continue;
      const msg = (entry.message ?? entry.text ?? "").trim();
      if (!msg) continue;
      if (!map.has(msg)) {
        map.set(msg, { count: 0, type, routes: [], firstSeen: entry.timestamp ?? entry.time ?? null });
      }
      const agg = map.get(msg);
      agg.count++;
      if (!agg.routes.includes(rec.route)) agg.routes.push(rec.route);
    }
  }
  return [...map.entries()]
    .map(([msg, v]) => ({ msg, ...v }))
    .sort((a, b) => b.count - a.count);
}

/** Returns true when a network error entry is an expected browser abort on a
 * streaming connection (SSE / WebSocket / long-poll) caused by page navigation.
 * These are noise, not real errors. */
function isAbortedStreaming(entry) {
  if (entry.errorText !== "net::ERR_ABORTED") return false;
  const url = entry.url ?? entry.path ?? "";
  return /\/(stream|events|sse)(\?|$)/.test(url);
}

function aggregateNetworkErrors(results) {
  const realMap = new Map();    // key → { count, routes, status, method, path }
  const streamMap = new Map();  // key → { count, routes, method, path }

  for (const rec of results) {
    for (const entry of rec.networkErrors) {
      const method = (entry.method ?? "GET").toUpperCase();
      const rawUrl = entry.url ?? entry.path ?? "";
      // Decode percent-encoding before normalizing so {id} stays readable
      let decoded = rawUrl;
      try { decoded = decodeURIComponent(rawUrl); } catch { /* leave as-is */ }
      const normalized = normalizeUrl(decoded);
      // Extract path only for the key
      let path = normalized;
      try { path = new URL(normalized).pathname + (new URL(normalized).search || ""); } catch { /* not a full URL */ }

      if (isAbortedStreaming(entry)) {
        const key = `${method} ${path} (aborted)`;
        if (!streamMap.has(key)) {
          streamMap.set(key, { count: 0, routes: [], method, path });
        }
        const agg = streamMap.get(key);
        agg.count++;
        if (!agg.routes.includes(rec.route)) agg.routes.push(rec.route);
      } else {
        const status = entry.status ?? entry.statusCode ?? "?";
        const key = `${method} ${path} (${status})`;
        if (!realMap.has(key)) {
          realMap.set(key, { count: 0, routes: [], status, method, path });
        }
        const agg = realMap.get(key);
        agg.count++;
        if (!agg.routes.includes(rec.route)) agg.routes.push(rec.route);
      }
    }
  }

  const real = [...realMap.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count);
  const streaming = [...streamMap.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count);

  return { real, streaming };
}

// ── Report builder ─────────────────────────────────────────────────────────

function buildReport(results, ts) {
  const totalConsoleErrors = results.reduce((s, r) =>
    s + r.consoleEntries.filter((e) => ["error", "warning", "pageerror", "warn"].includes(e.type ?? e.level ?? "")).length, 0);

  const aggConsole = aggregateConsoleErrors(results);
  const { real: aggNetwork, streaming: aggStreaming } = aggregateNetworkErrors(results);

  // Only real (non-streaming-abort) errors count toward the total.
  const totalNetworkErrors = aggNetwork.reduce((s, item) => s + item.count, 0);

  const lines = [];
  lines.push(`# Dashboard Console Cleanliness Report`);
  lines.push(`_Generated: ${ts} · Routes walked: ${results.length} · Total console errors: ${totalConsoleErrors} · Total network errors: ${totalNetworkErrors}_`);
  lines.push(``);

  // Summary table — network error column excludes streaming noise
  lines.push(`## Summary by route`);
  lines.push(`| Route | Final URL | Title | Console errors | Network errors | Screenshot |`);
  lines.push(`|---|---|---|---:|---:|---|`);
  for (const rec of results) {
    const consErrors = rec.consoleEntries.filter((e) =>
      ["error", "warning", "pageerror", "warn"].includes(e.type ?? e.level ?? "")).length;
    const netErrors = rec.networkErrors.filter((e) => !isAbortedStreaming(e)).length;
    const finalUrl = rec.finalUrl ? rec.finalUrl.replace(ORIGIN, "") : rec.route;
    // Sanitize title for markdown table cell (no newlines, capped length)
    const rawTitle = rec.title ?? (rec.error ? `ERROR (${rec.error.split("\n")[0].slice(0, 60)})` : "—");
    const title = rawTitle.replace(/\n/g, " ").replace(/\|/g, "\\|").slice(0, 80);
    const shot = rec.screenshotPath ?? "—";
    lines.push(`| ${rec.route} | ${finalUrl} | ${title} | ${consErrors} | ${netErrors} | ${shot} |`);
  }
  lines.push(``);

  // Console errors section
  lines.push(`## Console errors (deduped by message, sorted by frequency)`);
  if (aggConsole.length === 0) {
    lines.push(`_No console errors or warnings detected._`);
  } else {
    for (const item of aggConsole) {
      lines.push(``);
      lines.push(`### × ${item.count} — \`${item.msg.slice(0, 120)}\``);
      lines.push(`- Type: ${item.type}`);
      lines.push(`- Routes: ${item.routes.join(", ")}`);
      if (item.firstSeen) lines.push(`- First seen at: ${item.firstSeen}`);
    }
  }
  lines.push(``);

  // Network errors section (real errors only)
  lines.push(`## Network errors (deduped by \`\${method} \${url-template}\`, sorted by frequency)`);
  if (aggNetwork.length === 0) {
    lines.push(`_No network errors detected._`);
  } else {
    for (const item of aggNetwork) {
      lines.push(``);
      lines.push(`### × ${item.count} — \`${item.key}\``);
      lines.push(`- Routes: ${item.routes.join(", ")}`);
    }
  }
  lines.push(``);

  // Streaming noise section
  lines.push(`## Aborted streaming connections (noise — page navigated mid-stream)`);
  if (aggStreaming.length === 0) {
    lines.push(`_None detected._`);
  } else {
    for (const item of aggStreaming) {
      lines.push(``);
      lines.push(`### × ${item.count} — \`${item.key}\``);
      lines.push(`- Routes: ${item.routes.join(", ")}`);
    }
  }

  return {
    md: lines.join("\n"),
    totalConsoleErrors,
    totalNetworkErrors,
    aggConsole,
    aggNetwork,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // MCP handshake
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "discover", version: "0" },
  });
  notify("notifications/initialized");

  console.log(`[discover] origin: ${ORIGIN}`);
  console.log(`[discover] routes: ${routes.join(", ")}`);
  console.log();

  for (const route of routes) {
    process.stdout.write(`  walking ${route} ...`);
    const rec = await walkRoute(route);
    results.push(rec);
    const consErrors = rec.consoleEntries.filter((e) =>
      ["error", "warning", "pageerror", "warn"].includes(e.type ?? e.level ?? "")).length;
    const realNetErrors = rec.networkErrors.filter((e) => !isAbortedStreaming(e)).length;
    const streamingAborts = rec.networkErrors.length - realNetErrors;
    const streamNote = streamingAborts > 0 ? `, streaming aborts: ${streamingAborts}` : "";
    console.log(` done  (console errors: ${consErrors}, network errors: ${realNetErrors}${streamNote}${rec.error ? `, ERROR: ${rec.error}` : ""})`);
  }

  // Close browser
  await call("browser_close");

  // Build report
  const ts = new Date().toISOString();
  const { md, totalConsoleErrors, totalNetworkErrors, aggConsole, aggNetwork } = buildReport(results, ts);

  // Write markdown
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const reportPath = join(OUTPUT_DIR, `discovery-${ts.replace(/[:.]/g, "-")}.md`);
  writeFileSync(reportPath, md, "utf8");

  // Stdout summary
  console.log();
  console.log("═══════════════════════════════════════════════════════");
  console.log(" DASHBOARD CONSOLE CLEANLINESS REPORT");
  console.log("═══════════════════════════════════════════════════════");
  console.log(` Routes walked:        ${results.length}`);
  console.log(` Total console errors: ${totalConsoleErrors}`);
  console.log(` Total network errors: ${totalNetworkErrors}`);
  console.log(` Report:               ${reportPath}`);

  if (aggConsole.length) {
    console.log();
    console.log(" Top console errors:");
    for (const item of aggConsole.slice(0, 3)) {
      console.log(`   ×${item.count}  [${item.type}] ${item.msg.slice(0, 100)}`);
    }
  }

  if (aggNetwork.length) {
    console.log();
    console.log(" Top network errors:");
    for (const item of aggNetwork.slice(0, 3)) {
      console.log(`   ×${item.count}  ${item.key}`);
    }
  }

  console.log("═══════════════════════════════════════════════════════");

  proc.stdin.end();
  proc.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("[discover] FATAL:", err);
  proc.stdin.end();
  proc.kill();
  process.exit(1);
});
