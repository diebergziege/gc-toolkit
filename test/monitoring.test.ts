import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenProvider } from "../src/core/auth.js";
import { GenesysClient } from "../src/core/client.js";
import { levelFor, MONITOR_GROUPS, MONITOR_METRICS, monitorOrg, type MonitorMetric } from "../src/core/monitoring.js";
import { saveProfile, type Profile } from "../src/core/profiles.js";

let home: string;
let calls: Array<{ method: string; path: string; query: string; body?: unknown }>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-mon-"));
  process.env.GCTK_HOME = home;
  calls = [];
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(routes: Record<string, (url: URL, body: unknown) => Response>): GenesysClient {
  const p: Profile = { name: "mon", region: "euw2.pure.cloud", tier: "production", credentials: "env" };
  saveProfile(p);
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith("login.")) return json({ access_token: "t", expires_in: 3600 });
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, query: url.search, body });
    const handler = routes[`${method} ${url.pathname}`];
    return handler ? handler(url, body) : json({ message: "not found" }, 404);
  }) as typeof fetch;
  return new GenesysClient(p, { source: "ui", fetchImpl, tokens: new TokenProvider(p.region, () => ({ clientId: "a", clientSecret: "b" }), fetchImpl) });
}

const metric = (m: Partial<MonitorMetric> & Pick<MonitorMetric, "id" | "count">): MonitorMetric => ({ label: m.id, group: "Other", permissions: [], ...m });

