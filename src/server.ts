#!/usr/bin/env node
//
// clarify-mcp — local MCP server.
//
// Wiring overview:
//   1. We construct a `Server` from @modelcontextprotocol/sdk and declare
//      the `tools` capability. This tells the MCP client (Claude Code) that
//      we expose callable tools.
//   2. We register two request handlers:
//        - `tools/list`  → returns the static catalogue of tool definitions
//                          (name, description, JSON Schema input).
//        - `tools/call`  → dispatches to the matching tool handler.
//   3. We connect over stdio. Claude Code spawns this process and talks to
//      it via stdin/stdout — that's all the transport we need locally.
//   4. On SIGINT/SIGTERM we close the Playwright browser cleanly so we
//      don't leak temp profiles.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { openPage } from "./tools/openPage.js";
import { getConsoleLogs } from "./tools/getConsoleLogs.js";
import { getNetworkErrors } from "./tools/getNetworkErrors.js";
import { inspectDom } from "./tools/inspectDom.js";
import { takeScreenshot } from "./tools/takeScreenshot.js";
import { evaluateJs } from "./tools/evaluateJs.js";
import { close } from "./tools/close.js";
import { closeBrowser } from "./browser.js";

// ---------------------------------------------------------------------------
// Tool catalogue. Each entry's `inputSchema` is plain JSON Schema (not Zod);
// the SDK forwards it to the client unchanged so Claude can render the tool
// signature.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "browser_open",
    description:
      "Launch the headless browser if not running, navigate to a URL, and " +
      "return basic page info. Default wait mode is 'load' — fits SPAs that " +
      "poll forever and would never reach 'networkidle'. Override with " +
      "waitUntil='networkidle' for static pages where idle is meaningful.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to navigate to." },
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle", "commit"],
          description:
            "Playwright wait mode. Default 'load'. Use 'networkidle' only for static pages.",
        },
        timeoutMs: {
          type: "number",
          description: "Navigation timeout in ms. Default 15000.",
        },
        extraWaitMs: {
          type: "number",
          description:
            "Additional ms to wait AFTER navigation returns, before reading. Default 0. Use ~2500 for SPAs that hydrate after `load`.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_console_read",
    description:
      "Return console messages (log/info/warn/error/pageerror) collected " +
      "since the most recent browser_open call.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_network_errors",
    description:
      "Return failed requests and non-2xx/3xx responses observed since " +
      "the most recent browser_open call.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_dom_summary",
    description:
      "Return a concise summary of the first element matching a CSS " +
      "selector — tag, attributes, text preview (truncated), child count. " +
      "Never dumps the full DOM tree.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector." },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Take a full-page PNG screenshot, save it under output/screenshots/, " +
      "and return the absolute path.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Short label used in the filename. Non-alphanumeric chars are " +
            "replaced with underscores.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_eval_js",
    description:
      "DANGEROUS. Execute arbitrary JavaScript in the page context and " +
      "return the result. The script is logged verbatim to evidence.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "JS source. May use return statements.",
        },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_close",
    description: "Close the browser session and clean up its temp profile.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Dispatcher — given a tool name and raw args, run the handler and return
// its result wrapped in MCP's content envelope.
// ---------------------------------------------------------------------------

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  browser_open: (args) =>
    openPage(
      args as {
        url: string;
        waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
        timeoutMs?: number;
        extraWaitMs?: number;
      },
    ),
  browser_console_read: () => getConsoleLogs(),
  browser_network_errors: () => getNetworkErrors(),
  browser_dom_summary: (args) => inspectDom(args as { selector: string }),
  browser_screenshot: (args) => takeScreenshot(args as { name: string }),
  browser_eval_js: (args) => evaluateJs(args as { script: string }),
  browser_close: () => close(),
};

const server = new Server(
  { name: "clarify-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ ...t })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${name}` }],
    };
  }
  try {
    const result = await handler((args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  // Best-effort browser cleanup. Any errors here are written to stderr and
  // swallowed — we still want to exit.
  try {
    await closeBrowser();
  } catch (err) {
    process.stderr.write(`shutdown: closeBrowser failed: ${String(err)}\n`);
  }
  process.stderr.write(`clarify-mcp: received ${signal}, exiting.\n`);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("clarify-mcp: ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`clarify-mcp: fatal: ${String(err)}\n`);
  process.exit(1);
});
