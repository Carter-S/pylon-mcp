// Loads the bundled Pylon OpenAPI spec and provides $ref dereferencing.
// Pylon's spec uses local refs only (#/components/schemas/...), so a simple
// in-memory walker is sufficient — no need for a heavy dereferencer dependency.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface OpenApiOperation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export type JsonSchema = Record<string, unknown> & {
  $ref?: string;
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
};

export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, JsonSchema> };
}

export interface ResolvedEndpoint {
  path: string;
  method: string;
  operation: OpenApiOperation;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedSpec: OpenApiSpec | null = null;

export function loadSpec(): OpenApiSpec {
  if (cachedSpec) return cachedSpec;
  const specPath = join(__dirname, "openapi.json");
  const raw = readFileSync(specPath, "utf-8");
  cachedSpec = JSON.parse(raw) as OpenApiSpec;
  return cachedSpec;
}

/**
 * Recursively dereference all $ref pointers in a JSON Schema using the spec's
 * components.schemas map. Pylon only uses local refs so this is safe.
 *
 * Cycle protection: if a schema references itself (directly or transitively),
 * we replace the inner ref with `{}` to avoid infinite recursion. MCP clients
 * tolerate untyped object schemas — Pylon's spec doesn't have many cycles.
 */
export function deref(
  schema: JsonSchema | undefined,
  spec: OpenApiSpec,
  seen: Set<string> = new Set(),
): JsonSchema {
  if (!schema) return {};
  if (typeof schema !== "object") return schema;

  if (schema.$ref && typeof schema.$ref === "string") {
    const refName = schema.$ref.replace("#/components/schemas/", "");
    if (seen.has(refName)) return {}; // cycle break
    const target = spec.components.schemas[refName];
    if (!target) return {};
    return deref(target, spec, new Set([...seen, refName]));
  }

  // Generic deep walk: dereference $refs wherever they appear (properties,
  // items, additionalProperties, patternProperties, not, if/then/else, $defs,
  // oneOf/anyOf/allOf, …) so no raw "#/components/schemas/…" ref can survive
  // into the emitted tool schema — local grammar engines (vLLM xgrammar/
  // guidance) reject unresolved refs. Data-bearing keys are copied verbatim.
  const DATA_KEYS = new Set([
    "enum", "required", "default", "example", "examples", "const",
  ]);
  const SCHEMA_MAP_KEYS = new Set([
    "properties", "patternProperties", "$defs", "definitions",
  ]);

  const out: JsonSchema = {};
  for (const [key, val] of Object.entries(schema)) {
    if (val == null) continue;
    if (key.startsWith("x-")) continue; // drop vendor extensions
    if (DATA_KEYS.has(key)) {
      out[key] = val; // arbitrary data, not a schema
    } else if (SCHEMA_MAP_KEYS.has(key) && typeof val === "object" && !Array.isArray(val)) {
      const m: Record<string, JsonSchema> = {};
      for (const [n, s] of Object.entries(val as Record<string, JsonSchema>)) {
        m[n] = deref(s, spec, seen);
      }
      out[key] = m;
    } else if (Array.isArray(val)) {
      out[key] = val.map((v) => (v && typeof v === "object" ? deref(v as JsonSchema, spec, seen) : v));
    } else if (typeof val === "object") {
      out[key] = deref(val as JsonSchema, spec, seen);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export function listEndpoints(spec: OpenApiSpec): ResolvedEndpoint[] {
  const endpoints: ResolvedEndpoint[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (method.startsWith("x-")) continue;
      endpoints.push({ path, method: method.toLowerCase(), operation: op });
    }
  }
  return endpoints;
}
