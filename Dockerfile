# clarity-mcp container image.
#
# Used by registries that verify MCP servers in CI (e.g. Glama) by booting the
# server and sending an MCP initialize + tools/list handshake over stdio.
#
# Built on the Playwright base image so Chromium is already installed —
# clarity-mcp launches a disposable headless Chromium for every session.

FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Install dependencies (including dev deps — we need tsc to compile).
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund

# Compile the TypeScript server.
COPY src ./src
RUN npm run build

# clarity-mcp speaks MCP over stdio. There is no port to expose.
CMD ["node", "dist/server.js"]
