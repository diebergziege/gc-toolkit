import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenProvider } from "../src/core/auth.js";
import { breakDown, readBilling, type RawOverview, type RawUsage } from "../src/core/billing.js";
import { GenesysClient } from "../src/core/client.js";
import { ADD_ONS, DOCS, estimate, FAIR_USE, LICENCE_MODELS, LICENCES, TOKEN_WHAT, parseEstimateInput, pricingCatalog, RULES, TOKEN_RATES, USE_CASES, type EstimateInput } from "../src/core/pricing.js";
import { saveProfile, type Profile } from "../src/core/profiles.js";

const input = (p: Partial<EstimateInput>): EstimateInput => ({ model: "named", seats: {}, hourly: {}, addOns: {}, usage: {}, fairUse: {}, tokenPrice: 1, ...p });

describe("pricing catalogue", () => {
  it("links every licence, add-on, rate and rule to an official page", () => {
    for (const x of [...LICENCES, ...ADD_ONS, ...TOKEN_RATES, ...RULES, ...LICENCE_MODELS]) {
      expect(x.docs.length, JSON.stringify(x).slice(0, 60)).toBeGreaterThan(0);
      for (const d of x.docs) expect(DOCS[d].url).toMatch(/^https:\/\//);
    }
    const genesys = Object.values(DOCS).filter((d) => /(genesys\.(com|cloud)|mypurecloud\.com)\//.test(d.url));
    expect(genesys.length).toBeGreaterThanOrEqual(Object.keys(DOCS).length - 1);
    expect(pricingCatalog().useCases.length).toBe(USE_CASES.length);
  });

  it("explains every feature, allowance and licence model in plain words", () => {
    for (const r of TOKEN_RATES) expect(TOKEN_WHAT[r.id], r.id).toBeTruthy();
    for (const f of FAIR_USE) expect(f.what, f.id).toBeTruthy();
    for (const m of LICENCE_MODELS) for (const k of ["counts", "example", "fits", "watch"] as const) expect(m[k], `${m.id}.${k}`).toBeTruthy();
    expect(pricingCatalog().tokenRates.every((r) => r.what)).toBe(true);
  });

  it("CX 2 + WEM Add-on I costs the CX 3 price", () => {
    const e = estimate(input({ seats: { cx2: 10 }, addOns: { wemCx2: 10 } }));
    expect(e.monthly).toBe(estimate(input({ seats: { cx3: 10 } })).monthly);
  });
});

describe("estimate", () => {
  it("charges tokens above the free allocation and rounds the month up", () => {
    const e = estimate(input({ seats: { cx1: 50 }, usage: { voiceBotMinutes: 18000 } }));
    expect(e.tokens.total).toBe(1059); // 18,000 / 17 = 1058.8
    expect(e.tokens.allocation).toBe(250);
    expect(e.tokens.billable).toBe(809);
    expect(e.monthly).toBe(50 * 75 + 809);
    expect(e.perAgent).toBe(Math.round(((50 * 75 + 809) / 50) * 100) / 100);
  });

  it("uses concurrent prices, the 350 free tokens and CX 4's 39 per agent", () => {
    const e = estimate(input({ model: "concurrent", seats: { cx4: 10 }, usage: { copilotUsers: 0, agenticInteractions: 1000 } }));
    expect(e.lines[0]).toMatchObject({ unitPrice: 360, monthly: 3600 });
    expect(e.tokens.allocation).toBe(350 + 390);
    expect(e.tokens.total).toBe(1200);
    expect(e.tokens.billable).toBe(460);
  });

  it("prices per-user AI by model and warns about impossible mixes", () => {
    const named = estimate(input({ seats: { cx3: 100 }, usage: { copilotUsers: 100 } }));
    expect(named.tokens.total).toBe(4000);
    const conc = estimate(input({ model: "concurrent", seats: { cx3: 100 }, usage: { copilotUsers: 100 } }));
    expect(conc.tokens.total).toBe(6000);
    const odd = estimate(input({ seats: { cx1: 5, cx4: 5 }, addOns: { wemCx2: 3, journey: 5 }, usage: { copilotUsers: 8, messages: 400, staUsers: 9 } }));
    expect(odd.warnings.join("\n")).toMatch(/CX 2 WEM Add-on I is for Genesys Cloud CX 2 users, but only 0/);
    expect(odd.warnings.join("\n")).toMatch(/Journey Management already/);
    expect(odd.warnings.join("\n")).toMatch(/Agent Copilot users \(8\) exceed the users not on CX 4 \(5\)/);
    expect(odd.warnings.join("\n")).toMatch(/Speech and text analytics users \(9\)/);
    expect(odd.warnings.join("\n")).not.toMatch(/needs digital channels/); // CX 4 has digital
    expect(estimate(input({ seats: { cx1: 5 }, usage: { messages: 400 } })).warnings.join("\n")).toMatch(/needs digital channels/);
  });

  it("adds fair use overage above the pooled allowance", () => {
    const e = estimate(input({ seats: { cx3: 20 }, fairUse: { ivr: 70000, storage: 100 } }));
    const ivr = e.fairUse.find((f) => f.id === "ivr")!;
    expect(ivr).toMatchObject({ allocation: 65000, overage: 5000, cost: 50 });
    expect(e.fairUse.find((f) => f.id === "storage")!.cost).toBe(0);
    expect(e.monthly).toBe(20 * 155 + 50);
  });

  it("prices Hourly Interacting per hour, next to the named users", () => {
    for (const l of LICENCES.filter((x) => x.id !== "communicate")) {
      expect(l.hourly, l.id).toBeGreaterThan(0);
      expect(l.docs, l.id).toContain("hourlyPrices");
      expect(l.named / l.hourly!, l.id).toBeCloseTo(41.7, 0);
    }
    const e = estimate(input({ seats: { cx1: 10 }, hourly: { cx1: 100, communicate: 50 } }));
    expect(e.lines.find((l) => /Hourly/.test(l.label))).toMatchObject({ qty: 100, unitPrice: 1.8, monthly: 180 });
    expect(e.lines.filter((l) => /Hourly/.test(l.label)).length).toBe(1);
    expect(e.monthly).toBe(10 * 75 + 180);
    expect(estimate(input({ hourly: { cx2: 10 } })).tokens.free).toBe(250);
    expect(parseEstimateInput({ hourly: { cx1: "5", communicate: 3 } }).hourly).toEqual({ cx1: 5 });
  });

  it("parses page input defensively", () => {
    const p = parseEstimateInput({ model: "x", seats: { cx1: "12", evil: 5, cx2: -3, cx3: Infinity }, usage: { aiTranslate: 1e12 }, tokenPrice: 99 });
    expect(p).toEqual({ model: "named", seats: { cx1: 12 }, hourly: {}, addOns: {}, usage: { aiTranslate: 1e9 }, fairUse: {}, tokenPrice: 10 });
    expect(parseEstimateInput(null).tokenPrice).toBe(1);
  });

  it("the use cases' texts match what the calculator says", () => {
    const byId = (id: string) => estimate(USE_CASES.find((u) => u.id === id)!.input);
    expect(byId("omni-va").tokens.total).toBe(7650);
    expect(byId("ava-first").tokens.total).toBe(24471);
    expect(byId("digital-only").tokens.total).toBe(1839);
    expect(byId("partial-wem").monthly).toBe(150 * 115 + 40 * 40);
    expect(byId("copilot-floor").monthly).toBeGreaterThan(0);
    for (const u of USE_CASES) expect(estimate(u.input).warnings, u.id).toEqual([]);
  });
});

/** Rows as the dev org returned them on 2026-11-02 (concurrent CX 3, no use). */
const devRows: RawUsage[] = [
  { name: "Genesys Cloud CX 3 Concurrent", partNumber: "PC-170-NV-USR3C", grouping: "billable-app-concurrent-license", unitOfMeasureType: "user", usageQuantity: "0", overagePrice: "230.00", prepayQuantity: "5", prepayPrice: "0.00" },
  { name: "Genesys Cloud 3 Hourly Interacting", partNumber: "GC-170-NV-USR3HI", grouping: "billable-app-usage-license", unitOfMeasureType: "hour", usageQuantity: "0", overagePrice: "3.72", prepayQuantity: "0", prepayPrice: "3.10" },
  { name: "Genesys Cloud IVR Basic Per Minute Charge", grouping: "ivr", unitOfMeasureType: "minute", usageQuantity: "0", overagePrice: "0.01", prepayQuantity: "23625" },
  { name: "Genesys Cloud API Resource", grouping: "api", unitOfMeasureType: "request", usageQuantity: "0", overagePrice: "0.0001", prepayQuantity: "960000" },
  { name: "Genesys Cloud Data Storage", grouping: "storage", unitOfMeasureType: "gb", usageQuantity: "1", overagePrice: "0.25", prepayQuantity: "236.25" },
  { name: "Call", grouping: "storage-category", unitOfMeasureType: "gb", usageQuantity: "0.02237917", overagePrice: "0" },
  { name: "Genesys Cloud BYOC Cloud", grouping: "resource", unitOfMeasureType: "unit", usageQuantity: "1", overagePrice: "0.000000", prepayPrice: "0.0012", usageNotes: '{"actuals":"0.000000","commit":"0.000000","fairUse":"0","total":"0.000000"}' },
  { name: "SMS Outbound Rate A", grouping: "messaging-usage", unitOfMeasureType: "message", usageQuantity: "0", overagePrice: "0.01" },
  { name: "AI Experience Tokens Concurrent", grouping: "rollup", unitOfMeasureType: "token", usageQuantity: "0", overagePrice: "1.00", prepayQuantity: "0", prepayPrice: "1.00" },
  { name: "Genesys Cloud for Bot Flow - Voice", grouping: "rollup-usage", unitOfMeasureType: "token", usageQuantity: "0", bundleQuantity: "17" },
  { name: "Genesys Cloud Virtual Agent", grouping: "rollup-usage", unitOfMeasureType: "token", usageQuantity: "0", bundleQuantity: "2" },
  { name: "Genesys Cloud Agentic Virtual Agent", grouping: "rollup-usage", unitOfMeasureType: "token", usageQuantity: "0", bundleQuantity: "1" },
  { name: "WhatsApp Private Messaging", grouping: "rollup-usage", unitOfMeasureType: "token", usageQuantity: "0", bundleQuantity: "400" },
  { name: "AI Experience Tokens Concurrent", grouping: "fair-use", unitOfMeasureType: "token", usageQuantity: "350" },
];
const overview = (usages: RawUsage[]): RawOverview => ({ currency: "USD", subscriptionType: "DEV_ORG_PREPAY", isInRampPeriod: false, minimumMonthlyAmount: "0.00", usages });
const withUse = (use: Record<string, string>) => devRows.map((r) => (r.name! in use && r.grouping !== "fair-use" ? { ...r, usageQuantity: use[r.name!] } : r));

describe("live billing breakdown", () => {
  it("sorts the dev org's rows into licences, tokens and fair use", () => {
    const r = breakDown(overview(devRows), "psuk", null, "2026-11-02T10:00:00Z");
    expect(r.licences.map((l) => [l.name, l.kind, l.committed, l.cost])).toEqual([["Genesys Cloud CX 3 Concurrent", "concurrent", 5, 0]]);
    expect(r.fairUse.map((f) => [f.name, f.allocation, f.used])).toEqual([["Basic routing / IVR", 23625, 0], ["API requests", 960000, 0], ["Data storage", 236.25, 1], ["Genesys Cloud BYOC Cloud", 0, 0]]);
    expect(r.storage).toEqual([{ name: "Call", gb: 0.02237917 }]);
    expect(r.tokens).toMatchObject({ used: 0, allocation: 350, quantities: "unknown", perUser: null, cost: 0 });
    expect(r.tokens!.features.find((f) => /Agentic/.test(f.name))!.rate).toBe("1.2 tokens per interaction");
    expect(r.other).toEqual([]);
    expect(r.estimated).toBe(0);
  });

  it("detects rows counted in units and converts them to tokens", () => {
    // 1,700 voice bot minutes = 100 tokens, 1,000 VA interactions = 500, 100 AVA = 120; 40 more from Copilot.
    const rows = withUse({ "Genesys Cloud for Bot Flow - Voice": "1700", "Genesys Cloud Virtual Agent": "1000", "Genesys Cloud Agentic Virtual Agent": "100", "AI Experience Tokens Concurrent": "760" });
    const t = breakDown(overview(rows), "p").tokens!;
    expect(t.quantities).toBe("units");
    expect(t.features.slice(0, 3).map((f) => [f.name, f.tokens])).toEqual([["Genesys Cloud Virtual Agent", 500], ["Genesys Cloud Agentic Virtual Agent", 120], ["Genesys Cloud for Bot Flow - Voice", 100]]);
    expect(t.perUser).toBe(40);
    expect(t.above).toBe(410);
    expect(t.cost).toBe(410);
  });

  it("detects rows counted in tokens", () => {
    const rows = withUse({ "Genesys Cloud for Bot Flow - Voice": "100", "Genesys Cloud Virtual Agent": "500", "AI Experience Tokens Concurrent": "600" });
    const t = breakDown(overview(rows), "p").tokens!;
    expect(t.quantities).toBe("tokens");
    expect(t.features.find((f) => /Voice/.test(f.name))).toMatchObject({ tokens: 100, units: 1700 });
    expect(t.perUser).toBe(0);
  });

  it("charges licences above their commitment and lists other paid usage", () => {
    const rows: RawUsage[] = [
      { name: "Genesys Cloud CX 2", grouping: "user-license", unitOfMeasureType: "user", usageQuantity: "12", prepayQuantity: "10", prepayPrice: "115.00", overagePrice: "138.00" },
      { name: "SMS Outbound Rate A", grouping: "messaging-usage", unitOfMeasureType: "message", usageQuantity: "1000", overagePrice: "0.01" },
    ];
    const r = breakDown({ ...overview(rows), minimumMonthlyAmount: "5000" }, "p");
    expect(r.licences[0]).toMatchObject({ kind: "named", above: 2, cost: 10 * 115 + 2 * 138 });
    expect(r.other).toEqual([{ name: "SMS Outbound Rate A", grouping: "messaging-usage", unit: "message", used: 1000, price: 0.01, cost: 10 }]);
    expect(r.estimated).toBe(5000); // the minimum applies
  });
});

describe("readBilling", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-bill-")); process.env.GCTK_HOME = home; });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("asks for the period that contains the given day", async () => {
    const p: Profile = { name: "bill", region: "euw2.pure.cloud", tier: "sandbox", credentials: "env" };
    saveProfile(p);
    const seen: string[] = [];
    const fetchImpl = (async (u: string | URL | Request) => {
      const url = new URL(String(u));
      if (url.hostname.startsWith("login.")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      seen.push(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify(overview(devRows)), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new GenesysClient(p, { source: "ui", fetchImpl, tokens: new TokenProvider(p.region, () => ({ clientId: "a", clientSecret: "b" }), fetchImpl) });
    const r = await readBilling(client, "bill", "2026-10-31");
    expect(seen).toEqual([`/api/v2/billing/subscriptionoverview?periodEndingTimestamp=${Date.parse("2026-10-31T23:59:59.999Z")}`]);
    expect(r.periodEnding).toBe("2026-10-31");
    await readBilling(client, "bill");
    expect(seen[1]).toBe("/api/v2/billing/subscriptionoverview");
    await expect(readBilling(client, "bill", "31.10.2026")).rejects.toThrow(/YYYY-MM-DD/);
  });
});
