# pylon-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

An [MCP](https://modelcontextprotocol.io) server exposing the **full** [Pylon](https://usepylon.com) API as Claude tools — auto-generated from Pylon's OpenAPI spec, so **all 114 endpoints** are available, including knowledge base article CRUD, custom objects, macros, training data, audit logs, and everything else.

## Why this exists

Existing Pylon MCP integrations are limited:

- The **hosted Anthropic Pylon connector** exposes only ~11 tools (issues, accounts, contacts) and cannot create or update knowledge base articles.
- Other community wrappers tend to hand-roll a small subset of endpoints, or sit behind a paywall.

This server is open-source, free, and stays in sync with Pylon's API automatically — drop in a new `openapi.json`, rebuild, and every new endpoint becomes a tool.

## Features

- **Complete coverage** — every operation in Pylon's OpenAPI spec is exposed as a tool
- **Strict input schemas** — generated directly from the spec, so MCP clients can validate before calling
- **Helpful errors** — Pylon API errors come back with status, body, and hints (`401` → bad token, `429` → rate limit, etc.)
- **Smart annotations** — read-only and destructive operations are flagged so clients can prompt for confirmation
- **Tiny footprint** — single npm dependency (`@modelcontextprotocol/sdk`), native `fetch`, no transitive bloat
- **Easy to update** — refresh the bundled OpenAPI spec and rebuild; no code changes needed when Pylon ships new endpoints

## Install

```bash
git clone https://github.com/Carter-S/pylon-mcp.git
cd pylon-mcp
npm install
npm run build
```

This produces an executable at `dist/index.js`.

## Configure

1. Generate a Pylon API token at <https://app.usepylon.com/settings/api-keys>.
2. Add the server to your MCP client config.

### Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "pylon": {
      "command": "node",
      "args": ["/absolute/path/to/pylon-mcp/dist/index.js"],
      "env": {
        "PYLON_API_TOKEN": "ptk_..."
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

Same shape — under `mcpServers.pylon`. Restart the host app after editing.

### Cursor / other MCP clients

Any MCP-compatible client that supports stdio servers will work — point it at `node /absolute/path/to/pylon-mcp/dist/index.js` with `PYLON_API_TOKEN` in the environment.

## Tool naming

Every Pylon operation becomes a tool named `pylon_<snake_case_operationId>`:

| Operation | Tool name |
|---|---|
| Create KB article | `pylon_create_article` |
| Update KB article | `pylon_update_article` |
| Delete KB article | `pylon_delete_article` |
| List articles | `pylon_get_articles` |
| Create issue | `pylon_create_issue` |
| Search issues | `pylon_search_issues` |
| Get current org | `pylon_get_me` |
| Upload training data | `pylon_upload_training_data_file_content` |

Run `tools/list` against the server to enumerate all 114.

## Tool input shape

Each tool accepts a single object:

- One property per **path** parameter (e.g. `id`)
- One property per **query** parameter (e.g. `cursor`, `limit`)
- A `body` property containing the JSON payload (when the endpoint has a request body)

Required fields are enforced via the JSON Schema sent to the MCP client.

Example call to `pylon_create_article`:

```json
{
  "id": "kb_abc123",
  "body": {
    "title": "How to reset your password",
    "body_html": "<p>Click the reset link...</p>",
    "author_user_id": "usr_xyz789",
    "is_published": true
  }
}
```

## Architecture

```
src/
├── index.ts            # stdio MCP server, registers all tools
├── openapi.json        # bundled Pylon OpenAPI 3.0 spec (source of truth)
├── openapi-loader.ts   # loads spec, dereferences $ref pointers, breaks cycles
├── pylon-client.ts     # thin fetch-based HTTP client with bearer auth
└── tool-builder.ts     # converts each OpenAPI operation into an MCP tool
```

The build step (`npm run build`) compiles TypeScript and copies `openapi.json` into `dist/` alongside the compiled JS.

## Updating Pylon's API surface

When Pylon ships new endpoints, refresh the spec:

```bash
curl -sL https://static.usepylon.com/openapi.json -o src/openapi.json
npm run build
```

No code changes needed — new tools appear automatically on next launch.

## Error handling

The server surfaces Pylon API errors back to the MCP client with status code, response body, and remediation hints:

- **401** — `PYLON_API_TOKEN` is invalid or expired
- **403** — token lacks permission for this resource
- **404** — the resource does not exist (verify the ID)
- **422** — required field is missing or malformed (check the tool's `inputSchema`)
- **429** — rate limited; back off and retry

Per-endpoint rate limits are documented in each tool's description, pulled directly from Pylon's spec.

## Development

```bash
npm run dev        # run from source via tsx
npm run typecheck  # tsc --noEmit
npm run build      # compile to dist/
```

## Contributing

PRs welcome. The codebase is intentionally small — most contributions will land in `tool-builder.ts` (input shape changes) or `pylon-client.ts` (transport changes). Adding new tools is a no-op: refresh the OpenAPI spec instead.

## License

[MIT](LICENSE)
