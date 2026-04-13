// Converts an OpenAPI operation into:
//   1. An MCP tool descriptor (name, description, inputSchema as JSON Schema)
//   2. An invoker that takes the parsed args and dispatches via PylonClient
//
// Tool name format: pylon_<snake_case_operationId>, e.g. CreateArticle -> pylon_create_article.
// Input shape: a single object with a property per path/query param plus a `body` property
// (if the operation has a request body). This keeps the schema flat and lets MCP clients
// introspect required fields easily.

import type { JsonSchema, OpenApiOperation, OpenApiSpec, ResolvedEndpoint } from "./openapi-loader.js";
import { deref } from "./openapi-loader.js";
import type { PylonClient } from "./pylon-client.js";

export interface BuiltTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
}

function camelToSnake(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function inferAnnotations(method: string): BuiltTool["annotations"] {
  const m = method.toUpperCase();
  return {
    readOnlyHint: m === "GET",
    destructiveHint: m === "DELETE",
    // PUT and DELETE are idempotent by HTTP semantics; PATCH/POST generally are not
    idempotentHint: m === "GET" || m === "PUT" || m === "DELETE",
    openWorldHint: true, // Pylon is an external service whose state changes outside our control
  };
}

function buildInputSchema(op: OpenApiOperation, spec: OpenApiSpec): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const param of op.parameters ?? []) {
    if (param.in !== "path" && param.in !== "query") continue;
    const schema: JsonSchema = param.schema ? deref(param.schema, spec) : { type: "string" };
    if (param.description) schema.description = param.description;
    properties[param.name] = schema;
    if (param.required) required.push(param.name);
  }

  const bodySchemaRaw = op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchemaRaw) {
    const bodySchema = deref(bodySchemaRaw, spec);
    properties.body = {
      ...bodySchema,
      description:
        (bodySchema.description as string | undefined) ??
        "JSON request body for this operation.",
    };
    if (op.requestBody?.required) required.push("body");
  }

  return {
    type: "object",
    properties,
    required: required.length ? required : undefined,
    additionalProperties: false,
  };
}

function substitutePath(
  pathTemplate: string,
  args: Record<string, unknown>,
  pathParamNames: string[],
): string {
  let path = pathTemplate;
  for (const name of pathParamNames) {
    const val = args[name];
    if (val === undefined || val === null || val === "") {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(val)));
  }
  return path;
}

export function buildTool(
  endpoint: ResolvedEndpoint,
  spec: OpenApiSpec,
  client: PylonClient,
): BuiltTool {
  const { path, method, operation } = endpoint;
  const opId = operation.operationId ?? `${method}_${path}`;
  const name = `pylon_${camelToSnake(opId)}`;

  const summary = operation.summary?.trim() ?? "";
  const desc = operation.description?.trim() ?? "";
  const description = [
    summary,
    desc,
    `\n[${method.toUpperCase()} ${path}]`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 1024);

  const inputSchema = buildInputSchema(operation, spec);
  const annotations = inferAnnotations(method);

  const pathParamNames = (operation.parameters ?? [])
    .filter((p) => p.in === "path")
    .map((p) => p.name);
  const queryParamNames = (operation.parameters ?? [])
    .filter((p) => p.in === "query")
    .map((p) => p.name);

  const invoke = async (args: Record<string, unknown>): Promise<unknown> => {
    const resolvedPath = substitutePath(path, args, pathParamNames);
    const query: Record<string, string | number | boolean | undefined> = {};
    for (const q of queryParamNames) {
      const v = args[q];
      if (v !== undefined && v !== null) {
        query[q] = v as string | number | boolean;
      }
    }
    const body = "body" in args ? args.body : undefined;
    return client.request({
      method,
      path: resolvedPath,
      query: Object.keys(query).length ? query : undefined,
      body,
    });
  };

  return { name, description, inputSchema, annotations, invoke };
}
