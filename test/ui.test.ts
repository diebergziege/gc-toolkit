import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveProfile } from "../src/core/profiles.js";
import { startUi, type UiServer } from "../src/ui/server.js";

describe("UI server", () => {
  let ui: UiServer;
  let home: string;
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-ui-"));
    process.env.GCTK_HOME = home;
    process.env.GCTK_APPROVAL_KEY = "k";
    saveProfile({ name: "prod-de", region: "mypurecloud.de", tier: "production", credentials: "env" });
    ui = await startUi({ token: "test-token" });
  });
  afterAll(async () => {
    await ui.close();
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.GCTK_HOME;
    delete process.env.GCTK_APPROVAL_KEY;
  });

  const base = () => `http://127.0.0.1:${ui.port}`;
  const call = (p: string, init: RequestInit = {}, token = "test-token") =>
    fetch(`${base()}${p}`, { ...init, headers: { "x-gctk-token": token, "content-type": "application/json", ...(init.headers ?? {}) } });

  it("answers at the readable address gctk.localhost and prefers its fixed port", async () => {
    expect(ui.url).toBe(`http://gctk.localhost:${ui.port}/#token=test-token`);
    const status = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port: ui.port, path: "/api/overview", headers: { host: `gctk.localhost:${ui.port}`, "x-gctk-token": "test-token" } }, (r) => resolve(r.statusCode ?? 0));
    });
    expect(status).toBe(200);
    // The preferred port is taken by the running UI: a second one falls back to a free port.
    const second = await startUi({ preferPort: ui.port, token: "t2" });
    try {
      expect(second.port).not.toBe(ui.port);
      expect(second.url).toMatch(/^http:\/\/gctk\.localhost:\d+\/#token=t2$/);
    } finally {
      await second.close();
    }
  });

  it("serves the page with a nonce CSP and never embeds the token", async () => {
    const res = await fetch(`${base()}/`);
    const html = await res.text();
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+'/);
    expect(html).not.toContain("__NONCE__");
    expect(html).not.toContain("test-token");
    expect(html).not.toMatch(/innerHTML/);
  });

  it("requires the session token for the API", async () => {
    expect((await call("/api/overview", {}, "wrong")).status).toBe(401);
    expect((await call("/api/overview")).status).toBe(200);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const status = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port: ui.port, path: "/api/overview", headers: { host: "evil.example:80", "x-gctk-token": "test-token" } }, (r) => resolve(r.statusCode ?? 0));
    });
    expect(status).toBe(421);
  });

  it("rejects cross-origin and non-JSON writes", async () => {
    expect((await call("/api/profiles/prod-de/activate", { method: "POST", body: "{}", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("/api/profiles/prod-de/activate", { method: "POST", body: "x", headers: { "content-type": "text/plain" } })).status).toBe(415);
  });

  it("Demo ready: lists sections, checks agent and section", async () => {
    const meta = (await (await call("/api/demo")).json()) as { sections: Array<{ id: string; ready: boolean }> };
    expect(meta.sections.filter((s) => s.ready).map((s) => s.id)).toEqual(["coaching", "learning", "sta", "evaluations", "scorecard", "schedule"]);
    const bad = await call("/api/demo/coaching/status?profile=prod-de&userId=..%2Fplans");
    expect(bad.status).toBe(400);
    expect((await call("/api/demo/nope/status?profile=prod-de&userId=1a037595-f2e7-4cb6-8b2e-72eb3d9fcae3")).status).toBe(400);
    const run = await call("/api/demo/coaching/run", { method: "POST", body: JSON.stringify({ profile: "prod-de", userId: "not-a-user" }) });
    expect(run.status).toBe(400);
  });

  it("has no routes for plans, approvals or policies any more", async () => {
    for (const p of ["/api/plans", "/api/trust", "/api/audit"]) expect((await call(p)).status).toBe(404);
  });
});
