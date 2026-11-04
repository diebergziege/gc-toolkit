import fs from "node:fs";
import path from "node:path";
import { unzip } from "./axl-skills.js";
import { GctkError } from "./errors.js";
import { gctkHome } from "./paths.js";

/**
 * Enablement Radar (UI page "Partner"): the answers of the Genesys partner survey "Partner Demo Org
 * Readiness Checklist", exported from Microsoft Forms as an Excel file. The export has one row per
 * answer; after the respondent columns comes one column per question, each readiness question
 * ("Ready" / "Needs Attention") followed by its "Please describe …" column. gctk keeps the last
 * upload in the gctk home (partner-radar.json) until the user removes it.
 */

export type AnswerStatus = "ready" | "attention" | "unanswered";

export interface RadarTopic {
  id: string;
  label: string;
  group: string;
  /** The question as the form asked it (Forms cuts long descriptions with "..."). */
  question: string;
  description?: string;
  /** status: Ready / Needs Attention; choices: "Select all that apply"; text: any other answer. */
  kind: "status" | "choices" | "text";
}

export interface RadarAnswer {
  topic: string;
  status?: AnswerStatus;
  /** Picked options of a choices question; empty when the partner picked "None". */
  choices?: string[];
  text?: string;
  note?: string;
}

export interface RadarResponse {
  id: string;
  partner: string;
  email?: string;
  /** Local time of the form ("YYYY-MM-DD HH:MM"). */
  submitted?: string;
  hasOrg?: string;
  orgName?: string;
  region?: string;
  subscription?: string;
  answers: RadarAnswer[];
  ready: number;
  attention: number;
  /** Readiness questions answered. */
  answered: number;
}

export interface Radar {
  fileName: string;
  importedAt: string;
  groups: string[];
  topics: RadarTopic[];
  responses: RadarResponse[];
}

const GROUPS = ["Channels", "AI and knowledge", "Agent and supervisor", "Orchestration and platform", "Other"] as const;

/** Short names for the checklist's questions, found by how the question starts. */
const KNOWN: Array<[prefix: string, id: string, label: string, group: (typeof GROUPS)[number]]> = [
  ["is the voice demo ready", "voice", "Voice", "Channels"],
  ["select tts engine", "tts", "TTS engine", "Channels"],
  ["can web messaging", "web-messaging", "Web Messaging", "Channels"],
  ["can email", "email", "Email", "Channels"],
  ["are additional relevant digital channels", "digital-channels", "Other digital channels", "Channels"],
  ["can an outbound", "outbound", "Outbound", "Channels"],
  ["can the following social messaging", "social-messaging", "Social Messaging", "Channels"],
  ["can social listening", "social-listening", "Social Listening", "Channels"],
  ["is at least one virtual agent", "virtual-agent", "Virtual Agent", "AI and knowledge"],
  ["is at least one agentic virtual agent", "agentic-virtual-agent", "Agentic Virtual Agent", "AI and knowledge"],
  ["is knowledge ready", "knowledge", "Knowledge", "AI and knowledge"],
  ["can agent copilot", "agent-copilot", "Agent Copilot", "AI and knowledge"],
  ["can genesys cloud copilot", "gc-copilot", "Genesys Cloud Copilot", "AI and knowledge"],
  ["can virtual supervisor", "virtual-supervisor", "Virtual Supervisor & Supervisor Copilot", "AI and knowledge"],
  ["is the genesys cloud demo org connected to an ai coding assistant", "ai-coding", "AI coding assistant", "AI and knowledge"],
  ["can an agent receive", "agent-workspace", "Agent Workspace", "Agent and supervisor"],
  ["can a supervisor demonstrate analytics", "analytics", "Analytics and Speech & Text Analytics", "Agent and supervisor"],
  ["can quality management", "quality", "Quality Management", "Agent and supervisor"],
  ["can workforce management", "wfm", "Workforce Management", "Agent and supervisor"],
  ["can predictive engagement", "predictive", "Predictive Engagement", "Orchestration and platform"],
  ["is journey management", "journey", "Journey Management", "Orchestration and platform"],
  ["can core architect", "architect", "Architect and routing", "Orchestration and platform"],
  ["is work automation", "work-automation", "Work Automation / Case Management", "Orchestration and platform"],
  ["are the relevant integrations", "integrations", "Integrations", "Orchestration and platform"],
  ["can you demonstrate at least one complete customer interaction", "end-to-end", "End-to-end customer interaction", "Orchestration and platform"],
];

