import { describe, expect, it, vi } from "vitest";
import { TokenProvider } from "../src/core/auth.js";
import { GenesysClient, normalizeApiPath } from "../src/core/client.js";
import type { Profile } from "../src/core/profiles.js";

const profile: Profile = {
  name: "test-de",
  region: "mypurecloud.de",
  tier: "production",
  credentials: "env",
};

type Handler = (url: URL, init: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> };

function setup(handler: Handler) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith("login.")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400 }), { status: 200 });
    }
    calls.push(`${init.method} ${url.pathname}${url.search}`);
    const r = handler(url, init);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  const tokens = new TokenProvider(profile.region, () => ({ clientId: "id", clientSecret: "secret" }), fetchImpl);
  const client = new GenesysClient(profile, { source: "mcp", fetchImpl, tokens, sleep: async () => {} });
  return { client, calls };
}

describe("normalizeApiPath", () => {
  it("accepts paths with query strings and rejects full URLs and traversal", () => {
    expect(normalizeApiPath("/api/v2/flows?name=a&type=b&type=c")).toEqual({ path: "/api/v2/flows", query: { name: "a", type: ["b", "c"] } });
    expect(normalizeApiPath("api/v2/flows/")).toEqual({ path: "/api/v2/flows", query: {} });
    expect(() => normalizeApiPath("https://evil.example/api/v2/flows")).toThrow(/full URL/);
    expect(() => normalizeApiPath("/api/v1/flows")).toThrow(/api\/v2/);
  });
});

describe("GenesysClient", () => {
  it("sends writes to the org", async () => {
    const { client, calls } = setup(() => ({ body: { id: "q1" } }));
    expect((await client.request("POST", "/api/v2/routing/queues", {}, { name: "Sales" })).body).toEqual({ id: "q1" });
    expect(calls).toEqual(["POST /api/v2/routing/queues"]);
  });

  it("retries 429 using Retry-After and re-auths once on 401", async () => {
    let n = 0;
    const { client, calls } = setup(() => {
      n++;
      if (n === 1) return { status: 429, headers: { "retry-after": "1" }, body: {} };
      if (n === 2) return { status: 401, body: {} };
      return { body: { ok: true } };
    });
    const res = await client.get("/api/v2/organizations/me");
    expect(res.body).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it("turns 403 into an error with a permission hint", async () => {
    const { client } = setup(() => ({ status: 403, body: { message: "Missing permission", code: "missing.permissions" } }));
    await expect(client.get("/api/v2/routing/queues")).rejects.toMatchObject({ code: "HTTP_403", hint: expect.stringMatching(/permission/) });
  });

  it("follows nextUri paging and stops at max_items", async () => {
    const { client, calls } = setup((url) => {
      const page = Number(url.searchParams.get("pageNumber") ?? 1);
      return {
        body: {
          entities: [{ id: `q${page}a` }, { id: `q${page}b` }],
          pageNumber: page,
          pageCount: 5,
          total: 10,
          nextUri: page < 5 ? `/api/v2/routing/queues?pageSize=2&pageNumber=${page + 1}` : undefined,
        },
      };
    });
    const all = await client.getAll("/api/v2/routing/queues", { pageSize: 2 }, 100);
    expect(all.paged?.items).toHaveLength(10);
    expect(all.paged?.truncated).toBe(false);
    expect(calls).toHaveLength(5);

    const some = await client.getAll("/api/v2/routing/queues", { pageSize: 2 }, 3);
    expect(some.paged?.items).toHaveLength(3);
    expect(some.paged?.truncated).toBe(true);
  });

  it("falls back to pageNumber/pageCount and to cursor paging", async () => {
    const byNumber = setup((url) => {
      const page = Number(url.searchParams.get("pageNumber") ?? 1);
      return { body: { entities: [{ id: page }], pageNumber: page, pageCount: 3 } };
    });
    expect((await byNumber.client.getAll("/api/v2/flows")).paged?.items).toHaveLength(3);

    const byCursor = setup((url) => {
      const c = url.searchParams.get("cursor");
      return { body: { entities: [{ id: c ?? "start" }], cursor: c === "c2" ? undefined : c === "c1" ? "c2" : "c1" } };
    });
    expect((await byCursor.client.getAll("/api/v2/externalcontacts/contacts")).paged?.items).toHaveLength(3);
  });

  it("never follows a nextUri to a different resource", async () => {
    const { client, calls } = setup(() => ({ body: { entities: [{ id: 1 }], nextUri: "/api/v2/users?pageNumber=2" } }));
    const res = await client.getAll("/api/v2/routing/queues");
    expect(res.paged?.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("returns non-listing responses unpaged", async () => {
    const { client } = setup(() => ({ body: { id: "org", name: "Org" } }));
    const res = await client.getAll("/api/v2/organizations/me");
    expect(res.paged).toBeUndefined();
    expect(res.first.body).toEqual({ id: "org", name: "Org" });
  });
});
