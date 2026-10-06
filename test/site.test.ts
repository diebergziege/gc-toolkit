import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUi, type UiServer } from "../src/ui/server.js";
import { environmentFor, INDUSTRIES, parseSiteQuery, saveLogo, SITE_HOST, siteCsp, siteHtml } from "../src/ui/site.js";

const DEP = "3f1c2a7e-9b1d-4c1e-8f2a-1b2c3d4e5f60";
const PNG = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");

describe("demo website: page", () => {
  it("has every industry in English and German with the same structure", () => {
    expect(INDUSTRIES.map((i) => i.id)).toEqual(["bank", "insurance", "retail", "utilities", "telco"]);
    for (const i of INDUSTRIES) {
      expect(i.copy.de.topics).toHaveLength(i.copy.en.topics.length);
      expect(i.copy.de.faq).toHaveLength(i.copy.en.faq.length);
    }
  });

  it("escapes everything from the query string and falls back to the industry's defaults", () => {
    const q = new URLSearchParams({ industry: "retail", lang: "de", brand: `</title><script>alert(1)</script>`, color: "red;}", phone: `"><img src=x onerror=alert(1)>`, logo: "../../etc/passwd" });
    const o = parseSiteQuery(q);
    expect(o).toMatchObject({ lang: "de", color: "#7a2e3a" });
    expect(o.logo).toBeUndefined();
    expect(o.messenger).toBeUndefined();
    const html = siteHtml(o, "N");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain("Die Herbstkollektion ist da");
    // Without a deployment the page says so and loads no Genesys script.
    expect(html).toContain("Chat nicht verbunden");
    expect(html).not.toContain("genesys.min.js");
    expect(parseSiteQuery(new URLSearchParams({ industry: "nope" })).industry.id).toBe("bank");
  });

  it("loads the org's Messenger with the deployment's environment, and the CSP allows only that host", () => {
    const o = parseSiteQuery(new URLSearchParams({ industry: "bank", deployment: DEP, domain: "mypurecloud.de" }));
    expect(o.messenger).toEqual({ deploymentId: DEP, environment: "prod-euc1", domain: "mypurecloud.de" });
    const html = siteHtml(o, "N");
    expect(html).toContain(`"https://apps.mypurecloud.de/genesys-bootstrap/genesys.min.js", { environment: "prod-euc1", deploymentId: "${DEP}" }`);
    expect(html.match(/<script nonce="N">/g)).toHaveLength(2);
    const csp = siteCsp(o, "N");
    expect(csp).toContain("script-src 'nonce-N' https://apps.mypurecloud.de https://*.mypurecloud.de");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(siteCsp(parseSiteQuery(new URLSearchParams()), "N")).toContain("connect-src 'none'");
    // A domain that is not Genesys Cloud's is refused.
    expect(parseSiteQuery(new URLSearchParams({ deployment: DEP, env: "prod", domain: "evil.example" })).messenger).toBeUndefined();
  });

  it("needs only the deployment ID and the org's region: the environment follows from the region", () => {
    expect(parseSiteQuery(new URLSearchParams({ deployment: ` ${DEP} `, domain: "euw2.pure.cloud" })).messenger).toEqual({ deploymentId: DEP, environment: "prod-euw2", domain: "euw2.pure.cloud" });
    expect(environmentFor("mypurecloud.com")).toBe("prod");
    expect(parseSiteQuery(new URLSearchParams({ deployment: "not-an-id", domain: "mypurecloud.de" })).messenger).toBeUndefined();
  });
});

describe("demo website: server", () => {
  let ui: UiServer;
  let home: string;
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-site-"));
    process.env.GCTK_HOME = home;
    ui = await startUi({ token: "test-token" });
  });
  afterAll(async () => {
    await ui.close();
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.GCTK_HOME;
  });

  const get = (host: string, p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve) => {
      http.get({ host: "127.0.0.1", port: ui.port, path: p, headers: { host: `${host}:${ui.port}`, ...headers } }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body }));
      });
    });

  it("lists the regions for the Website page, with their Messenger environment", async () => {
    const meta = await (await fetch(`http://127.0.0.1:${ui.port}/api/site`, { headers: { "x-gctk-token": "test-token" } })).json();
    expect(meta.regions).toContainEqual({ key: "eu-central-1", domain: "mypurecloud.de", environment: "prod-euc1" });
    expect(meta.host).toBe(SITE_HOST);
  });

  it("serves the website only on its own host, and never the API there", async () => {
    const site = await get(SITE_HOST, "/site?industry=telco&brand=Acme");
    expect(site.status).toBe(200);
    expect(site.headers["content-security-policy"]).toMatch(/script-src 'nonce-[^']+'/);
    expect(site.body).toContain("<title>Acme</title>");
    expect((await get(SITE_HOST, "/api/overview", { "x-gctk-token": "test-token" })).status).toBe(404);
    expect((await get(SITE_HOST, "/", {})).status).toBe(404);
    // The UI's own host does not serve the website (its scripts would share the UI's origin).
    expect((await get("gctk.localhost", "/site")).status).toBe(404);
  });

  it("stores raster logos only and serves them sandboxed on the website's host", async () => {
    const up = (data: string) => fetch(`http://127.0.0.1:${ui.port}/api/site/files`, { method: "POST", headers: { "x-gctk-token": "test-token", "content-type": "application/json" }, body: JSON.stringify({ data }) });
    const svg = await up("data:image/svg+xml;base64," + Buffer.from("<svg onload=alert(1)>").toString("base64"));
    expect(svg.status).toBe(400);
    expect((await svg.json()).error).toMatch(/SVG is not accepted/);
    const ok = await up(PNG);
    const { logo } = await ok.json();
    expect(logo).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(saveLogo(PNG)).toBe(logo);
    const img = await get(SITE_HOST, `/site/logo/${logo}`);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["content-security-policy"]).toContain("sandbox");
    expect((await get(SITE_HOST, "/site/logo/..%2F..%2Fconfig.yaml")).status).toBe(404);
  });
});
