// Thin HTTP client for the Pylon API.
// Uses native fetch (Node >= 18). Auth via bearer token from PYLON_API_TOKEN.

const BASE_URL = "https://api.usepylon.com";

export class PylonError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    public readonly path: string,
  ) {
    super(`Pylon API ${status} ${statusText} on ${path}: ${body}`);
    this.name = "PylonError";
  }
}

export interface PylonRequest {
  method: string;
  path: string; // already-substituted path, e.g. /issues/abc-123
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class PylonClient {
  constructor(private readonly token: string) {
    if (!token) {
      throw new Error(
        "PYLON_API_TOKEN is required. Get one at: https://app.usepylon.com/settings/api-keys",
      );
    }
  }

  async request({ method, path, query, body }: PylonRequest): Promise<unknown> {
    const url = new URL(path, BASE_URL);
    if (query) {
      for (const [key, val] of Object.entries(query)) {
        if (val !== undefined && val !== null) url.searchParams.set(key, String(val));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    let bodyStr: string | undefined;
    if (body !== undefined && body !== null) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers,
      body: bodyStr,
    });

    const text = await res.text();

    if (!res.ok) {
      throw new PylonError(res.status, res.statusText, text, url.pathname);
    }

    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
