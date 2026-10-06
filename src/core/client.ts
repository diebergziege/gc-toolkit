import { TokenProvider } from "./auth.js";
import { loadCredentials } from "./credentials.js";
import { GctkError } from "./errors.js";
import type { Profile } from "./profiles.js";
import { apiBase } from "./regions.js";

type Fetch = typeof fetch;
export type QueryValue = string | number | boolean | Array<string | number | boolean>;
export type Query = Record<string, QueryValue | undefined>;

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  correlationId?: string;
}

export interface PagedResult {
  items: unknown[];
  pages: number;
  total?: number;
  /** True when max_items stopped paging before the API ran out of pages. */
  truncated: boolean;
}

export interface ClientOptions {
  source: "cli" | "mcp" | "ui";
  fetchImpl?: Fetch;
  tokens?: TokenProvider;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRIES = 3;
const MAX_PAGES = 100;

export function normalizeApiPath(input: string): { path: string; query: Query } {
  let raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    throw new GctkError("INVALID_PATH", "Pass an API path like /api/v2/routing/queues, not a full URL.");
  }
  if (!raw.startsWith("/")) raw = `/${raw}`;
  const url = new URL(raw, "http://placeholder");
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.startsWith("/api/v2/") || path.split("/").includes("..")) {
    throw new GctkError("INVALID_PATH", `"${input}" is not a Genesys Cloud /api/v2 path.`);
  }
  const query: Query = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : all[0]!;
  }
  return { path, query };
}

function buildQuery(query: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) params.append(k, String(item));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export class GenesysClient {
  private readonly fetchImpl: Fetch;
  private readonly tokens: TokenProvider;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly profile: Profile,
    opts: ClientOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tokens = opts.tokens ?? new TokenProvider(profile.region, () => loadCredentials(profile), this.fetchImpl);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T = unknown>(method: string, rawPath: string, query: Query = {}, body?: unknown, responseType: "json" | "text" = "json"): Promise<ApiResponse<T>> {
    const m = method.toUpperCase();
    const { path, query: inlineQuery } = normalizeApiPath(rawPath);
    const fullQuery = { ...inlineQuery, ...query };

    const url = `${apiBase(this.profile.region)}${path}${buildQuery(fullQuery)}`;
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.get();
      const res = await this.fetchImpl(url, {
        method: m,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: responseType === "text" ? "text/plain, */*" : "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const correlationId = res.headers.get("inin-correlation-id") ?? undefined;

      if (res.status === 401 && !authRetried) {
        authRetried = true;
        this.tokens.invalidate();
        continue;
      }
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
        continue;
      }

      const text = await res.text();
      let parsed: unknown = text;
      if (responseType === "json" || !res.ok) {
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          // non-JSON body, keep text
        }
      }
      if (!res.ok) throw httpError(m, path, res.status, parsed, correlationId);
      return { status: res.status, body: parsed as T, correlationId };
    }
  }

  get<T = unknown>(path: string, query: Query = {}): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path, query);
  }

  /** GET returning the raw response text (templates and other non-JSON content). */
  async getText(path: string, query: Query = {}): Promise<string> {
    return String((await this.request<string>("GET", path, query, undefined, "text")).body ?? "");
  }

  /**
   * Follows Genesys paging: nextUri, pageNumber/pageCount, or cursor. Returns
   * undefined when the response is not an entity listing.
   */
  async getAll(rawPath: string, query: Query = {}, maxItems = 500): Promise<{ first: ApiResponse; paged?: PagedResult }> {
    const { path, query: inlineQuery } = normalizeApiPath(rawPath);
    let q: Query = { ...inlineQuery, ...query };
    const first = await this.get<Record<string, unknown>>(path, q);
    if (!first.body || !Array.isArray(first.body.entities)) return { first };

    const items: unknown[] = [...(first.body.entities as unknown[])];
    let page = first.body;
    let pages = 1;
    let exhausted = false;
    while (items.length < maxItems && pages < MAX_PAGES) {
      const next = nextPage(path, q, page);
      if (!next) {
        exhausted = true;
        break;
      }
      q = next;
      const res = await this.get<Record<string, unknown>>(path, q);
      page = res.body;
      pages++;
      const entities = Array.isArray(page?.entities) ? (page.entities as unknown[]) : [];
      if (entities.length === 0) {
        exhausted = true;
        break;
      }
      items.push(...entities);
    }
    const total = typeof first.body.total === "number" ? first.body.total : undefined;
    const truncated = !exhausted && (items.length >= maxItems || pages >= MAX_PAGES);
    return { first, paged: { items: items.slice(0, maxItems), pages, total, truncated } };
  }
}

function nextPage(path: string, q: Query, page: Record<string, unknown>): Query | undefined {
  if (typeof page.nextUri === "string" && page.nextUri) {
    const next = normalizeApiPath(page.nextUri);
    // nextUri must stay on the same resource; never follow it elsewhere.
    if (next.path !== path) return undefined;
    return next.query;
  }
  const pageNumber = Number(page.pageNumber ?? q.pageNumber ?? 1);
  if (typeof page.pageCount === "number" && pageNumber < page.pageCount) {
    return { ...q, pageNumber: pageNumber + 1 };
  }
  if (typeof page.cursor === "string" && page.cursor && page.cursor !== q.cursor) {
    return { ...q, cursor: page.cursor };
  }
  if (typeof page.after === "string" && page.after && page.after !== q.after) {
    return { ...q, after: page.after };
  }
  return undefined;
}

function httpError(method: string, path: string, status: number, body: unknown, correlationId?: string): GctkError {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const message = typeof b.message === "string" ? b.message : typeof body === "string" ? body.slice(0, 300) : "";
  const code = typeof b.code === "string" ? ` [${b.code}]` : "";
  const hints: Record<number, string> = {
    400: "Check the request against the endpoint schema in the Genesys Cloud API docs.",
    403: "The OAuth client's role lacks a permission or division access.",
    404: "The object does not exist, or it lives in a division the client cannot see.",
  };
  return new GctkError(
    `HTTP_${status}`,
    `${method} ${path} failed${code}: ${message}${correlationId ? ` (correlation id ${correlationId})` : ""}`,
    hints[status],
  );
}
