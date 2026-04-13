#!/usr/bin/env node
// Entrypoint: stdio MCP server exposing every Pylon API endpoint as a tool.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { listEndpoints, loadSpec } from "./openapi-loader.js";
import { PylonClient, PylonError } from "./pylon-client.js";
import { buildTool, type BuiltTool } from "./tool-builder.js";

async function main(): Promise<void> {
  const token = process.env.PYLON_API_TOKEN;
  if (!token) {
    console.error(
      "ERROR: PYLON_API_TOKEN environment variable is required.\n" +
        "Generate one at https://app.usepylon.com/settings/api-keys",
    );
    process.exit(1);
  }

  const spec = loadSpec();
  const client = new PylonClient(token);
  const endpoints = listEndpoints(spec);

  const tools: BuiltTool[] = endpoints.map((ep) => buildTool(ep, spec, client));
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  // Detect collisions defensively (should not happen with stable operationIds)
  if (toolByName.size !== tools.length) {
    const counts = new Map<string, number>();
    for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    throw new Error(`Duplicate tool names generated from OpenAPI spec: ${dupes.join(", ")}`);
  }

  const server = new Server(
    {
      name: "pylon-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolByName.get(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }],
      };
    }

    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await tool.invoke(args);
      return {
        content: [
          {
            type: "text" as const,
            text: result == null ? "(no content)" : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof PylonError) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Pylon API error ${err.status} ${err.statusText} on ${err.path}.\n` +
                `Response body: ${err.body}\n\n` +
                `Hints:\n` +
                `- 401: PYLON_API_TOKEN is invalid or expired.\n` +
                `- 403: token lacks permission for this resource.\n` +
                `- 404: the resource does not exist — verify the ID.\n` +
                `- 422: required field is missing or malformed; check the tool's inputSchema.\n` +
                `- 429: rate limited — back off and retry.`,
            },
          ],
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Tool call failed: ${msg}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[pylon-mcp] ready — registered ${tools.length} Pylon tools (stdio transport)`,
  );
}

main().catch((err) => {
  console.error("[pylon-mcp] fatal:", err);
  process.exit(1);
});
