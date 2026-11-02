import type { GenesysClient } from "./client.js";
import { DOCS, type DocId } from "./pricing.js";

/**
 * Live billing of one org, read-only, for the Pricing page's "Live billing" tab. The source is
 * GET /api/v2/billing/subscriptionoverview, the internal endpoint behind Admin → Subscription →
 * Billing & Usage (not in the public API docs, so its shape may change; checked in a dev org
 * 2026-11-02). It lists one row per billing part: `grouping` says what it is, `usageQuantity` the
 * period's use, `prepayQuantity` the commitment or allocation, `bundleQuantity` the units per token
 * of an AI feature (grouping `rollup-usage`; their total is the `rollup` row, the free tokens the
 * `fair-use` token row). Quantities arrive as strings.
 */

export interface RawUsage {
  name?: string;
  partNumber?: string;
  grouping?: string;
  unitOfMeasureType?: string;
  usageQuantity?: string;
  overagePrice?: string;
  prepayQuantity?: string;
  prepayPrice?: string;
  bundleQuantity?: string;
  usageNotes?: string;
}
export interface RawOverview {
  currency?: string;
  subscriptionType?: string;
  isInRampPeriod?: boolean;
  rampPeriodStartingTimestamp?: string;
  rampPeriodEndingTimestamp?: string;
  minimumMonthlyAmount?: string;
  usages?: RawUsage[];
}

export interface LicenceUse { name: string; partNumber?: string; kind: "named" | "concurrent" | "hourly" | "device" | "other"; unit: string; used: number; committed: number; prepayPrice: number; overagePrice: number; above: number; cost: number }
export interface TokenFeature { name: string; reported: number; unitsPerToken: number | null; rate: string; tokens: number | null; units: number | null }
export interface FairUseUse { name: string; unit: string; used: number; allocation: number; overage: number; price: number; cost: number }
export interface OtherUse { name: string; grouping: string; unit: string; used: number; included: number; price: number; cost: number }

export interface BillingPeriod { start: string; end: string }
export interface Insight { level: "alert" | "warn" | "ok" | "info"; title: string; text: string }
export interface Forecast {
  /** Days in the period divided by days gone: how much the usage so far is scaled up. */
  factor: number;
  tokens: number | null;
  tokensAbove: number;
  tokenCost: number;
  fairUse: Array<{ name: string; used: number; overage: number; cost: number }>;
  estimated: number;
}

export interface BillingReport {
  profile: string;
  at: string;
  periodEnding: string | null;
  /** The billing period read, from GET /api/v2/billing/periods; null when that list is not readable. */
  period: { start: string; end: string; days: number; elapsed: number; current: boolean } | null;
  /** Usage so far scaled to the whole period (current period, from day 3 on); licences counted by peak stay as they are. */
  forecast: Forecast | null;
  /** What an admin should notice first, most urgent first. */
  insights: Insight[];
  currency: string;
  subscriptionType: string;
  minimumMonthly: number;
  ramp: { inRamp: boolean; from?: string; to?: string } | null;
  licences: LicenceUse[];
  tokens: {
    name: string;
    used: number;
    allocation: number;
    prepaid: number;
    price: number;
    above: number;
    cost: number;
    /** How the feature rows count: in tokens, in their own units (minutes, sessions …), or unknown (no use yet, or the sums disagree). */
    quantities: "tokens" | "units" | "unknown";
    features: TokenFeature[];
    /** Tokens in the total that no feature row explains: per-user features such as Agent Copilot or speech and text analytics. */
    perUser: number | null;
  } | null;
  fairUse: FairUseUse[];
  storage: Array<{ name: string; gb: number }>;
  other: OtherUse[];
  /** Sum of the cost columns; the invoice is authoritative. */
  estimated: number;
  rows: number;
  docs: Array<{ title: string; url: string }>;
}