/** Respondent columns, by how the header starts; the form's own Email and Name are "anonymous". */
const META: Array<[prefix: string, key: keyof RadarResponse | "skip"]> = [
  ["partner name", "partner"],
  ["your email address", "email"],
  ["do you currently have an active genesys cloud organization", "hasOrg"],
  ["genesys cloud demo org name", "orgName"],
  ["genesys cloud region", "region"],
  ["select your current subscription", "subscription"],
  ["completion time", "submitted"],
  ["id", "id"],
  ["start time", "skip"],
  ["email", "skip"],
  ["name", "skip"],
  ["last modified time", "skip"],
];

// ------------------------------------------------------------------ xlsx

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (XML_ENTITIES[e] ?? m));

/** The text runs of a string item; phonetic hints (rPh) are not part of the text. */
const textOf = (xml: string) =>
  [...xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "").matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)].map((m) => unescapeXml(m[1] ?? "")).join("");

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

const colIndex = (ref: string) => [...ref.replace(/\d+$/, "").toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** The first sheet of an Excel workbook as rows of cell texts (numbers as Excel writes them). */
export function readXlsx(buf: Buffer): string[][] {
  let files: Map<string, Buffer>;
  try {
    files = new Map(unzip(buf));
  } catch {
    throw new GctkError("INVALID_INPUT", "This is not an Excel file (.xlsx).");
  }
  const read = (name: string) => files.get(name)?.toString("utf8");
  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new GctkError("INVALID_INPUT", "This is not an Excel file (.xlsx).");
  const firstSheet = /<(?:\w+:)?sheet\b([^>]*)>/.exec(workbook)?.[1] ?? "";
  const relId = /\br:id="([^"]*)"/.exec(firstSheet)?.[1];
  const rels = read("xl/_rels/workbook.xml.rels") ?? "";
  const relAttrs = relId ? [...rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*)>/g)].map((m) => m[1]!).find((a) => attr(a, "Id") === relId) : undefined;
  const target = relAttrs ? attr(relAttrs, "Target") : undefined;
  const sheetPath = target ? (target.startsWith("/") ? target.slice(1) : path.posix.normalize(`xl/${target}`)) : "xl/worksheets/sheet1.xml";
  const sheet = read(sheetPath) ?? read("xl/worksheets/sheet1.xml");
  if (!sheet) throw new GctkError("INVALID_INPUT", "The Excel file has no sheet.");
  const shared = [...(read("xl/sharedStrings.xml") ?? "").matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)].map((m) => textOf(m[1] ?? ""));

  const rows: string[][] = [];
  for (const row of sheet.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const cells: string[] = [];
    let next = 0;
    for (const c of (row[1] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ref = attr(c[1]!, "r");
      const i = ref ? colIndex(ref) : next;
      next = i + 1;
      const inner = c[2] ?? "";
      const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      const type = attr(c[1]!, "t");
      const text = type === "s" ? (v !== undefined ? (shared[Number(v)] ?? "") : "") : type === "inlineStr" ? textOf(inner) : v !== undefined ? unescapeXml(v) : "";
      cells[i] = text;
    }
    rows.push(Array.from(cells, (x) => x ?? ""));
  }
  return rows;
}

// --------------------------------------------------------------- survey

