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
export interface OtherUse { name: string; grouping: string; unit: string; used: number; price: number; cost: number }

export interface BillingReport {
  profile: string;
  at: string;
  periodEnding: string | null;
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

/** Sorts the overview's rows into licences, AI tokens per feature, fair use and other paid usage. */
export function breakDown(raw: RawOverview, profile: string, periodEnding: string | null = null, at = new Date().toISOString()): BillingReport {
  const usages = Array.isArray(raw.usages) ? raw.usages : [];
  const licences: LicenceUse[] = [];
  const fairUse: FairUseUse[] = [];
  const storage: BillingReport["storage"] = [];
  const other: OtherUse[] = [];
  const featureRows: RawUsage[] = [];
  let rollup: RawUsage | undefined;
  let tokenAllocation = 0;

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
      other.push({ name, grouping: g, unit: r.unitOfMeasureType ?? "", used, price, cost: r2(used * price) });
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
    const above = Math.max(0, used - tokenAllocation - prepaid);
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
  return {
    profile,
    at,
    periodEnding,
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
}

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
  const res = await client.get<RawOverview>("/api/v2/billing/subscriptionoverview", query);
  return breakDown(res.body ?? {}, profile, day);
}