const n = (v: unknown) => {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Token rates by feature name (the rows' bundleQuantity cannot say "1.2 tokens per interaction"). */
const FEATURE_RATES: Array<[RegExp, number, string]> = [
  [/agentic virtual agent/i, 1 / 1.2, "1.2 tokens per interaction"],
  [/virtual agent/i, 2, "0.5 tokens per interaction"],
  [/bot flow.*voice/i, 17, "17 minutes per token"],
  [/bot flow.*digital/i, 51, "51 sessions per token"],
  [/predictive routing/i, 17, "17 routed interactions per token"],
  [/messaging|post (response|ingestion)/i, 400, "400 messages or posts per token"],
  [/translate/i, 2, "2 translations per token"],
  [/scoring/i, 20, "20 evaluations per token"],
  [/summary/i, 50, "50 summaries per token"],
  [/copilot action/i, 20, "20 AI actions per token"],
];
function unitsPerToken(row: RawUsage): { per: number | null; rate: string } {
  const name = row.name ?? "";
  for (const [re, per, rate] of FEATURE_RATES) if (re.test(name)) return { per, rate };
  const bundle = n(row.bundleQuantity);
  return bundle > 0 ? { per: bundle, rate: `${bundle} per token` } : { per: null, rate: "" };
}

const close = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= Math.max(1, b * tolerance);

const licenceKind = (r: RawUsage): LicenceUse["kind"] => {
  const g = r.grouping ?? "";
  if (r.unitOfMeasureType === "hour" || /hourly/i.test(r.name ?? "")) return "hourly";
  if (g === "device") return "device";
  if (/concurrent/.test(g) || /concurrent/i.test(r.name ?? "")) return "concurrent";
  if (/license/.test(g)) return "named";
  return "other";
};

const LICENCE_GROUPS = /license|^device$/;
const FAIR_USE_GROUPS: Record<string, string> = { ivr: "Basic routing / IVR", api: "API requests", storage: "Data storage" };

const DAY = 86_400_000;
const FORECAST_FROM_DAYS = 3;

function periodInfo(period: BillingPeriod | null, at: string): BillingReport["period"] {
  if (!period) return null;
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  const now = Date.parse(at);
  if (![start, end, now].every(Number.isFinite) || end <= start) return null;
  const days = Math.round((end + 1 - start) / DAY);
  const current = now >= start && now <= end;
  const elapsed = current ? Math.round(((now - start) / DAY) * 10) / 10 : now > end ? days : 0;
  return { start: period.start, end: period.end, days, elapsed, current };
}

/** Sorts the overview's rows into licences, AI tokens per feature, fair use and other paid usage. */
export function breakDown(raw: RawOverview, profile: string, periodEnding: string | null = null, at = new Date().toISOString(), billingPeriod: BillingPeriod | null = null): BillingReport {
  const usages = Array.isArray(raw.usages) ? raw.usages : [];
  const licences: LicenceUse[] = [];
  const fairUse: FairUseUse[] = [];
  const storage: BillingReport["storage"] = [];
  const other: OtherUse[] = [];
  const featureRows: RawUsage[] = [];
  let rollup: RawUsage | undefined;
  let tokenAllocation = 0;
  // Allowances for metered parts (cases, transcription minutes …) come as their own fair-use row with the part's name.
  const allowances = new Map<string, number>();
  for (const r of usages) if (r.grouping === "fair-use" && r.unitOfMeasureType !== "token" && r.name) allowances.set(r.name, (allowances.get(r.name) ?? 0) + n(r.usageQuantity));

  for (const r of usages) {
    const g = r.grouping ?? "";
    const name = r.name ?? r.partNumber ?? "?";
    const used = n(r.usageQuantity);
    if (g === "rollup") rollup = r;
    else if (g === "rollup-usage") featureRows.push(r);
    else if (g === "fair-use") {
      if (r.unitOfMeasureType === "token") tokenAllocation += used;
    } else if (g === "storage-category") storage.push({ name, gb: used });
    else if (LICENCE_GROUPS.test(g)) {
      const committed = n(r.prepayQuantity);
      const above = Math.max(0, used - committed);
      const prepayPrice = n(r.prepayPrice);
      const overagePrice = n(r.overagePrice);
      if (!used && !committed) continue;
      licences.push({ name, partNumber: r.partNumber, kind: licenceKind(r), unit: r.unitOfMeasureType ?? "", used, committed, prepayPrice, overagePrice, above, cost: r2(committed * prepayPrice + above * overagePrice) });
    } else if (allowances.has(name) && !LICENCE_GROUPS.test(g)) {
      const allocation = allowances.get(name)!;
      const price = n(r.overagePrice) || n(r.prepayPrice);
      const overage = Math.max(0, used - allocation);
      fairUse.push({ name, unit: r.unitOfMeasureType ?? "", used, allocation, overage, price, cost: r2(overage * price) });
    } else if (g in FAIR_USE_GROUPS || (r.usageNotes && /fairUse/.test(r.usageNotes))) {
      let usedF = used;
      let allocation = n(r.prepayQuantity);
      if (r.usageNotes) {
        try {
          const notes = JSON.parse(r.usageNotes) as Record<string, string>;
          usedF = n(notes.actuals);
          allocation = n(notes.fairUse);
        } catch {
          // keep the row's own quantities
        }
      }
      const price = n(r.overagePrice) || n(r.prepayPrice);
      const overage = Math.max(0, usedF - allocation);
      fairUse.push({ name: FAIR_USE_GROUPS[g] ?? name, unit: r.unitOfMeasureType ?? "", used: usedF, allocation, overage, price, cost: r2(overage * price) });
    } else if (used > 0) {
      const price = n(r.overagePrice);
      const included = n(r.prepayQuantity);
      other.push({ name, grouping: g, unit: r.unitOfMeasureType ?? "", used, included, price, cost: r2(included * n(r.prepayPrice) + Math.max(0, used - included) * price) });
    }
  }

  let tokens: BillingReport["tokens"] = null;
  if (rollup || featureRows.length) {
    const used = n(rollup?.usageQuantity);
    const prepaid = n(rollup?.prepayQuantity);
    const price = n(rollup?.overagePrice) || n(rollup?.prepayPrice);
    const rated = featureRows.map((r) => ({ r, ...unitsPerToken(r) }));
    const sumRaw = rated.reduce((s, x) => s + n(x.r.usageQuantity), 0);
    const sumConverted = rated.reduce((s, x) => s + (x.per ? n(x.r.usageQuantity) / x.per : 0), 0);
    // The total may hold per-user features (Copilot, analytics) that have no row, so the rows add up
    // to at most the total; rounding up per row can add one token each.
    let quantities: "tokens" | "units" | "unknown" = "unknown";
    const slack = rated.length;
    if (used > 0 && sumRaw > 0) {
      if (close(sumRaw, used, 0.02)) quantities = "tokens";
      else if (sumRaw > used + slack && sumConverted <= used + slack) quantities = "units";
      else if (close(sumConverted, used, 0.05)) quantities = "units";
    }
    const features: TokenFeature[] = rated
      .map(({ r, per, rate }) => {
        const reported = n(r.usageQuantity);
        const tokensF = quantities === "tokens" ? reported : quantities === "units" && per ? reported / per : null;
        const units = quantities === "units" ? reported : quantities === "tokens" && per ? reported * per : null;
        return { name: r.name ?? "?", reported, unitsPerToken: per, rate, tokens: tokensF === null ? null : r2(tokensF), units: units === null ? null : r2(units) };
      })
      .sort((a, b) => (b.tokens ?? b.reported) - (a.tokens ?? a.reported) || a.name.localeCompare(b.name));
    const explained = features.reduce((s, f) => s + (f.tokens ?? 0), 0);
    const residual = r2(Math.max(0, used - explained));
    // Genesys bills whole tokens: the period's total is rounded up before the allocation is taken off.
    const above = Math.max(0, Math.ceil(used - 1e-9) - tokenAllocation - prepaid);
    tokens = {
      name: rollup?.name ?? "AI Experience Tokens",
      used,
      allocation: tokenAllocation,
      prepaid,
      price,
      above,
      cost: r2(prepaid * n(rollup?.prepayPrice) + above * n(rollup?.overagePrice)),
      quantities,
      features,
      perUser: quantities === "unknown" ? null : residual >= 1 ? residual : 0,
    };
  }

  licences.sort((a, b) => b.cost - a.cost || b.used - a.used || a.name.localeCompare(b.name));
  other.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
  const minimumMonthly = n(raw.minimumMonthlyAmount);
  const estimated = r2(licences.reduce((s, l) => s + l.cost, 0) + (tokens?.cost ?? 0) + fairUse.reduce((s, f) => s + f.cost, 0) + other.reduce((s, o) => s + o.cost, 0));
  const docIds: DocId[] = ["usageReports", "tokens", "fairUse", "billingApi"];
  const period = periodInfo(billingPeriod, at);
  let forecast: Forecast | null = null;
  if (period?.current && period.elapsed >= FORECAST_FROM_DAYS) {
    const factor = period.days / period.elapsed;
    let tokensF: number | null = null;
    let tokensAbove = 0;
    let tokenCost = 0;
    if (tokens) {
      tokensF = Math.ceil(tokens.used * factor - 1e-9);
      tokensAbove = Math.max(0, tokensF - tokens.allocation - tokens.prepaid);
      tokenCost = r2(tokens.prepaid * n(rollup?.prepayPrice) + tokensAbove * tokens.price);
    }
    const fu = fairUse.map((f) => {
      const used = r2(f.used * factor);
      const overage = Math.max(0, r2(used - f.allocation));
      return { name: f.name, used, overage, cost: r2(overage * f.price) };
    });
    const licenceCost = licences.reduce((s, l) => {
      if (l.kind !== "hourly") return s + l.cost;
      const above = Math.max(0, l.used * factor - l.committed);
      return s + l.committed * l.prepayPrice + above * l.overagePrice;
    }, 0);
    const sum = licenceCost + tokenCost + fu.reduce((s, f) => s + f.cost, 0) + other.reduce((s, o) => s + o.cost * factor, 0);
    forecast = { factor: r2(factor), tokens: tokensF, tokensAbove, tokenCost, fairUse: fu, estimated: r2(Math.max(sum, minimumMonthly)) };
  }
  const report: BillingReport = {
    profile,
    at,
    periodEnding,
    period,
    forecast,
    insights: [],
    currency: raw.currency ?? "USD",
    subscriptionType: raw.subscriptionType ?? "",
    minimumMonthly,
    ramp: raw.rampPeriodStartingTimestamp || raw.isInRampPeriod ? { inRamp: Boolean(raw.isInRampPeriod), from: raw.rampPeriodStartingTimestamp, to: raw.rampPeriodEndingTimestamp } : null,
    licences,
    tokens,
    fairUse,
    storage,
    other,
    estimated: Math.max(estimated, minimumMonthly),
    rows: usages.length,
    docs: docIds.map((id) => DOCS[id]),
  };
  report.insights = billingInsights(report);
  return report;
}

const num = (v: number, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const LEVEL_ORDER: Record<Insight["level"], number> = { alert: 0, warn: 1, ok: 2, info: 3 };

/** Plain-language findings for an admin, most urgent first. */
export function billingInsights(r: BillingReport): Insight[] {
  const out: Insight[] = [];
  const money = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${r.currency}`;
  const f = r.forecast;
  const by = r.period?.current ? `by ${dayLabel(r.period.end)}` : "by the end of the period";
  const t = r.tokens;
  if (t) {
    const avail = t.allocation + t.prepaid;
    const included = t.prepaid ? `${num(t.allocation)} free and ${num(t.prepaid)} prepaid` : `${num(t.allocation)} free`;
    if (t.above > 0) {
      out.push({ level: "alert", title: "AI tokens: more used than included",
        text: `The org used ${num(t.used)} tokens, ${num(t.above)} more than the ${included} ones. That adds ${money(t.above * t.price)} so far${f?.tokens != null ? `; at this pace about ${money(f.tokensAbove * t.price)} ${by}` : ""}.` });
    } else if (f?.tokens != null && f.tokensAbove > 0) {
      out.push({ level: "warn", title: "AI tokens: likely to run out this period",
        text: `${num(t.used)} of ${num(avail)} included tokens are used. At this pace the org reaches about ${num(f.tokens)} ${by}: ${num(f.tokensAbove)} more than included, about ${money(f.tokensAbove * t.price)}.` });
    } else if (avail > 0) {
      out.push({ level: "ok", title: "AI tokens: within the included ones",
        text: `${num(t.used, 1)} of ${num(avail)} included tokens used (${Math.round((t.used / avail) * 100)} %)${f?.tokens != null ? `; at this pace about ${num(f.tokens)} ${by}` : ""}. Nothing extra to pay for tokens.` });
    }
    const parts = [...t.features.filter((x) => (x.tokens ?? 0) > 0).map((x) => ({ name: x.name, tokens: x.tokens! })), ...(t.perUser ? [{ name: "Per-user AI features (Agent Copilot, speech and text analytics …)", tokens: t.perUser }] : [])]
      .sort((a, b) => b.tokens - a.tokens);
    if (parts.length && t.used > 0) {
      const top = parts[0]!;
      out.push({ level: "info", title: `Most AI tokens go to ${top.name}`,
        text: `It accounts for ${Math.round((top.tokens / t.used) * 100)} % of this period's tokens (${num(top.tokens, 1)} of ${num(t.used, 1)}).${parts[1] ? ` Next: ${parts[1].name}, ${Math.round((parts[1].tokens / t.used) * 100)} %.` : ""}` });
    }
  }
  const SHOW = 3;
  const list = (xs: Array<{ name: string; cost: number }>) => xs.slice(0, SHOW).map((x) => `${x.name} (${money(x.cost)})`).join(", ");
  const over = r.licences.filter((l) => l.committed > 0 && l.above > 0).sort((a, b) => b.above * b.overagePrice - a.above * a.overagePrice);
  for (const l of over.slice(0, SHOW)) {
    out.push({ level: "alert", title: `${l.name}: ${num(l.above)} above the commitment`,
      text: `The contract commits ${num(l.committed)}; the org used ${num(l.used)}. Each one above costs ${money(l.overagePrice)}, ${money(l.above * l.overagePrice)} in all. If this is normal now, a higher commitment is usually cheaper.` });
  }
  if (over.length > SHOW) {
    const rest = over.slice(SHOW);
    out.push({ level: "alert", title: `${rest.length} more licences above their commitment`,
      text: `Together ${money(rest.reduce((s, l) => s + l.above * l.overagePrice, 0))} above the commitments. The licence chart below shows them in red.` });
  }
  const unusedOf = (l: LicenceUse) => (l.committed - l.used) * l.prepayPrice;
  const unused = r.licences.filter((l) => l.committed > l.used && l.prepayPrice > 0 && !(l.kind === "hourly" && r.period?.current)).sort((a, b) => unusedOf(b) - unusedOf(a));
  for (const l of unused.slice(0, SHOW)) {
    const n = l.committed - l.used;
    out.push({ level: r.period?.current ? "info" : "warn", title: `${l.name}: ${num(n)} committed but not used${r.period?.current ? " so far" : ""}`,
      text: `The contract pays for ${num(l.committed)}; the org used ${num(l.used)}. The unused ones still cost ${money(unusedOf(l))} a month.${r.period?.current ? " More users may still log in before the period ends." : ""}` });
  }
  if (unused.length > SHOW) {
    out.push({ level: r.period?.current ? "info" : "warn", title: `${unused.length - SHOW} more licences with unused commitment`, text: `Together ${money(unused.slice(SHOW).reduce((s, l) => s + unusedOf(l), 0))} a month for licences nobody used.` });
  }
  const byUse = r.licences.filter((l) => l.committed === 0 && l.cost > 0).sort((a, b) => b.cost - a.cost);
  if (byUse.length) {
    out.push({ level: "info", title: `${byUse.length} part${byUse.length === 1 ? "" : "s"} charged by use, without a commitment`,
      text: `Together ${money(byUse.reduce((s, l) => s + l.cost, 0))} this period. Biggest: ${list(byUse)}. A commitment can lower the price if the use is steady.` });
  }
  for (const fu of r.fairUse) {
    const pct = fu.allocation ? Math.round((fu.used / fu.allocation) * 100) : 0;
    const fc = f?.fairUse.find((x) => x.name === fu.name);
    if (fu.overage > 0) {
      out.push({ level: "alert", title: `${fu.name}: over the included allowance`,
        text: `${num(fu.used, 2)} of ${num(fu.allocation, 2)} ${fu.unit} used; the ${num(fu.overage, 2)} above cost ${money(fu.cost)}.` });
    } else if (fc && fc.overage > 0) {
      out.push({ level: "warn", title: `${fu.name}: likely to go over the allowance`,
        text: `${pct} % of the allowance is used. At this pace the org reaches about ${num(fc.used)} of ${num(fu.allocation)} ${fu.unit} ${by}, about ${money(fc.cost)} extra.` });
    } else if (pct >= 80) {
      out.push({ level: "warn", title: `${fu.name}: ${pct} % of the allowance used`, text: `Use above ${num(fu.allocation, 2)} ${fu.unit} is charged at ${money(fu.price)} per ${fu.unit}.` });
    }
  }
  if (r.minimumMonthly > 0 && r.estimated === r.minimumMonthly) {
    out.push({ level: "info", title: "The minimum monthly amount applies",
      text: `The charges add up to less than the contract's minimum of ${money(r.minimumMonthly)} a month, so the minimum is what the org pays.` });
  }
  if (r.ramp?.inRamp) {
    out.push({ level: "info", title: `Ramp period${r.ramp.to ? ` until ${dayLabel(r.ramp.to)}` : ""}`,
      text: "The contract is still ramping up: commitments may be lower or not apply yet, so this month's bill can differ from later ones. The contract has the details." });
  }
  if (r.estimated === 0 && !out.some((x) => x.level === "alert" || x.level === "warn")) {
    out.push({ level: "ok", title: "Nothing is charged this period",
      text: `Everything the org used is within what the subscription includes${r.subscriptionType ? ` (${r.subscriptionType})` : ""}.` });
  }
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/** The org's billing periods, oldest first. Empty when the list is not readable. */
export async function readPeriods(client: GenesysClient): Promise<BillingPeriod[]> {
  try {
    const res = await client.get<{ entities?: Array<{ startDate?: string; endDate?: string }> }>("/api/v2/billing/periods", { pageSize: "100" });
    return (res.body?.entities ?? [])
      .filter((p): p is { startDate: string; endDate: string } => Boolean(p.startDate && p.endDate))
      .map((p) => ({ start: p.startDate, end: p.endDate }))
      .sort((a, b) => a.start.localeCompare(b.start));
  } catch {
    return [];
  }
}

const periodContaining = (periods: BillingPeriod[], ts: number) => periods.find((p) => Date.parse(p.start) <= ts && ts <= Date.parse(p.end)) ?? null;

/** periodEnding: a day (YYYY-MM-DD) in the billing period to read; empty = the current period. */
export async function readBilling(client: GenesysClient, profile: string, periodEnding?: string): Promise<BillingReport> {
  const query: Record<string, string> = {};
  let day: string | null = null;
  if (periodEnding) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnding)) throw new Error("periodEnding must be a date (YYYY-MM-DD).");
    const ts = Date.parse(`${periodEnding}T23:59:59.999Z`);
    if (!Number.isFinite(ts)) throw new Error("periodEnding must be a date (YYYY-MM-DD).");
    query.periodEndingTimestamp = String(ts);
    day = periodEnding;
  }
  const at = new Date().toISOString();
  const [res, periods] = await Promise.all([client.get<RawOverview>("/api/v2/billing/subscriptionoverview", query), readPeriods(client)]);
  const period = periodContaining(periods, query.periodEndingTimestamp ? Number(query.periodEndingTimestamp) : Date.parse(at));
  return breakDown(res.body ?? {}, profile, day, at, period);
}

