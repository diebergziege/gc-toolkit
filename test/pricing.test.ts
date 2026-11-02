import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenProvider } from "../src/core/auth.js";
import { breakDown, readBilling, readHistory, type BillingMonth, type RawOverview, type RawUsage } from "../src/core/billing.js";
import { GenesysClient } from "../src/core/client.js";
import { ADD_ONS, compareModels, DOCS, estimate, tierOptions, FAIR_USE, LICENCE_MODELS, LICENCES, TOKEN_WHAT, parseEstimateInput, pricingCatalog, RULES, TOKEN_RATES, USE_CASES, type EstimateInput } from "../src/core/pricing.js";
import { saveProfile, type Profile } from "../src/core/profiles.js";

const input = (p: Partial<EstimateInput>): EstimateInput => ({ model: "named", seats: {}, peakPercent: 100, hourly: {}, addOns: {}, usage: {}, fairUse: {}, tokenPrice: 1, ...p });

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
    expect(p).toEqual({ model: "named", seats: { cx1: 12 }, peakPercent: 100, hourly: {}, addOns: {}, usage: { aiTranslate: 1e9 }, fairUse: {}, tokenPrice: 10 });
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
    expect(r.other).toEqual([{ name: "SMS Outbound Rate A", grouping: "messaging-usage", unit: "message", used: 1000, included: 0, price: 0.01, cost: 10 }]);
    expect(r.estimated).toBe(5000); // the minimum applies
  });
});

describe("named or concurrent", () => {
  it("prices the same people both ways and finds where concurrent pays off", () => {
    const all = compareModels(input({ seats: { cx2: 100 }, peakPercent: 100 }));
    expect(all.named.monthly).toBe(100 * 115);
    expect(all.concurrent.monthly).toBe(100 * 170);
    expect(all.recommended).toBe("named");
    expect(all.breakEvenPercent).toBe(67); // 67 × 170 = 11,390 < 11,500
    const shifts = compareModels(input({ seats: { cx2: 100 }, peakPercent: 50, hourly: { cx1: 40 } }));
    expect(shifts.concurrent.agents).toBe(50);
    expect(shifts.concurrent.people).toBe(100);
    expect(shifts.recommended).toBe("concurrent");
    expect(shifts.saving).toBe(100 * 115 - 50 * 170);
    expect(shifts.concurrent.lines.find((l) => /Hourly/.test(l.label))!.monthly).toBe(72); // hourly sits next to either model
    expect(shifts.reasons.join(" ")).toMatch(/at most 67 %.*concurrent is cheaper by 3,000 USD/);
    expect(shifts.concurrent.perAgent).toBe(Math.round(((50 * 170 + 72) / 100) * 100) / 100);
  });

  it("scales per-user AI and add-ons to the busiest moment", () => {
    const c = compareModels(input({ seats: { cx3: 10 }, peakPercent: 50, addOns: { journey: 10 }, usage: { copilotUsers: 10 } })).concurrent;
    expect(c.tokens.rows[0]).toMatchObject({ amount: 5, tokens: 300 });
    expect(c.lines.find((l) => l.group === "addOns")!.qty).toBe(5);
    expect(parseEstimateInput({ peakPercent: 250 }).peakPercent).toBe(100);
    expect(parseEstimateInput({ peakPercent: 0 }).peakPercent).toBe(1);
  });
});

describe("one licence tier per org", () => {
  it("warns when tiers are mixed, but not for Communicate users", () => {
    expect(estimate(input({ seats: { cx1: 10, cx3: 5 } })).warnings.join("\n")).toMatch(/does not allow mixing licence tiers in one org \(here: CX 1, CX 3\)/);
    expect(estimate(input({ seats: { cx2: 10 }, hourly: { cx3: 20 } })).warnings.join("\n")).toMatch(/here: CX 2, CX 3/);
    expect(estimate(input({ seats: { cx2: 10, communicate: 30 }, hourly: { cx2: 20 } })).warnings).toEqual([]);
  });

  it("prices the same setup on every tier and says what a tier cannot do", () => {
    const t = tierOptions(input({ seats: { cx2: 10, communicate: 5 }, hourly: { cx2: 10 }, addOns: { wemCx2: 4, teams: 15 }, usage: { messages: 4000, voiceBotMinutes: 170 } }));
    expect(t.map((x) => x.id)).toEqual(["cx1", "cx2", "cx3", "cx4", "cx2d", "cx3d"]);
    const cx3 = t.find((x) => x.id === "cx3")!;
    expect(cx3.named).toBe(10 * 155 + 5 * 12 + 10 * 3.72 + 15 * 5); // the CX 2 WEM add-on does not fit CX 3
    expect(t.find((x) => x.id === "cx2")!.named).toBe(10 * 115 + 5 * 12 + 10 * 2.76 + 4 * 40 + 15 * 5);
    expect(t.find((x) => x.id === "cx1")!.missing).toMatch(/no chat, email or messaging/);
    expect(t.find((x) => x.id === "cx2d")!.missing).toBe("no phone calls");
    expect(cx3.missing).toBeNull();
    expect(compareModels(input({ seats: { cx2: 10 } })).tiers.length).toBe(6);
    expect(tierOptions(input({}))).toEqual([]);
    expect(RULES[0]!.title).toMatch(/One licence tier for the whole org/);
  });
});

