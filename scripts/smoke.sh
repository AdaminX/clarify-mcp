#!/usr/bin/env bash
# End-to-end smoke test: drive the MCP server over stdio, exercise all 7 tools.
set -euo pipefail
cd "$(dirname "$0")/.."

REQUESTS=$(cat <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_open","arguments":{"url":"https://example.com"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_console_read","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_network_errors","arguments":{}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"browser_dom_summary","arguments":{"selector":"h1"}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"browser_eval_js","arguments":{"script":"return { ua: navigator.userAgent, title: document.title };"}}}
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser_screenshot","arguments":{"name":"smoke"}}}
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"browser_close","arguments":{}}}
EOF
)

# Pipe requests in, give the server a moment to flush, then close stdin.
{ echo "$REQUESTS"; sleep 5; } | node dist/server.js
