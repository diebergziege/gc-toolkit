import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveProfile } from "../src/core/profiles.js";
import { portFree, startUi, type UiServer, uiUrl } from "../src/ui/server.js";
import { HEADER, ROWS, xlsx } from "./radar-fixture.js";

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

  it("takes the next free port near the kept one, and moves to another port on request", async () => {
    const moved: number[] = [];
    const second = await startUi({ preferPort: ui.port, token: "t2", onPortChange: (p) => moved.push(p) });
    const post = (port: number, body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/ui/port`, { method: "POST", headers: { "x-gctk-token": "t2", "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect(second.port).toBeGreaterThan(ui.port);
      expect(second.port).toBeLessThan(ui.port + 20);
      let target = second.port + 100;
      while (!(await portFree(target))) target++;
      const before = second.port;
      // A taken port changes nothing.
      const taken = await post(before, { port: ui.port });
      expect(taken.status).toBe(400);
      expect((await taken.json()).error).toMatch(/in use/);
      const r = await post(before, { port: target });
      expect(await r.json()).toEqual({ url: uiUrl(target, "t2"), port: target });
      expect(moved).toEqual([target]);
      expect(second.port).toBe(target);
      expect((await fetch(`http://127.0.0.1:${target}/api/overview`, { headers: { "x-gctk-token": "t2" } })).status).toBe(200);
      await new Promise((res) => setTimeout(res, 700));
      expect(await portFree(before)).toBe(true); // the old address closed
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

  it("shows an org's OAuth client ID shortened and never its secret", async () => {
    process.env.GCTK_CLIENT_ID = "485c8ae1-1111-2222-3333-444455556666";
    process.env.GCTK_CLIENT_SECRET = "s3cr3t-value-abcd-1234";
    try {
      const text = await (await call("/api/overview")).text();
      expect(JSON.parse(text).profiles[0]).toMatchObject({ name: "prod-de", credentialsStored: true, clientId: "485c8ae1…" });
      expect(text).not.toContain("s3cr3t");
      expect(text).not.toContain("444455556666");
    } finally {
      delete process.env.GCTK_CLIENT_ID;
      delete process.env.GCTK_CLIENT_SECRET;
    }
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

  it("Pricing: serves the catalogue and estimates, and checks the billing period", async () => {
    const cat = (await (await call("/api/pricing")).json()) as { licences: unknown[]; docs: Record<string, { url: string }> };
    expect(cat.licences.length).toBeGreaterThan(4);
    expect(cat.docs.tokens?.url).toMatch(/^https:\/\/help\.genesys\.cloud\//);
    const e = await call("/api/pricing/estimate", { method: "POST", body: JSON.stringify({ seats: { cx1: 2 }, usage: { voiceBotMinutes: 17 * 300 } }) });
    expect(await e.json()).toMatchObject({ monthly: 150 + 50, tokens: { total: 300, billable: 50 } });
    expect((await call("/api/pricing/billing?profile=prod-de&periodEnding=yesterday")).status).toBe(400);
  });

  it("Partner: uploads the survey export, keeps it and removes it", async () => {
    expect(await (await call("/api/partner/radar")).json()).toEqual({ radar: null });
    expect((await call("/api/partner/radar", { method: "POST", body: JSON.stringify({ file: "not base64!" }) })).status).toBe(400);
    const bad = await call("/api/partner/radar", { method: "POST", body: JSON.stringify({ file: Buffer.from("hello").toString("base64") }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/not an Excel file/);
    const up = await call("/api/partner/radar", { method: "POST", body: JSON.stringify({ file: xlsx([HEADER, ...ROWS]).toString("base64"), name: "survey.xlsx" }) });
    expect(up.status).toBe(200);
    expect(((await up.json()) as { radar: { responses: Array<{ partner: string }> } }).radar.responses.map((r) => r.partner)).toEqual(["Example Partner", "Other Partner"]);
    expect(((await (await call("/api/partner/radar")).json()) as { radar: { fileName: string } }).radar.fileName).toBe("survey.xlsx");
    expect(await (await call("/api/partner/radar", { method: "DELETE" })).json()).toEqual({ removed: true, radar: null });
  });

  it("has no routes for plans, approvals or policies any more", async () => {
    for (const p of ["/api/plans", "/api/trust", "/api/audit"]) expect((await call(p)).status).toBe(404);
  });
});