describe("billing insights and forecast", () => {
  const period = { start: "2026-10-28T00:00:00Z", end: "2026-11-27T23:59:59.999Z" };
  it("forecasts the period and warns before the tokens run out", () => {
    const rows = withUse({ "Genesys Cloud Virtual Agent": "200", "AI Experience Tokens Concurrent": "100" });
    const r = breakDown(overview(rows), "p", null, "2026-11-07T00:00:00Z", period); // day 10 of 31
    expect(r.period).toMatchObject({ days: 31, elapsed: 10, current: true });
    expect(r.forecast).toMatchObject({ factor: 3.1, tokens: 310, tokensAbove: 0 });
    expect(r.insights[0]).toMatchObject({ level: "ok", title: "AI tokens: within the included ones" });
    const busy = breakDown(overview(withUse({ "Genesys Cloud Virtual Agent": "400", "AI Experience Tokens Concurrent": "200" })), "p", null, "2026-11-07T00:00:00Z", period);
    expect(busy.forecast).toMatchObject({ tokens: 620, tokensAbove: 270, tokenCost: 270 });
    expect(busy.insights[0]).toMatchObject({ level: "warn", title: "AI tokens: likely to run out this period" });
    expect(busy.insights[0]!.text).toMatch(/about 620 by 27 Nov/);
    expect(busy.insights.some((i) => /Most AI tokens go to Genesys Cloud Virtual Agent/.test(i.title))).toBe(true);
    expect(breakDown(overview(rows), "p", null, "2026-10-29T00:00:00Z", period).forecast).toBeNull(); // too early
  });

  it("flags licences above and below their commitment", () => {
    const rows: RawUsage[] = [
      { name: "Genesys Cloud CX 2", grouping: "user-license", unitOfMeasureType: "user", usageQuantity: "12", prepayQuantity: "10", prepayPrice: "115.00", overagePrice: "138.00" },
      { name: "Genesys Cloud CX 3", grouping: "user-license", unitOfMeasureType: "user", usageQuantity: "6", prepayQuantity: "10", prepayPrice: "155.00", overagePrice: "186.00" },
      { name: "CRM connector", grouping: "billable-app-concurrent-license", unitOfMeasureType: "user", usageQuantity: "3", prepayQuantity: "0", prepayPrice: "0", overagePrice: "10.00" },
      { name: "Free example app", grouping: "billable-app-org-license", unitOfMeasureType: "license", usageQuantity: "1", prepayQuantity: "0", prepayPrice: "0", overagePrice: "0.00" },
    ];
    const closed = breakDown(overview(rows), "p", null, "2026-12-02T00:00:00Z", period);
    expect(closed.insights.map((i) => [i.level, i.title])).toEqual([["alert", "Genesys Cloud CX 2: 2 above the commitment"], ["warn", "Genesys Cloud CX 3: 4 committed but not used"], ["info", "1 part charged by use, without a commitment"]]);
    expect(closed.insights[2]!.text).toMatch(/Together 30\.00 USD.*CRM connector/);
    expect(closed.insights[1]!.text).toMatch(/620\.00 USD a month/);
    const open = breakDown(overview(rows), "p", null, "2026-11-10T00:00:00Z", period);
    expect(open.insights[1]).toMatchObject({ level: "info", title: "Genesys Cloud CX 3: 4 committed but not used so far" });
  });

  it("counts metered parts against their own fair-use allowance", () => {
    const rows: RawUsage[] = [
      { name: "Case Management", grouping: "resource", unitOfMeasureType: "Case", usageQuantity: "34", overagePrice: "0.32" },
      { name: "Case Management", grouping: "fair-use", unitOfMeasureType: "Case", usageQuantity: "150" },
      { name: "Genesys Cloud Extended Voice Transcription", grouping: "resource", unitOfMeasureType: "minute", usageQuantity: "4000", overagePrice: "0.008" },
      { name: "Genesys Cloud Extended Voice Transcription", grouping: "fair-use", unitOfMeasureType: "minute", usageQuantity: "3900" },
      { name: "Work Automation", grouping: "resource", unitOfMeasureType: "Workitem", usageQuantity: "8", overagePrice: "0.056" },
    ];
    const r = breakDown(overview(rows), "p");
    expect(r.fairUse.map((f) => [f.name, f.used, f.allocation, f.cost])).toEqual([["Case Management", 34, 150, 0], ["Genesys Cloud Extended Voice Transcription", 4000, 3900, 0.8]]);
    expect(r.other.map((o) => [o.name, o.cost])).toEqual([["Work Automation", 0.45]]);
    expect(r.estimated).toBe(1.25);
  });

  it("matches the Admin page: whole tokens and included units (dach-sandbox, 2026-11-02)", () => {
    const rows: RawUsage[] = [
      { name: "AI Experience Tokens Concurrent", grouping: "rollup", unitOfMeasureType: "token", usageQuantity: "424.8", overagePrice: "0.80" },
      { name: "AI Experience Tokens Concurrent", grouping: "fair-use", unitOfMeasureType: "token", usageQuantity: "350" },
      { name: "BYOT Rate A", grouping: "resource", unitOfMeasureType: "unit", usageQuantity: "1", prepayQuantity: "1", prepayPrice: "0.00", overagePrice: "3.20" },
      { name: "Radarr by Genesys", grouping: "resource", unitOfMeasureType: "unit", usageQuantity: "1", overagePrice: "264.00" },
    ];
    const r = breakDown({ ...overview(rows), currency: "EUR" }, "p");
    expect(r.tokens).toMatchObject({ used: 424.8, above: 75, cost: 60 });
    expect(r.other.map((o) => [o.name, o.included, o.cost])).toEqual([["Radarr by Genesys", 0, 264], ["BYOT Rate A", 1, 0]]);
    expect(r.estimated).toBe(324);
  });

  it("says when nothing is charged", () => {
    expect(breakDown(overview(devRows), "p").insights.map((i) => i.title)).toContain("Nothing is charged this period");
  });
});

