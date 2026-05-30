// End-to-end smoke test: drive the MCP server over stdio, one request at a
// time, waiting for each response before sending the next. Mirrors how a
// real MCP client (Claude Code) drives the server.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const proc = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const rl = createInterface({ input: proc.stdout });

const pending = new Map();
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { console.error("non-json:", line); return; }
  if (msg.id != null && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function unwrap(resp, label) {
  if (resp.error) {
    console.log(`✗ ${label}: ERROR`, resp.error);
    return null;
  }
  if (resp.result?.isError) {
    console.log(`✗ ${label}: TOOL ERROR`, resp.result.content);
    return null;
  }
  const text = resp.result?.content?.[0]?.text;
  const parsed = text ? JSON.parse(text) : resp.result;
  console.log(`✓ ${label}:`, JSON.stringify(parsed));
  return parsed;
}

async function main() {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  notify("notifications/initialized");

  unwrap(await send("tools/call", { name: "browser_open", arguments: { url: "https://example.com" } }), "browser_open");
  unwrap(await send("tools/call", { name: "browser_console_read", arguments: {} }), "browser_console_read");
  unwrap(await send("tools/call", { name: "browser_network_errors", arguments: {} }), "browser_network_errors");
  unwrap(await send("tools/call", { name: "browser_dom_summary", arguments: { selector: "h1" } }), "browser_dom_summary");
  unwrap(await send("tools/call", { name: "browser_eval_js", arguments: { script: "return { ua: navigator.userAgent.slice(0,40), title: document.title };" } }), "browser_eval_js");
  unwrap(await send("tools/call", { name: "browser_screenshot", arguments: { name: "smoke" } }), "browser_screenshot");
  unwrap(await send("tools/call", { name: "browser_close", arguments: {} }), "browser_close");

  proc.stdin.end();
  proc.kill();
  process.exit(0);
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