/** Excel's day number (Forms writes local time) as "YYYY-MM-DD HH:MM"; text dates stay as they are. */
function excelDate(v: string): string | undefined {
  if (!v.trim()) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return v.trim();
  return new Date(Math.round((n - 25569) * 86400) * 1000).toISOString().slice(0, 16).replace("T", " ");
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const statusOf = (v: string): AnswerStatus | undefined => {
  const s = norm(v);
  return s === "ready" ? "ready" : s === "needs attention" ? "attention" : undefined;
};

const slug = (s: string) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "question";

/** Reads the survey export. Refuses a file that is not this checklist. */
export function parseRadar(buf: Buffer, fileName = "survey.xlsx", now = new Date()): Radar {
  const rows = readXlsx(buf).filter((r) => r.some((c) => c.trim()));
  const header = rows[0] ?? [];
  const partnerCol = header.findIndex((h) => norm(h) === "partner name");
  if (partnerCol < 0) throw new GctkError("INVALID_INPUT", 'This Excel file has no column "Partner Name". Upload the Microsoft Forms export of the Partner Demo Org Readiness Checklist.');
  const body = rows.slice(1).filter((r) => (r[partnerCol] ?? "").trim());
  if (!body.length) throw new GctkError("INVALID_INPUT", "The file has the checklist's columns but no answers yet.");

  const meta = new Map<number, keyof RadarResponse>();
  const questionCols: Array<{ col: number; topic: RadarTopic; noteCol?: number }> = [];
  const used = new Set<string>();
  header.forEach((raw, col) => {
    const h = norm(raw);
    if (!h) return;
    if (h.startsWith("please describe")) {
      const last = questionCols.at(-1);
      if (last && last.noteCol === undefined) last.noteCol = col;
      return;
    }
    if (!questionCols.length) {
      const m = META.find(([p]) => h === p || (p.length > 4 && h.startsWith(p)));
      if (m) {
        if (m[1] !== "skip") meta.set(col, m[1]);
        return;
      }
    }
    const [question, ...rest] = raw.split(/\n\s*Description:\s*\n/i);
    const known = KNOWN.find(([p]) => h.startsWith(p));
    let id = known?.[1] ?? slug(question!);
    while (used.has(id)) id += "-2";
    used.add(id);
    const values = body.map((r) => r[col] ?? "").filter((v) => v.trim());
    const kind: RadarTopic["kind"] = values.some((v) => statusOf(v)) ? "status" : values.some((v) => v.trim().endsWith(";")) || /select all that apply/i.test(raw) ? "choices" : "text";
    const description = rest.join("\n").trim();
    questionCols.push({ col, topic: { id, label: known?.[2] ?? question!.trim(), group: known?.[3] ?? "Other", question: question!.trim(), ...(description ? { description } : {}), kind } });
  });
  const topics = questionCols.map((q) => q.topic);
  if (!topics.some((t) => t.kind === "status")) throw new GctkError("INVALID_INPUT", 'No "Ready" or "Needs Attention" answers in this file. Upload the Microsoft Forms export of the Partner Demo Org Readiness Checklist.');

  const responses = body.map((r, i): RadarResponse => {
    const resp: RadarResponse = { id: "", partner: "", answers: [], ready: 0, attention: 0, answered: 0 };
    for (const [col, key] of meta) {
      const v = (r[col] ?? "").trim();
      if (!v) continue;
      if (key === "submitted") resp.submitted = excelDate(v);
      else (resp as unknown as Record<string, string>)[key] = v;
    }
    resp.partner = (r[partnerCol] ?? "").replace(/\s+/g, " ").trim();
    resp.id ||= String(i + 1);
    for (const { col, topic, noteCol } of questionCols) {
      const v = (r[col] ?? "").trim();
      const note = noteCol !== undefined ? (r[noteCol] ?? "").trim() : "";
      const a: RadarAnswer = { topic: topic.id };
      if (topic.kind === "status") {
        a.status = statusOf(v) ?? "unanswered";
        if (a.status === "ready") resp.ready++;
        if (a.status === "attention") resp.attention++;
        if (a.status !== "unanswered") resp.answered++;
        if (v && !statusOf(v)) a.text = v;
      } else if (topic.kind === "choices") {
        a.choices = v.split(";").map((x) => x.trim()).filter((x) => x && norm(x) !== "none");
      } else if (v) a.text = v;
      if (note) a.note = note;
      resp.answers.push(a);
    }
    return resp;
  });
  return { fileName: path.basename(fileName) || "survey.xlsx", importedAt: now.toISOString(), groups: GROUPS.filter((g) => topics.some((t) => t.group === g)), topics, responses };
}

// -------------------------------------------------------------- storage

export const radarFile = () => path.join(gctkHome(), "partner-radar.json");

export function loadRadar(): Radar | null {
  try {
    return JSON.parse(fs.readFileSync(radarFile(), "utf8")) as Radar;
  } catch {
    return null;
  }
}

export function importRadar(buf: Buffer, fileName?: string): Radar {
  const radar = parseRadar(buf, fileName);
  fs.mkdirSync(gctkHome(), { recursive: true });
  const tmp = `${radarFile()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(radar)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, radarFile());
  return radar;
}

export function removeRadar(): boolean {
  if (!fs.existsSync(radarFile())) return false;
  fs.rmSync(radarFile());
  return true;
}