describe("monitoring", () => {
  it("counts from totals and compares with the org's own limit", async () => {
    const c = client({
      "GET /api/v2/integrations/actions": () => json({ entities: [{}], pageSize: 1, total: 412 }),
      "GET /api/v2/organizations/limits/namespaces/dataactions": () => json({ entities: [{ key: "actions.total.max", value: 500 }, { key: "actions.integration.max", value: 100 }] }),
    });
    const r = await monitorOrg(c, [metric({ id: "dataactions", count: { kind: "total", path: "/api/v2/integrations/actions" }, limit: { namespace: "dataactions", key: "actions.total.max" } })], new Date("2026-09-29T10:00:00Z"));
    expect(r).toMatchObject({ profile: "mon", at: "2026-09-29T10:00:00.000Z", limitErrors: [] });
    expect(r.metrics[0]).toMatchObject({ count: 412, limit: 500, percent: 82, level: "warn" });
    expect(calls.find((x) => x.path === "/api/v2/integrations/actions")!.query).toBe("?pageSize=1");
  });

  it("counts only custom data actions against the limit and finds the fullest integration, in one walk", async () => {
    const actions = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `custom_-_a${i}`, integrationId: "int-a" })),
      { id: "custom_-_b0", integrationId: "int-b" },
      { id: "static_-_SF-GetContact_-_int-s", integrationId: "int-s" },
      { id: "static_-_SF-GetCase_-_int-s", integrationId: "int-s" },
    ];
    const c = client({
      "GET /api/v2/integrations/actions": (url) => json({ entities: actions, pageSize: Number(url.searchParams.get("pageSize")), pageNumber: 1, pageCount: 1, total: actions.length }),
      "GET /api/v2/integrations/actions/drafts": () => json({ entities: [{ id: "custom_-_a0", integrationId: "int-a" }, { id: "custom_-_new", integrationId: "int-a" }], pageNumber: 1, pageCount: 1 }),
      "GET /api/v2/integrations": () => json({ entities: [
        { id: "int-a", name: "Genesys Cloud Data Actions", integrationType: { id: "purecloud-data-actions" }, intendedState: "ENABLED" },
        { id: "int-s", name: "Salesforce", integrationType: { id: "salesforce-datadip" }, intendedState: "DISABLED" },
        { id: "int-empty", name: "Web services", integrationType: { id: "custom-rest-actions" }, intendedState: "ENABLED" },
        { id: "int-sso", name: "Single sign-on", integrationType: { id: "okta-sso" }, intendedState: "ENABLED" },
      ], pageNumber: 1, pageCount: 1 }),
      "GET /api/v2/organizations/limits/namespaces/dataactions": () => json({ entities: [{ key: "actions.total.max", value: 5 }, { key: "actions.integration.max", value: 3 }] }),
    });
    const ids = ["dataactions", "dataactions-per-integration", "dataaction-drafts"];
    const r = await monitorOrg(c, MONITOR_METRICS.filter((m) => ids.includes(m.id)));
    expect(r.metrics[0]).toMatchObject({ count: 4, limit: 5, level: "warn", note: "plus 2 built-in actions of integrations, not counted" });
    expect(r.metrics[1]).toMatchObject({ count: 3, limit: 3, level: "alert", note: "most: Genesys Cloud Data Actions" });
    expect(r.metrics[2]).toMatchObject({ count: 2, note: "1 never published, 1 edits of published actions" });
    expect(calls.filter((x) => x.path === "/api/v2/integrations/actions")).toHaveLength(1);
    // Every integration with actions, plus data action integrations without any; no SSO and the like.
    expect(r.integrations).toEqual([
      { id: "int-a", name: "Genesys Cloud Data Actions", type: "purecloud-data-actions", enabled: true, custom: 3, builtIn: 0, drafts: 2, newDrafts: 1 },
      { id: "int-b", name: "int-b", custom: 1, builtIn: 0, drafts: 0, newDrafts: 0 },
      { id: "int-s", name: "Salesforce", type: "salesforce-datadip", enabled: false, custom: 0, builtIn: 2, drafts: 0, newDrafts: 0 },
      { id: "int-empty", name: "Web services", type: "custom-rest-actions", enabled: true, custom: 0, builtIn: 0, drafts: 0, newDrafts: 0 },
    ]);
  });

  it("walks cursor pages when there is no total", async () => {
    const c = client({
      "GET /api/v2/teams": (url) =>
        url.searchParams.get("after") === "c1"
          ? json({ entities: [{ id: "3" }] })
          : json({ entities: [{ id: "1" }, { id: "2" }], nextUri: "/api/v2/teams?pageSize=100&after=c1" }),
    });
    const r = await monitorOrg(c, [metric({ id: "teams", count: { kind: "walk", path: "/api/v2/teams" } })]);
    expect(r.metrics[0]).toMatchObject({ count: 3, level: "none" });
    expect(r.metrics[0]!.atLeast).toBeUndefined();
  });

  it("counts task management objects with a read POST even on a read-only profile", async () => {
    const c = client({ "POST /api/v2/taskmanagement/worktypes/query": () => json({ entities: [], count: 7 }) });
    const r = await monitorOrg(c, [metric({ id: "worktypes", count: { kind: "count-query", path: "/api/v2/taskmanagement/worktypes/query" } })]);
    expect(r.metrics[0]).toMatchObject({ count: 7 });
    expect(calls[0]!.body).toEqual({ filters: [], select: "Count" });
  });

  it("shows missing permissions and unreadable limits per card, without failing the page", async () => {
    const c = client({
      "GET /api/v2/flows": () => json({ message: "Missing permission", code: "missing.any.permissions" }, 403),
      "GET /api/v2/routing/queues": () => json({ entities: [], total: 3 }),
      "GET /api/v2/organizations/limits/namespaces/routing": () => json({ message: "boom" }, 500),
    });
    const r = await monitorOrg(c, [
      metric({ id: "flows", count: { kind: "total", path: "/api/v2/flows" }, permissions: ["architect:flow:view"] }),
      metric({ id: "queues", count: { kind: "total", path: "/api/v2/routing/queues" }, limit: { namespace: "routing", key: "queues.max" } }),
    ]);
    expect(r.metrics[0]).toMatchObject({ level: "error", error: "No permission (needs architect:flow:view)" });
    expect(r.metrics[1]).toMatchObject({ count: 3, level: "none" });
    expect(r.metrics[1]!.limit).toBeUndefined();
    expect(r.limitErrors).toEqual(["routing"]);
  });

  it("never writes: every built-in metric is a GET or a /query POST", () => {
    for (const m of MONITOR_METRICS) {
      if (m.count.kind === "count-query") expect(m.count.path).toMatch(/\/query$/);
      expect(MONITOR_GROUPS).toContain(m.group);
    }
    expect(new Set(MONITOR_METRICS.map((m) => m.id)).size).toBe(MONITOR_METRICS.length);
  });

  it("levels: amber from 80 %, red from 95 %", () => {
    expect(levelFor(79, 100)).toBe("ok");
    expect(levelFor(80, 100)).toBe("warn");
    expect(levelFor(95, 100)).toBe("alert");
    expect(levelFor(5, undefined)).toBe("none");
    expect(levelFor(undefined, 100)).toBe("error");
  });
});