describe("readBilling", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-bill-")); process.env.GCTK_HOME = home; });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const periods = { entities: [
    { startDate: "2026-09-28T00:00:00Z", endDate: "2026-10-27T23:59:59.999Z" },
    { startDate: "2026-10-28T00:00:00Z", endDate: "2026-11-27T23:59:59.999Z" },
    { startDate: "2026-11-28T00:00:00Z", endDate: "2026-12-27T23:59:59.999Z" },
  ] };
  const client = (seen: string[]) => {
    const p: Profile = { name: "bill", region: "euw2.pure.cloud", tier: "sandbox", credentials: "env" };
    saveProfile(p);
    const fetchImpl = (async (u: string | URL | Request) => {
      const url = new URL(String(u));
      if (url.hostname.startsWith("login.")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      seen.push(`${url.pathname}${url.search}`);
      const body = url.pathname.endsWith("/periods") ? periods : overview(devRows);
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return new GenesysClient(p, { source: "ui", fetchImpl, tokens: new TokenProvider(p.region, () => ({ clientId: "a", clientSecret: "b" }), fetchImpl) });
  };

  it("asks for the period that contains the given day", async () => {
    const seen: string[] = [];
    const c = client(seen);
    const r = await readBilling(c, "bill", "2026-10-20");
    expect(seen).toContain(`/api/v2/billing/subscriptionoverview?periodEndingTimestamp=${Date.parse("2026-10-20T23:59:59.999Z")}`);
    expect(seen).toContain("/api/v2/billing/periods?pageSize=100");
    expect(r.periodEnding).toBe("2026-10-20");
    expect(r.period).toMatchObject({ start: "2026-09-28T00:00:00Z", days: 30, current: false });
    seen.length = 0;
    await readBilling(c, "bill");
    expect(seen).toContain("/api/v2/billing/subscriptionoverview");
    await expect(readBilling(c, "bill", "31.10.2026")).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("reads earlier periods once and keeps closed ones", async () => {
    const seen: string[] = [];
    const c = client(seen);
    const cache = new Map<string, BillingMonth>();
    const h = await readHistory(c, "bill", 6, cache);
    const started = periods.entities.filter((p) => Date.parse(p.startDate) <= Date.now());
    expect(h.months.length).toBe(started.length);
    expect(h.periods[0]!.start).toBe(started[started.length - 1]!.startDate);
    expect(h.months.every((m) => m.tokensIncluded === 350)).toBe(true);
    const closed = h.months.filter((m) => !m.current).length;
    expect(cache.size).toBe(closed);
    seen.length = 0;
    await readHistory(c, "bill", 6, cache);
    expect(seen.filter((u) => u.includes("subscriptionoverview")).length).toBe(started.length - closed);
  });
});
