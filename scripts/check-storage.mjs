// Open the dashboard, log in via storageState, navigate twice, dump sessionStorage
// to confirm whether the unavailability cache actually persists across navigations.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const proc = spawn("node", ["dist/server.js"], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: proc.stdout });
const pending = new Map();
rl.on("line", (l) => { if (!l.trim()) return; const m = JSON.parse(l); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });

let nextId = 1;
const send = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) =>
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const call = async (n, a={}) => {
  const r = await send("tools/call", { name: n, arguments: a });
  if (r.result?.isError) return { error: r.result.content[0].text };
  return JSON.parse(r.result.content[0].text);
};

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } });
notify("notifications/initialized");

console.log("=== open / ===");
console.log(await call("browser_open", { url: "https://localhost:3000/" }));
await new Promise(r => setTimeout(r, 5000));
console.log("--- sessionStorage after / ---");
console.log(await call("browser_eval_js", { script: "return JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)));" }));

console.log("=== open /work ===");
console.log(await call("browser_open", { url: "https://localhost:3000/work" }));
await new Promise(r => setTimeout(r, 5000));
console.log("--- sessionStorage after /work ---");
console.log(await call("browser_eval_js", { script: "return JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)));" }));

await call("browser_close");
proc.stdin.end(); proc.kill(); process.exit(0);
