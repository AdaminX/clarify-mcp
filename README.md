# clarify-mcp

<p align="center">
  <img src="assets/hero.png" alt="clarify-mcp" width="720" />
</p>

**Stop telling Claude what's on your screen. Let it look.**

If you've used Claude Code on a frontend bug, you know the loop:

> **Claude:** Can you paste the console output?
> **You:** *(switches tabs, copies, pastes)*
> **Claude:** Can you check if the request returned a 200?
> **You:** *(switches tabs, opens network panel, screenshots)*
> **Claude:** What does the modal say when it renders?
> **You:** It doesn't render. That's the bug.

`clarify-mcp` ends that loop. It's a tiny local MCP server that gives Claude its own headless browser — so when you say *"the page is broken,"* Claude opens it, reads the console, checks the network tab, and tells **you** what's wrong. You stop being a copy-paste proxy. Bug fixes get faster. Your attention stays on what you were doing.

It runs locally, talks to Claude over stdio (no ports open), uses a disposable Chromium profile that never touches your real Chrome — and every tool call is logged to a file you can audit. About 1,000 lines of TypeScript on top of Playwright. That's the whole thing.

---

## What you actually get

Seven tools that show up in any Claude Code session on your machine:

- **`browser_open`** — Claude points it at a URL, it navigates, waits for the page to settle.
- **`browser_console_read`** — every console log, warning, error, and uncaught exception since the page loaded.
- **`browser_network_errors`** — failed requests and anything with a 4xx/5xx status.
- **`browser_dom_summary`** — element exists? what attributes? what text? (Never dumps a giant DOM tree — keeps Claude's context window cheap.)
- **`browser_screenshot`** — full-page PNG, saved to disk, path returned.
- **`browser_eval_js`** — run a JS expression on the page. Powerful and dangerous; we'll talk about it.
- **`browser_close`** — clean up.

That's it. No clicking, no typing, no form-filling (yet). The whole point is *inspect, don't drive* — because the moment you let an LLM drive a browser, you've created a much bigger surface to worry about. We deliberately stayed on the safe side of that line.

---

## Why it's actually safe

Three things to know up front:

**1. The browser it spawns is not your browser.** Every session creates a fresh Chromium profile in your system temp directory and deletes it when the session ends. It cannot see your real Chrome cookies, your saved passwords, your extensions, your tabs, your history. It's a clean room every time.

**2. The server doesn't open a port.** Communication with Claude Code happens over stdin/stdout — the same pipe Claude uses to spawn it. Nothing on your network can talk to clarify-mcp. There's nothing to expose.

**3. The one dangerous tool is flagged as dangerous.** `browser_eval_js` runs arbitrary JavaScript in the page. That's genuinely risky on a sensitive site (it could read localStorage, fire requests, exfiltrate things). So: **every** call is appended verbatim to `output/evidence.jsonl` before the result returns. If logging fails, the call fails. You have a tamper-evident record of every line of JS Claude ran. Don't point this at your bank.

---

## Install — 90 seconds

```bash
git clone https://github.com/AdaminX/clarify-mcp.git
cd clarify-mcp
npm install
npm run build
npx playwright install chromium
```

Then tell Claude Code about it:

```bash
claude mcp add -s user clarify-mcp node /absolute/path/to/clarify-mcp/dist/server.js
```

`claude mcp list` should show `✓ Connected`. Open a **new** Claude Code session (existing ones won't pick it up until you restart them — MCP servers register at session boot).

Requires Node 20+. That's the only system dependency.

## Try it

In a new Claude Code session, paste something like:

> Open `https://example.com`, take a screenshot called "example", and tell me anything unusual on the page.

Or, for a local dev server:

> The dev server is on `http://localhost:3000` and the homepage looks broken. Open it, check the console and network tab, and tell me what you find.

If it worked, you'll see Claude announce what it's doing (`🔍 CLARIFY: Inspecting ...`) and come back with actual evidence instead of guesses.

---

## The hidden half: rules for Claude

Here's the part most people miss. **The tools are only half the value.** The other half is making Claude *use them* instead of reverting to the old habit of asking you to copy-paste the console.

Drop the following into your project's `CLAUDE.md` (or your user-scope `~/.claude/CLAUDE.md`). These are the rules we use in-house. Without them, Claude will sometimes still default to *"can you check?"* — because that's what it learned to do before clarify-mcp existed.

````markdown
### Live Browser State (clarify-mcp)

For **any quick runtime question** about a local dev page, your default move is `clarify-mcp` — not grep, not "can you check?", not guessing. If the answer lives in DevTools and would take two seconds to look up there, look it up directly.

**Use clarify-mcp first when:**
- User reports "the page is blank / broken / not loading / stuck"
- User reports a visual bug, layout issue, or rendering glitch
- You need console errors, network failures, pageerror traces, or HTTP status codes
- You need localStorage / sessionStorage / cookie state at runtime
- You need computed styles, DOM structure, or element attributes on a live page
- You're about to ask the user "what does the page say?", "what URL did you land on?", "what's in your console?", "did the request succeed?", "is the modal rendered?", "what's the response body?" — answer it yourself instead
- You're verifying a fix on a UI/runtime change before claiming it works
- You're about to write a guess about what the page is doing — get evidence first

**Skip clarify-mcp only when:**
- The bug is purely in code logic — read the code instead
- The dev server isn't running locally (note this and ask)
- The page is behind auth you don't have credentials for (note the redirect to `/login`, ask the user how they'd like to proceed)

**ANNOUNCE when using it.** Output `🔍 CLARIFY: Inspecting <url>` before the call so the user sees it being used.

**Before asking the user to test, name the blocker.** No "can you test this?" / "can you check the page?" / "does the modal show up?" — ever — unless you have first either (a) used clarify-mcp and reported what you saw, or (b) explicitly stated which of the "Skip clarify-mcp" conditions applies *to this specific case*. "I'd rather you test it" is not a reason. "Faster if you check" is not a reason. The user testing is the fallback, not the default. If you skip, the skip reason goes in the message before the question.

**`browser_eval_js` is the dangerous tool.** It runs arbitrary JS in the page context. Default to read-only inspections (`localStorage`, computed styles, `document.querySelector` reads). Don't use it to mutate state, fire requests, or clear storage without asking the user first. Every call is logged verbatim to `clarify-mcp/output/evidence.jsonl`.

**Bug-fix protocol — visual/UI bugs.** Gather evidence with clarify-mcp *before* proposing a cause. Screenshot, console, network errors, and computed styles via `browser_eval_js`. Check `::before`/`::after` pseudo-elements and z-index stacking contexts — wrapper-blame without checking pseudo-elements is a common dead-end. State your hypothesis explicitly *before* changing code: "I think X is the cause because Y." If you can't write that sentence with evidence-backed Y, gather more.

**Caveat — MCP servers register at session boot.** A session that started before clarify-mcp was registered won't see the tools; only fresh sessions do. If you don't see `browser_*` in your tool list, start a new Claude Code session.
````

The load-bearing line is **"before asking the user to test, name the blocker."** Without that, Claude drifts back to "can you check?" by default. With it, Claude only kicks the question to you when there's a *specific* reason it can't look itself — and tells you which reason.

Tighten or relax the rest to fit your team.

---

## Tools reference

| Tool | Input | Returns |
|---|---|---|
| `browser_open` | `{ url }` | `{ title, url, statusCode }` — launches if needed, navigates, waits for network idle (30s timeout). Resets console/network buffers. |
| `browser_console_read` | `{}` | `{ logs: [{ type, text, timestamp }] }` — every console message + uncaught error since the last `browser_open`. |
| `browser_network_errors` | `{}` | `{ errors: [{ url, method, status, errorText }] }` — failed requests and any response with status ≥ 400. |
| `browser_dom_summary` | `{ selector }` | `{ found, tag, attributes, textPreview, textTruncated, childCount }` — never dumps the full subtree. Text preview capped at 200 chars. |
| `browser_screenshot` | `{ name }` | `{ path }` — full-page PNG saved to `output/screenshots/<name>-<iso>.png`. |
| `browser_eval_js` | `{ script }` | `{ result }` — runs the script wrapped in an IIFE, JSON-coerces the return value. **DANGEROUS.** |
| `browser_close` | `{}` | `{ closed }` — closes the browser and removes the temp profile. |

---

## Optional: persistent login

If the site requires auth, clarify-mcp can save a Playwright `storageState` so `browser_open` starts already logged in.

1. Copy `.env.local.example` → `.env.local` and fill in `CLARIFY_DASHBOARD_URL`, `CLARIFY_EMAIL`, `CLARIFY_PASSWORD`.
2. Write a one-time bootstrap that logs in via the UI and calls `saveStorageState()` from `src/auth.ts`. See `examples/setup-auth-quox.mjs` for a working reference (specific to one product — treat it as a recipe to adapt).
3. After that, `browser_open` loads the saved state automatically. If it expires and the page redirects to `/login`, clarify-mcp detects the redirect, fills the form via `loginViaForm()`, saves fresh state, and re-navigates. The response includes `{ reauthenticated: true }` so callers know it happened.

The selectors in `src/auth.ts` are intentionally generic (`input[type="email"]`, etc.) so they work against most login pages. Override them in a fork if your form is bespoke.

---

## Evidence log

Every tool call appends one JSON line to `output/evidence.jsonl`:

```json
{"ts":"2026-05-10T15:00:00.000Z","tool":"browser_open","input":{"url":"http://localhost:3000"},"ok":true,"summary":"navigated to http://localhost:3000/ (status 200)","screenshot":null,"error":null}
```

Logging is **fail-closed**: if the JSONL write throws, the tool throws too. You never get a success without a durable record. The log is gitignored.

---

## Layout

```
src/
  server.ts                # MCP wiring
  browser.ts               # Playwright lifecycle + console/network listeners
  auth.ts                  # Optional form-login + storage-state helpers
  tools/                   # One file per MCP tool
  evidence/logger.ts       # JSONL append (fail-closed)
scripts/
  smoke.mjs                # End-to-end stdio smoke test against the built server
  inspect.mjs              # Drive all 7 tools sequentially against a URL
  check-storage.mjs        # Print saved storageState contents
examples/
  setup-auth-quox.mjs      # Example: project-specific auth bootstrap (Quox)
  walk-routes.mjs          # Example: visit a list of routes, collect a report
output/                    # gitignored
  screenshots/
  evidence.jsonl
  storage-state.json
```

## Development

```bash
npm run dev      # tsc --watch
npm run build    # one-shot compile
npm start        # run the built server (mostly for testing — Claude spawns it for you)
npm run smoke    # end-to-end stdio smoke test
npm run inspect -- https://example.com
```

---

## Roadmap

Seven primitives covers the inspect-while-debugging case well. The natural next steps, in rough order:

- **Interaction tools** — fill, click, wait-for-selector. Crosses the inspect/drive line, so it gets its own opt-in.
- **Richer network capture** — request/response bodies, HAR export. Useful for backend-to-frontend debugging where the network panel is the whole story.
- **Playwright trace export** — scrub a session in the trace viewer.

None of those are in scope right now. PRs welcome if you have a use that justifies a new primitive.

## Why not just use Playwright MCP / browser-tools-mcp?

Fair question. Other MCP servers in this space do more — they click, type, navigate flows, sometimes attach to your real browser. That's the right choice if you want Claude to *operate* a browser as an agent.

`clarify-mcp` is the opposite bet: the smallest tool surface that solves the *"stop guessing about my dev page"* problem, with the safest possible defaults (disposable profile, no port, fail-closed audit log) and a set of rules that actually change Claude's behavior. If you mostly debug local dev pages and want Claude to look at them without it turning into a security review, this is the one. If you want Claude to fill checkout forms, look elsewhere.

## License

MIT — see `LICENSE`.