export interface BillingMonth {
  start: string;
  end: string;
  current: boolean;
  error?: string;
  tokensUsed: number | null;
  tokensIncluded: number;
  tokensForecast: number | null;
  features: Array<{ name: string; tokens: number }>;
  perUser: number | null;
  costs: { licences: number; tokens: number; fairUse: number; other: number };
  estimated: number;
  estimatedForecast: number | null;
}

function summarise(r: BillingReport, p: BillingPeriod): BillingMonth {
  const t = r.tokens;
  return {
    start: p.start,
    end: p.end,
    current: Boolean(r.period?.current),
    tokensUsed: t ? t.used : null,
    tokensIncluded: t ? t.allocation + t.prepaid : 0,
    tokensForecast: r.forecast?.tokens ?? null,
    features: t ? t.features.filter((f) => (f.tokens ?? 0) > 0).map((f) => ({ name: f.name, tokens: f.tokens! })) : [],
    perUser: t?.perUser ?? null,
    costs: {
      licences: r2(r.licences.reduce((s, l) => s + l.cost, 0)),
      tokens: t?.cost ?? 0,
      fairUse: r2(r.fairUse.reduce((s, f) => s + f.cost, 0)),
      other: r2(r.other.reduce((s, o) => s + o.cost, 0)),
    },
    estimated: r.estimated,
    estimatedForecast: r.forecast?.estimated ?? null,
  };
}

