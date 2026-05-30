// Drive clarity-mcp from the host shell (since the running Claude session
// can't load the MCP server itself — MCP servers register at session start).
// Usage:  node scripts/inspect.mjs <url>
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const url = process.argv[2];
if (!url) { console.error("usage: node scripts/inspect.mjs <url>"); process.exit(2); }

const proc = spawn("node", ["dist/server.js"], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: proc.stdout });
const pending = new Map();
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});

let nextId = 1;
const send = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) =>
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const call = async (name, args = {}) => {
  const r = await send("tools/call", { name, arguments: args });
  if (r.result?.isError) {
    return { error: r.result.content?.[0]?.text };
  }
  const text = r.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : r.result;
};

const print = (label, data) => {
  console.log(`\n── ${label} ──`);
  console.log(JSON.stringify(data, null, 2));
};

async function main() {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "inspect", version: "0" },
  });
  notify("notifications/initialized");

  print("browser_open", await call("browser_open", { url }));
  // Give SPAs a moment for client-side hydration / lazy chunks.
  await new Promise((r) => setTimeout(r, 2500));

  print("browser_console_read", await call("browser_console_read"));
  print("browser_network_errors", await call("browser_network_errors"));
  print("browser_dom_summary body", await call("browser_dom_summary", { selector: "body" }));
  print("browser_dom_summary #root or main", await call("browser_dom_summary", { selector: "#root, main, [data-app]" }));

  print("page state via eval_js", await call("browser_eval_js", {
    script: `
      return {
        url: location.href,
        title: document.title,
        viewport: { w: innerWidth, h: innerHeight },
        readyState: document.readyState,
        h1: Array.from(document.querySelectorAll('h1, h2')).slice(0, 5).map(e => e.textContent.trim()).filter(Boolean),
        rootChildren: document.querySelector('#root')?.children?.length ?? null,
        localStorageKeys: Object.keys(localStorage),
        sessionStorageKeys: Object.keys(sessionStorage),
        cookies: document.cookie.split(';').map(s => s.trim().split('=')[0]).filter(Boolean),
        scriptCount: document.scripts.length,
        stylesheetCount: document.styleSheets.length,
        fontFaces: (document.fonts ? Array.from(document.fonts).slice(0,5).map(f => f.family) : []),
      };
    `
  }));

  print("browser_screenshot", await call("browser_screenshot", { name: "dashboard-landing" }));
  print("browser_close", await call("browser_close"));

  proc.stdin.end();
  proc.kill();
  process.exit(0);
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