export interface BillingHistory { profile: string; at: string; periods: BillingPeriod[]; months: BillingMonth[] }

/** The last `count` billing periods up to the current one, oldest first. Closed periods do not change, so `cache` keeps them. */
export async function readHistory(client: GenesysClient, profile: string, count = 6, cache?: Map<string, BillingMonth>): Promise<BillingHistory> {
  const at = new Date().toISOString();
  const now = Date.parse(at);
  const started = (await readPeriods(client)).filter((p) => Date.parse(p.start) <= now);
  const months = await Promise.all(started.slice(-count).map(async (p): Promise<BillingMonth> => {
    const key = `${profile}|${p.start}`;
    const closed = Date.parse(p.end) < now;
    const hit = closed ? cache?.get(key) : undefined;
    if (hit) return hit;
    try {
      const res = await client.get<RawOverview>("/api/v2/billing/subscriptionoverview", { periodEndingTimestamp: String(Date.parse(p.end)) });
      const m = summarise(breakDown(res.body ?? {}, profile, p.end.slice(0, 10), at, p), p);
      if (closed) cache?.set(key, m);
      return m;
    } catch (err) {
      return { start: p.start, end: p.end, current: !closed, error: (err as Error).message, tokensUsed: null, tokensIncluded: 0, tokensForecast: null, features: [], perUser: null, costs: { licences: 0, tokens: 0, fairUse: 0, other: 0 }, estimated: 0, estimatedForecast: null };
    }
  }));
  return { profile, at, periods: [...started].reverse(), months };
}
