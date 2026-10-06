import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { GenesysClient } from "./client.js";
import { GctkError } from "./errors.js";
import { paths } from "./paths.js";
import { listRecords, sendStep, type DemoRequest } from "./demo-log.js";

/**
 * Demo ready (UI page): fills one agent's home screen with demo data, one section per component
 * (coaching, learning, evaluations, ...). A section reads the current state and returns the next
 * wave of changes that are still missing, so existing objects are reused and a second run creates
 * nothing twice. The runner sends each wave to the org as soon as the user pressed the button and
 * records it (demo-log.ts), so Clean up removes exactly what the page did.
 */

export interface DemoStep {
  title: string;
  request: DemoRequest;
  /** Marks one-off actions (e.g. sending an interaction) so the run does not repeat them. */
  subject?: string;
}

export interface DemoWave {
  steps: DemoStep[];
  notes: string[];
  /** Genesys is still working on something (e.g. a flow deploy): the run stops and is continued later. */
  busy?: string;
}

/** What next() gets besides the input: the org's client and the run's group. */
export interface DemoEnv {
  ctx: { client: GenesysClient };
  group: string;
  now?: Date;
}

export interface DemoSection<I> {
  id: string;
  title: string;
  /** Validates the page's input; throws INVALID_INPUT. */
  parse(input: unknown, now?: Date): I;
  status(client: GenesysClient, userId: string, now?: Date): Promise<unknown>;
  next(userId: string, input: I, env: DemoEnv): Promise<DemoWave>;
}

/** What the page shows: built sections and the ones planned next. */
export const DEMO_SECTIONS: Array<{ id: string; title: string; what: string; ready: boolean }> = [
  { id: "coaching", title: "Coaching", what: "Coaching appointments in the agent's calendar: upcoming 1:1s and coaching sessions, some already completed.", ready: true },
  { id: "learning", title: "Learning", what: "Learning modules assigned to the agent, using published modules of the org or new ones.", ready: true },
  { id: "sta", title: "Speech and text analytics", what: "Everything speech and text analytics needs (text analytics, sentiment, agent empathy, voice transcription, a program with topics) and the agent's queue in that program.", ready: true },
  { id: "evaluations", title: "Evaluations", what: "Released evaluations of the agent's conversations, with an existing evaluation form or a new one.", ready: true },
  { id: "scorecard", title: "Scorecard", what: "Gamification switched on and the agent in a performance profile (an existing one, or a new one with metrics that fit a demo), so the scorecard and leaderboard show values.", ready: true },
  { id: "schedule", title: "Schedule", what: "The agent in a management unit with a published schedule (shifts, breaks, lunch, training) for this week and the next, in an existing business unit or a new one.", ready: true },
];

export const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (msg: string) => new GctkError("INVALID_INPUT", msg);

function assertId(id: unknown, what: string): string {
  if (typeof id !== "string" || !USER_ID_RE.test(id)) throw invalid(`${what} must be an id.`);
  return id;
}

function text(v: unknown, what: string, max: number, required = true): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw invalid(`${what} is required.`);
  if (s.length > max) throw invalid(`${what} is longer than ${max} characters.`);
  return s;
}

/**
 * Objects created by this run's requests (POST to path), by name. Genesys' name searches lag a
 * few seconds behind a create, so a section checks these too before it creates something again.
 */
export function createdInRun(group: string, path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of listRecords({ group, status: "applied", limit: 1000 })) {
    const id = (p.result?.body as { id?: string } | undefined)?.id;
    const name = (p.request.body as { name?: string } | undefined)?.name;
    if (p.request.method === "POST" && p.request.path === path && id && name) out.set(name, id);
  }
  return out;
}

/** Like createdInRun, over every Demo ready run of the org (the latest create per name wins). */
export function createdByDemo(profile: string, path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of listRecords({ profile, status: "applied", limit: 100_000 }).reverse()) {
    const id = (p.result?.body as { id?: string } | undefined)?.id;
    const name = (p.request.body as { name?: string } | undefined)?.name;
    if (p.group?.startsWith("demo ready · ") && p.request.method === "POST" && p.request.path === path && id && name) out.set(name, id);
  }
  return out;
}

// --------------------------------------------------------------- coaching

export interface CoachingItem {
  name: string;
  description: string;
  /** ISO date-time, in the future (Genesys refuses appointments in the past). */
  dateStart: string;
  lengthInMinutes: number;
  facilitatorId?: string;
  /** Mark as completed after creating it, so the agent also sees a finished session. Cannot be undone. */
  completed?: boolean;
}

export interface CoachingInput {
  appointments: CoachingItem[];
  /** Appointment ids to delete (only scheduled ones can be deleted). */
  remove: string[];
}

export interface Appointment {
  id: string;
  name: string;
  description?: string;
  dateStart: string;
  lengthInMinutes?: number;
  status?: string;
  facilitatorId?: string;
  isOverdue?: boolean;
}

/** Suggestions the page offers; dates are relative to the next working days in the browser's time zone. */
export const COACHING_TEMPLATES: Array<Omit<CoachingItem, "dateStart" | "facilitatorId"> & { workdayOffset: number; time: string }> = [
  { name: "Kick-off: goals for this quarter", description: "Agree on three personal goals for the quarter and how we measure them.", workdayOffset: 1, time: "09:00", lengthInMinutes: 30, completed: true },
  { name: "Weekly 1:1 with your team lead", description: "Last week's KPIs, open questions and priorities for the coming week.", workdayOffset: 1, time: "10:30", lengthInMinutes: 30 },
  { name: "Coaching: handling escalations with empathy", description: "Listen to two recent interactions together and practise de-escalation phrases.", workdayOffset: 2, time: "14:00", lengthInMinutes: 45 },
  { name: "Quality review: first contact resolution", description: "Go through the latest evaluation and agree on one improvement.", workdayOffset: 5, time: "11:00", lengthInMinutes: 30 },
];

const MAX_APPOINTMENTS = 20;
const sameMinute = (a: string, b: string) => Math.floor(Date.parse(a) / 60_000) === Math.floor(Date.parse(b) / 60_000);

export async function listAppointments(client: GenesysClient, userId: string, now = new Date()): Promise<Appointment[]> {
  const day = 24 * 60 * 60 * 1000;
  const interval = `${new Date(now.getTime() - 60 * day).toISOString()}/${new Date(now.getTime() + 90 * day).toISOString()}`;
  const { first, paged } = await client.getAll("/api/v2/coaching/appointments", { userIds: userId, interval, pageSize: 100, sortOrder: "Asc" }, 500);
  type Raw = { id?: string; name?: string; description?: string; dateStart?: string; lengthInMinutes?: number; status?: string; facilitator?: { id?: string }; isOverdue?: boolean };
  const raw = (paged?.items ?? (first.body as { entities?: Raw[] }).entities ?? []) as Raw[];
  return raw
    .filter((a): a is Raw & { id: string; name: string; dateStart: string } => Boolean(a.id && a.name && a.dateStart))
    .map((a) => ({ id: a.id, name: a.name, description: a.description, dateStart: a.dateStart, lengthInMinutes: a.lengthInMinutes, status: a.status, facilitatorId: a.facilitator?.id, isOverdue: a.isOverdue }))
    .sort((a, b) => a.dateStart.localeCompare(b.dateStart));
}

export const coachingSection: DemoSection<CoachingInput> = {
  id: "coaching",
  title: "Coaching",

  parse(input, now = new Date()) {
    const i = (input ?? {}) as { appointments?: unknown; remove?: unknown };
    const list = Array.isArray(i.appointments) ? i.appointments : [];
    if (list.length > MAX_APPOINTMENTS) throw invalid(`At most ${MAX_APPOINTMENTS} appointments at a time.`);
    const appointments = list.map((raw, n): CoachingItem => {
      const a = (raw ?? {}) as Record<string, unknown>;
      const what = `Appointment ${n + 1}`;
      const name = text(a.name, `${what}: name`, 200);
      const start = typeof a.dateStart === "string" ? Date.parse(a.dateStart) : NaN;
      if (!Number.isFinite(start)) throw invalid(`${what} ("${name}"): the start is not a date.`);
      if (start <= now.getTime() + 60_000) throw invalid(`${what} ("${name}") starts in the past; Genesys Cloud only accepts future appointments.`);
      const length = Number(a.lengthInMinutes);
      if (!Number.isInteger(length) || length < 5 || length > 480) throw invalid(`${what} ("${name}"): the length must be 5 to 480 minutes.`);
      return {
        name,
        // The API requires a description.
        description: text(a.description, `${what}: description`, 1000, false) || name,
        dateStart: new Date(start).toISOString().replace(/:\d\d\.\d{3}Z$/, ":00Z"),
        lengthInMinutes: length,
        ...(a.facilitatorId ? { facilitatorId: assertId(a.facilitatorId, `${what}: facilitator`) } : {}),
        ...(a.completed === true ? { completed: true } : {}),
      };
    });
    const remove = (Array.isArray(i.remove) ? i.remove : []).map((id) => {
      if (typeof id !== "string" || !USER_ID_RE.test(id)) throw invalid("remove must list appointment ids.");
      return id;
    });
    if (!appointments.length && !remove.length) throw invalid("Choose at least one appointment.");
    return { appointments, remove };
  },

  status: (client, userId, now) => listAppointments(client, userId, now).then((appointments) => ({ appointments })),

  async next(userId, input, { ctx, now }) {
    const current = await listAppointments(ctx.client, userId, now);
    const steps: DemoStep[] = [];
    const notes: string[] = [];
    for (const item of input.appointments) {
      const found = current.find((a) => a.name === item.name && sameMinute(a.dateStart, item.dateStart));
      if (!found) {
        steps.push({
          title: `create coaching appointment "${item.name}"`,
          request: {
            method: "POST",
            path: "/api/v2/coaching/appointments",
            body: {
              name: item.name,
              description: item.description,
              dateStart: item.dateStart,
              lengthInMinutes: item.lengthInMinutes,
              attendeeIds: [userId],
              ...(item.facilitatorId ? { facilitatorId: item.facilitatorId } : {}),
            },
          },
        });
      } else if (item.completed && found.status !== "Completed") {
        steps.push({
          title: `mark coaching appointment "${item.name}" as completed`,
          request: { method: "PATCH", path: `/api/v2/coaching/appointments/${found.id}/status`, body: { status: "Completed" } },
        });
      }
    }
    for (const id of input.remove) {
      const found = current.find((a) => a.id === id);
      if (!found) continue;
      if (found.status !== "Scheduled") {
        notes.push(`"${found.name}" is ${found.status?.toLowerCase() ?? "not scheduled"}; Genesys Cloud only deletes scheduled appointments.`);
        continue;
      }
      steps.push({ title: `delete coaching appointment "${found.name}"`, request: { method: "DELETE", path: `/api/v2/coaching/appointments/${id}` } });
    }
    return { steps, notes };
  },
};

// --------------------------------------------------------------- learning

export interface NewModule {
  name: string;
  description: string;
  /** Plain text shown to the agent as the module's content (one paragraph per line). */
  content: string;
  lengthInMinutes: number;
}

export interface LearningItem {
  /** A published module of the org, or a new one (found by name, so a second run reuses it). */
  moduleId?: string;
  newModule?: NewModule;
  /** ISO date-time in the future (Genesys refuses past completion dates). */
  dueDate: string;
}

export interface LearningInput {
  assignments: LearningItem[];
  /** Assignment ids to delete. */
  remove: string[];
}

export interface LearningModule {
  id: string;
  name: string;
  description?: string;
  type?: string;
  source?: string;
  isPublished: boolean;
  lengthInMinutes?: number;
}

export interface Assignment {
  id: string;
  moduleId: string;
  moduleName: string;
  state?: string;
  dueDate?: string;
  isOverdue?: boolean;
  completionPercentage?: number;
}

/** New modules the page suggests for orgs without published modules of their own. */
export const LEARNING_TEMPLATES: Array<NewModule & { dueWorkdays: number }> = [
  {
    name: "Handling difficult customers",
    description: "Five techniques to calm upset customers and keep the conversation on track.",
    content: "1. Listen first and let the customer finish.\n2. Acknowledge the feeling, not only the facts.\n3. Take ownership: say what you will do.\n4. Offer two options instead of one.\n5. Confirm the next step and when it happens.",
    lengthInMinutes: 15,
    dueWorkdays: 3,
  },
  {
    name: "Data protection in every conversation",
    description: "How to verify a customer's identity and which data never belongs in notes.",
    content: "Verify the customer with two identifiers before you share account details.\nNever write card numbers, passwords or health data into notes or chats.\nWhen in doubt, ask your team lead before you share information.",
    lengthInMinutes: 15,
    dueWorkdays: 5,
  },
  {
    name: "Product update: what is new this quarter",
    description: "The changes customers will ask about, and the answers that work.",
    content: "New self-service options in the app: show customers where to find them.\nChanged delivery times: explain the reason and offer tracking.\nNew loyalty tiers: check the tier before you offer a goodwill gesture.",
    lengthInMinutes: 30,
    dueWorkdays: 8,
  },
];

const MAX_ASSIGNMENTS = 20;

/** Module content as rich text: the plain text is escaped, one paragraph per line. */
export function richText(content: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${esc(l)}</p>`)
    .join("");
}

export async function listModules(client: GenesysClient): Promise<LearningModule[]> {
  const { first, paged } = await client.getAll("/api/v2/learning/modules", { pageSize: 100 }, 2000);
  type Raw = { id?: string; name?: string; description?: string; type?: string; source?: string; isPublished?: boolean; isArchived?: boolean; lengthInMinutes?: number };
  const raw = (paged?.items ?? (first.body as { entities?: Raw[] }).entities ?? []) as Raw[];
  return raw
    .filter((m): m is Raw & { id: string; name: string } => Boolean(m.id && m.name && !m.isArchived))
    .map((m) => ({ id: m.id, name: m.name, description: m.description, type: m.type, source: m.source, isPublished: Boolean(m.isPublished), lengthInMinutes: m.lengthInMinutes }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAssignments(client: GenesysClient, userId: string): Promise<Assignment[]> {
  const { first, paged } = await client.getAll("/api/v2/learning/assignments", { userId, pageSize: 100 }, 500);
  type Raw = { id?: string; module?: { id?: string; name?: string }; state?: string; dateRecommendedForCompletion?: string; isOverdue?: boolean; completionPercentage?: number };
  const raw = (paged?.items ?? (first.body as { entities?: Raw[] }).entities ?? []) as Raw[];
  return raw
    .filter((a): a is Raw & { id: string; module: { id: string } } => Boolean(a.id && a.module?.id) && a.state !== "Deleted")
    .map((a) => ({ id: a.id, moduleId: a.module.id, moduleName: a.module.name ?? a.module.id, state: a.state, dueDate: a.dateRecommendedForCompletion, isOverdue: a.isOverdue, completionPercentage: a.completionPercentage }))
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
}

export const learningSection: DemoSection<LearningInput> = {
  id: "learning",
  title: "Learning",

  parse(input, now = new Date()) {
    const i = (input ?? {}) as { assignments?: unknown; remove?: unknown };
    const list = Array.isArray(i.assignments) ? i.assignments : [];
    if (list.length > MAX_ASSIGNMENTS) throw invalid(`At most ${MAX_ASSIGNMENTS} modules at a time.`);
    const seen = new Set<string>();
    const assignments = list.map((raw, n): LearningItem => {
      const a = (raw ?? {}) as Record<string, unknown>;
      const what = `Module ${n + 1}`;
      const due = typeof a.dueDate === "string" ? Date.parse(a.dueDate) : NaN;
      if (!Number.isFinite(due)) throw invalid(`${what}: the due date is not a date.`);
      if (due <= now.getTime() + 60_000) throw invalid(`${what}: the due date is in the past; Genesys Cloud only accepts future dates.`);
      const dueDate = new Date(due).toISOString().replace(/\.\d{3}Z$/, "Z");
      let item: LearningItem;
      if (a.moduleId !== undefined) {
        item = { moduleId: assertId(a.moduleId, `${what}: module`), dueDate };
      } else {
        const m = (a.newModule ?? {}) as Record<string, unknown>;
        const length = Number(m.lengthInMinutes ?? 15);
        // Genesys only takes lengths in steps of 15 minutes.
        if (!Number.isInteger(length) || length < 15 || length > 480 || length % 15) throw invalid(`${what}: the length must be 15 to 480 minutes, in steps of 15.`);
        const name = text(m.name, `${what}: name`, 200);
        item = { newModule: { name, description: text(m.description, `${what}: description`, 1000, false), content: text(m.content, `${what} ("${name}"): content`, 20_000), lengthInMinutes: length }, dueDate };
      }
      const key = item.moduleId ?? `new:${item.newModule!.name}`;
      if (seen.has(key)) throw invalid(`${what} is in the list twice.`);
      seen.add(key);
      return item;
    });
    const remove = (Array.isArray(i.remove) ? i.remove : []).map((id) => assertId(id, "remove: assignment"));
    if (!assignments.length && !remove.length) throw invalid("Choose at least one module.");
    return { assignments, remove };
  },

  async status(client, userId) {
    const [assignments, modules] = await Promise.all([listAssignments(client, userId), listModules(client)]);
    return { assignments, modules };
  },

  async next(userId, input, { ctx, group }) {
    const [assignments, modules] = await Promise.all([listAssignments(ctx.client, userId), listModules(ctx.client)]);
    // Modules this run created that the list does not show yet.
    for (const [name, id] of createdInRun(group, "/api/v2/learning/modules")) {
      if (!modules.some((m) => m.id === id)) {
        const m = (await ctx.client.get<{ isPublished?: boolean; isArchived?: boolean }>(`/api/v2/learning/modules/${id}`)).body;
        if (!m.isArchived) modules.push({ id, name, isPublished: Boolean(m.isPublished) });
      }
    }
    const steps: DemoStep[] = [];
    const notes: string[] = [];
    for (const item of input.assignments) {
      let mod: LearningModule | undefined;
      if (item.moduleId) {
        mod = modules.find((m) => m.id === item.moduleId);
        if (!mod) {
          notes.push(`Module ${item.moduleId} does not exist (or is archived); skipped.`);
          continue;
        }
      } else {
        const nm = item.newModule!;
        mod = modules.find((m) => m.name === nm.name);
        if (!mod) {
          steps.push({
            title: `create learning module "${nm.name}"`,
            request: {
              method: "POST",
              path: "/api/v2/learning/modules",
              body: {
                name: nm.name,
                ...(nm.description ? { description: nm.description } : {}),
                type: "Native",
                completionTimeInDays: 7,
                lengthInMinutes: nm.lengthInMinutes,
                // Genesys numbers inform steps from 1; publishing fails otherwise.
                informSteps: [{ type: "RichText", name: nm.name, value: richText(nm.content), order: 1 }],
              },
            },
          });
          continue;
        }
      }
      if (!mod.isPublished) {
        if (item.moduleId) notes.push(`"${mod.name}" is not published; it is published before it is assigned.`);
        steps.push({ title: `publish learning module "${mod.name}"`, request: { method: "POST", path: `/api/v2/learning/modules/${mod.id}/publish`, body: {} } });
        continue;
      }
      if (assignments.some((a) => a.moduleId === mod.id)) continue;
      steps.push({
        title: `assign learning module "${mod.name}"`,
        request: { method: "POST", path: "/api/v2/learning/assignments", body: { moduleId: mod.id, userId, recommendedCompletionDate: item.dueDate } },
      });
    }
    for (const id of input.remove) {
      const found = assignments.find((a) => a.id === id);
      if (found) steps.push({ title: `remove the assignment of "${found.moduleName}"`, request: { method: "DELETE", path: `/api/v2/learning/assignments/${id}` } });
    }
    return { steps, notes };
  },
};

// -------------------------------------------------------------------- sta

export interface StaInput {
  /** The queue whose interactions are analysed (an existing queue). */
  queueId: string;
  /** Add the agent to the queue, so the agent's interactions are analysed. */
  addAgent: boolean;
  /** Text analytics, sentiment and agent empathy on (org-wide). */
  analytics: boolean;
  /** A dialect the org expects (added to the expected dialects, e.g. en-US); empty keeps them. */
  dialect: string;
  /** Voice transcription for the queue (and per-queue transcription in the org if it is off). */
  transcription: boolean;
  /** The program the queue belongs to: an existing one, or one found or created by name with topics. */
  program: { id: string } | { name: string; topicIds: string[] };
  /** Own topics, created and published, then added to the program (new or existing). */
  newTopics: NewTopic[];
}

export interface NewTopic {
  name: string;
  description: string;
  dialect: string;
  /** Genesys values: 1 (loose) … 90 (strict); 72 is the Genesys default. */
  strictness: string;
  phrases: string[];
}

export const TOPIC_STRICTNESS = ["1", "55", "65", "72", "85", "90"];
const DIALECT_RE = /^[a-z]{2,3}-[A-Z]{2}$/;

export const DEFAULT_STA_PROGRAM = "Demo ready analytics";
/** Built-in Genesys topics that show up in a typical service conversation. */
export const DEFAULT_STA_TOPICS = ["Complaint", "Shipping Dissatisfaction", "Credits or Refunds", "Express Empathy", "Escalate to Supervisor", "Greeting", "Closing an Interaction", "Dissatisfaction with Agent"];

type StaSettings = { textAnalyticsEnabled?: boolean; sentimentAnalysisEnabled?: boolean; agentEmpathyEnabled?: boolean; expectedDialects?: string[]; defaultProgram?: { id?: string } };
type TranscriptionSettings = { transcription?: string; transcriptionConfidenceThreshold?: number };
type Program = { id: string; name: string; published?: boolean };
type Mapping = { program?: { id: string }; queues?: Array<{ id: string }>; flows?: Array<{ id: string }> };
type Queue = { id: string; name: string; enableTranscription?: boolean };

async function entities<T>(client: GenesysClient, path: string, query: Record<string, string | number> = {}, max = 1000): Promise<T[]> {
  const { first, paged } = await client.getAll(path, { pageSize: 100, ...query }, max);
  return (paged?.items ?? (first.body as { entities?: T[] }).entities ?? []) as T[];
}

const programMappings = (client: GenesysClient) => entities<Mapping>(client, "/api/v2/speechandtextanalytics/programs/mappings");
const programOf = (mappings: Mapping[], queueId: string) => mappings.find((m) => (m.queues ?? []).some((q) => q.id === queueId))?.program?.id;
const mappingBody = (m: Mapping | undefined, queues: string[]) => ({ queueIds: queues, flowIds: (m?.flows ?? []).map((f) => f.id) });

export const staSection: DemoSection<StaInput> = {
  id: "sta",
  title: "Speech and text analytics",

  parse(input) {
    const i = (input ?? {}) as Record<string, unknown>;
    const p = (i.program ?? {}) as Record<string, unknown>;
    const program =
      p.id !== undefined
        ? { id: assertId(p.id, "program") }
        : { name: text(p.name, "Program name", 100), topicIds: [...new Set((Array.isArray(p.topicIds) ? p.topicIds : []).map((t) => assertId(t, "topic")))] };
    if ("topicIds" in program && program.topicIds!.length > 100) throw invalid("At most 100 topics.");
    const dialect = typeof i.dialect === "string" ? i.dialect.trim() : "";
    if (dialect && !DIALECT_RE.test(dialect)) throw invalid(`"${dialect}" is not a dialect like en-US.`);
    const list = Array.isArray(i.newTopics) ? i.newTopics : [];
    if (list.length > 10) throw invalid("At most 10 new topics at a time.");
    const newTopics = list.map((raw, n): NewTopic => {
      const t = (raw ?? {}) as Record<string, unknown>;
      const name = text(t.name, `New topic ${n + 1}: name`, 100);
      const d = text(t.dialect, `Topic "${name}": dialect`, 10);
      if (!DIALECT_RE.test(d)) throw invalid(`Topic "${name}": "${d}" is not a dialect like en-US.`);
      const strictness = t.strictness === undefined || t.strictness === "" ? "72" : String(t.strictness);
      if (!TOPIC_STRICTNESS.includes(strictness)) throw invalid(`Topic "${name}": strictness must be one of ${TOPIC_STRICTNESS.join(", ")}.`);
      const phrases = [...new Set((Array.isArray(t.phrases) ? t.phrases : String(t.phrases ?? "").split("\n")).map((x) => String(x).trim()).filter(Boolean))];
      if (!phrases.length) throw invalid(`Topic "${name}": add at least one phrase.`);
      if (phrases.length > 50) throw invalid(`Topic "${name}": at most 50 phrases.`);
      if (phrases.some((x) => x.length > 150)) throw invalid(`Topic "${name}": a phrase is longer than 150 characters.`);
      return { name, description: text(t.description, `Topic "${name}": description`, 500, false), dialect: d, strictness, phrases };
    });
    if (new Set(newTopics.map((t) => `${t.name}|${t.dialect}`)).size < newTopics.length) throw invalid("A new topic is in the list twice.");
    return { queueId: assertId(i.queueId, "queue"), addAgent: i.addAgent !== false, analytics: i.analytics !== false, dialect, transcription: i.transcription !== false, program, newTopics };
  },

  async status(client, userId) {
    const [settings, transcription, programs, topics, dialects, queues, agentQueues, mappings] = await Promise.all([
      client.get<StaSettings>("/api/v2/speechandtextanalytics/settings").then((r) => r.body),
      client.get<TranscriptionSettings>("/api/v2/routing/settings/transcription").then((r) => r.body),
      entities<Program>(client, "/api/v2/speechandtextanalytics/programs").then((ps) => ps.map((p) => ({ id: p.id, name: p.name, published: p.published }))),
      entities<{ id: string; name: string; published?: boolean; dialect?: string }>(client, "/api/v2/speechandtextanalytics/topics").then((ts) => ts.filter((t) => t.published).map((t) => ({ id: t.id, name: t.name, dialect: t.dialect })).sort((a, b) => a.name.localeCompare(b.name))),
      client.get<{ entities?: string[] }>("/api/v2/speechandtextanalytics/topics/dialects").then((r) => r.body.entities ?? []),
      entities<Queue>(client, "/api/v2/routing/queues").then((qs) => qs.map((q) => ({ id: q.id, name: q.name })).sort((a, b) => a.name.localeCompare(b.name))),
      entities<{ id: string; name: string }>(client, `/api/v2/users/${userId}/queues`).then((qs) => qs.map((q) => q.id)),
      programMappings(client),
    ]);
    // Transcription is a queue setting: read it for the agent's queues only.
    const transcribed = Object.fromEntries(
      await Promise.all(agentQueues.map(async (id) => [id, Boolean((await client.get<Queue>(`/api/v2/routing/queues/${id}`)).body.enableTranscription)] as const)),
    );
    return {
      settings: { text: Boolean(settings.textAnalyticsEnabled), sentiment: Boolean(settings.sentimentAnalysisEnabled), empathy: Boolean(settings.agentEmpathyEnabled), dialects: settings.expectedDialects ?? [], defaultProgram: settings.defaultProgram?.id },
      transcription: transcription.transcription ?? "Disabled",
      programs,
      topics,
      dialects,
      queues,
      agentQueues,
      transcribed,
      queuePrograms: Object.fromEntries(mappings.flatMap((m) => (m.queues ?? []).map((q) => [q.id, m.program?.id]))),
      defaults: { program: DEFAULT_STA_PROGRAM, topics: DEFAULT_STA_TOPICS },
    };
  },

  async next(userId, input, { ctx, group }) {
    const client = ctx.client;
    const steps: DemoStep[] = [];
    const notes: string[] = [];
    let queue: Queue;
    try {
      queue = (await client.get<Queue>(`/api/v2/routing/queues/${input.queueId}`)).body;
    } catch (err) {
      if (err instanceof GctkError && err.code === "HTTP_404") return { steps, notes: [`Queue ${input.queueId} does not exist (or is not visible to the OAuth client).`] };
      throw err;
    }

    // Wave 1, independent of each other. Changed settings keep their previous values in the subject.
    if (input.analytics || input.dialect) {
      const s = (await client.get<StaSettings>("/api/v2/speechandtextanalytics/settings")).body;
      const want: Record<string, unknown> = {};
      if (input.analytics) for (const k of ["textAnalyticsEnabled", "sentimentAnalysisEnabled", "agentEmpathyEnabled"] as const) if (!s[k]) want[k] = true;
      if (input.dialect && !(s.expectedDialects ?? []).includes(input.dialect)) want.expectedDialects = [...(s.expectedDialects ?? []), input.dialect];
      if (Object.keys(want).length) {
        const was = Object.fromEntries(Object.keys(want).map((k) => [k, (s as Record<string, unknown>)[k] ?? (k === "expectedDialects" ? [] : false)]));
        const what = Object.keys(want).map((k) => ({ textAnalyticsEnabled: "text analytics on", sentimentAnalysisEnabled: "sentiment on", agentEmpathyEnabled: "agent empathy on", expectedDialects: `expected dialect ${input.dialect}` })[k]);
        steps.push({ title: `analytics settings: ${what.join(", ")}`, subject: `demo-ready:before:${JSON.stringify(was)}`, request: { method: "PATCH", path: "/api/v2/speechandtextanalytics/settings", body: want } });
      }
    }
    if (input.transcription) {
      const t = (await client.get<TranscriptionSettings>("/api/v2/routing/settings/transcription")).body;
      if (!t.transcription || t.transcription === "Disabled") {
        steps.push({
          title: "turn on voice transcription for queues and flows",
          subject: `demo-ready:before:${JSON.stringify({ transcription: t.transcription ?? "Disabled" })}`,
          request: { method: "PATCH", path: "/api/v2/routing/settings/transcription", body: { transcription: "EnabledQueueFlow", transcriptionConfidenceThreshold: t.transcriptionConfidenceThreshold ?? 60 } },
        });
      }
      if (!queue.enableTranscription) {
        steps.push({ title: `turn on transcription in queue "${queue.name}"`, subject: `demo-ready:before:${JSON.stringify({ enableTranscription: false })}`, request: { method: "PUT", path: `/api/v2/routing/queues/${queue.id}`, body: { ...queue, enableTranscription: true } } });
      }
    }
    if (input.addAgent && !(await entities<{ id: string }>(client, `/api/v2/users/${userId}/queues`)).some((q) => q.id === queue.id)) {
      steps.push({ title: `add the agent to queue "${queue.name}"`, request: { method: "POST", path: `/api/v2/routing/queues/${queue.id}/members`, body: [{ id: userId }] } });
    }

    // Own topics: created (found again through the page's records or by name and dialect), then published.
    const TOPICS = "/api/v2/speechandtextanalytics/topics";
    const topicIds: string[] = [];
    const unpublishedTopics: Array<{ id: string; name: string }> = [];
    if (input.newTopics.length) {
      const orgTopics = await entities<{ id: string; name: string; dialect?: string; published?: boolean }>(client, TOPICS);
      const known = new Map([...createdByDemo(client.profile.name, TOPICS), ...createdInRun(group, TOPICS)]);
      const unpublished: Array<{ id: string; name: string }> = [];
      for (const t of input.newTopics) {
        let found = orgTopics.find((x) => x.name === t.name && x.dialect === t.dialect);
        const id = found?.id ?? known.get(t.name);
        if (!found && id) {
          try {
            found = (await client.get<{ id: string; name: string; dialect?: string; published?: boolean }>(`${TOPICS}/${id}`)).body;
          } catch (err) {
            if (!(err instanceof GctkError && err.code === "HTTP_404")) throw err;
          }
        }
        if (!found) {
          steps.push({
            title: `create topic "${t.name}" (${t.dialect}, ${t.phrases.length} phrase${t.phrases.length === 1 ? "" : "s"})`,
            request: { method: "POST", path: TOPICS, body: { name: t.name, ...(t.description ? { description: t.description } : {}), dialect: t.dialect, strictness: t.strictness, participants: "All", phrases: t.phrases.map((text) => ({ text })) } },
          });
          continue;
        }
        topicIds.push(found.id);
        if (!found.published) unpublished.push({ id: found.id, name: found.name });
      }
      unpublishedTopics.push(...unpublished);
    }
    // The program comes after its topics exist; they are published once they are in it (see below).
    if (steps.length) return { steps, notes };

    let program: (Program & { description?: string; topics?: Array<{ id: string }> }) | undefined;
    if ("id" in input.program) {
      try {
        program = (await client.get<Program>(`/api/v2/speechandtextanalytics/programs/${input.program.id}`)).body;
      } catch (err) {
        if (!(err instanceof GctkError && err.code === "HTTP_404")) throw err;
        return { steps, notes: [...notes, `Program ${input.program.id} does not exist.`] };
      }
    } else {
      const { name, topicIds } = input.program;
      // Programs this page created are found through its records (the name search lags behind creates).
      const path = "/api/v2/speechandtextanalytics/programs";
      const known = createdInRun(group, path).get(name) ?? createdByDemo(client.profile.name, path).get(name);
      if (known && (await exists(client, `${path}/${known}`))) program = (await client.get<Program>(`${path}/${known}`)).body;
      else {
        const id = (await entities<Program>(client, path)).find((p) => p.name === name)?.id;
        if (id) program = (await client.get<Program>(`${path}/${id}`)).body;
      }
      if (!program) {
        const all = [...new Set([...input.program.topicIds, ...topicIds])];
        steps.push({ title: `create program "${name}" with ${all.length} topic${all.length === 1 ? "" : "s"}`, request: { method: "POST", path: "/api/v2/speechandtextanalytics/programs", body: { name, description: "Speech and text analytics for agent demos (gctk Demo ready).", topicIds: all } } });
      }
    }
    if (steps.length || !program) return { steps, notes };

    // New topics into the program (an existing one too: Clean up deletes the topics, which takes them out again).
    const inProgram = new Set((program.topics ?? []).map((t) => t.id));
    const missing = topicIds.filter((t) => !inProgram.has(t));
    if (missing.length) {
      return {
        steps: [{
          title: `add ${missing.length} new topic${missing.length > 1 ? "s" : ""} to program "${program.name}"`,
          request: { method: "PUT", path: `/api/v2/speechandtextanalytics/programs/${program.id}`, body: { name: program.name, ...(program.description ? { description: program.description } : {}), topicIds: [...inProgram, ...missing] } },
        }],
        notes,
      };
    }

    // Publishing: the topics first, then the program; both again after every change of the program
    // (linking a published topic to a program makes it unpublished again, seen live).
    const plans = listRecords({ group, limit: 1000 }).filter((p) => p.status === "applied");
    const programChanged = plans
      .filter((p) => (p.request.path === "/api/v2/speechandtextanalytics/programs" && (p.result?.body as { id?: string })?.id === program!.id) || p.request.path === `/api/v2/speechandtextanalytics/programs/${program!.id}`)
      .map((p) => p.createdAt)
      .sort()
      .pop();
    const lastPublish = (path: string, key: string, ids: string[]) =>
      plans.filter((p) => p.request.path === path && ids.every((id) => ((p.request.body as Record<string, string[]>)?.[key] ?? []).includes(id))).map((p) => p.createdAt).sort().pop();
    const publishedSince = (at?: string) => Boolean(at && (!programChanged || at >= programChanged));
    if (unpublishedTopics.length) {
      if (publishedSince(lastPublish(`${TOPICS}/publishjobs`, "topicIds", unpublishedTopics.map((u) => u.id)))) return { steps, notes, busy: "Genesys Cloud is still publishing the new topics; press Continue in a minute." };
      return { steps: [{ title: `publish topic${unpublishedTopics.length > 1 ? "s" : ""} ${unpublishedTopics.map((u) => `"${u.name}"`).join(", ")}`, request: { method: "POST", path: `${TOPICS}/publishjobs`, body: { topicIds: unpublishedTopics.map((u) => u.id) } } }], notes };
    }
    // Then the queue into the program (one program per queue).
    if (!program.published) {
      if (publishedSince(lastPublish("/api/v2/speechandtextanalytics/programs/publishjobs", "programIds", [program.id]))) return { steps, notes, busy: `Genesys Cloud is still publishing program "${program.name}"; press Continue in a minute.` };
      return { steps: [{ title: `publish program "${program.name}"`, request: { method: "POST", path: "/api/v2/speechandtextanalytics/programs/publishjobs", body: { programIds: [program.id] } } }], notes };
    }
    const mappings = await programMappings(client);
    const current = programOf(mappings, queue.id);
    if (current === program.id) return { steps, notes };
    if (current) {
      const m = mappings.find((x) => x.program?.id === current);
      steps.push({
        title: `take queue "${queue.name}" out of its current program`,
        subject: `demo-ready:removed-queue:${queue.id}`,
        request: { method: "PUT", path: `/api/v2/speechandtextanalytics/programs/${current}/mappings`, body: mappingBody(m, (m?.queues ?? []).map((q) => q.id).filter((q) => q !== queue.id)) },
      });
      return { steps, notes };
    }
    const target = mappings.find((x) => x.program?.id === program!.id);
    steps.push({
      title: `add queue "${queue.name}" to program "${program.name}"`,
      subject: `demo-ready:added-queue:${queue.id}`,
      request: { method: "PUT", path: `/api/v2/speechandtextanalytics/programs/${program.id}/mappings`, body: mappingBody(target, [...(target?.queues ?? []).map((q) => q.id), queue.id]) },
    });
    return { steps, notes };
  },
};

// ------------------------------------------------------------ evaluations

export type EvaluationResult = "strong" | "mixed" | "weak";

export interface EvaluationItem {
  conversationId: string;
  /** How the agent did: answers are picked from the form's options accordingly. */
  result: EvaluationResult;
  comment: string;
}

export interface EvaluationsInput {
  /** A published form of the org, or one found or created (and published) by name from the template. */
  form: { id: string } | { name: string };
  /** Needs quality:evaluation:edit or editScore (Genesys refuses others). */
  evaluatorId: string;
  evaluations: EvaluationItem[];
}

type FormQuestion = { id: string; text?: string; type?: string; naEnabled?: boolean; answerOptions?: Array<{ id: string; value?: number }> };
type FormGroup = { id: string; name?: string; questions?: FormQuestion[] };
type PublishedForm = { id: string; name: string; contextId?: string; questionGroups?: FormGroup[] };

const yesNo = [{ text: "Yes", value: 1 }, { text: "No", value: 0 }];
/** A form for customer service conversations (voice and digital), created when the org has none that fits. */
export const EVALUATION_FORM_TEMPLATE = {
  name: "Customer service quality check",
  questionGroups: [
    { name: "Opening", questions: ["Did the agent greet the customer and introduce themselves?", "Did the agent verify the customer's identity where needed?"] },
    { name: "Resolution", questions: ["Did the agent understand the customer's request?", "Was the request resolved, or a clear next step agreed?", "Did the agent check whether anything else was needed?"] },
    { name: "Tone", questions: ["Did the agent show empathy?", "Was the language clear and professional?"] },
  ].map((g) => ({ name: g.name, type: "questionGroup", weight: 1, questions: g.questions.map((text) => ({ text, type: "multipleChoiceQuestion", answerOptions: yesNo })) })),
};

export const EVALUATION_COMMENTS: Record<EvaluationResult, string> = {
  strong: "Excellent conversation: friendly, clear and the request was solved right away. Keep it up!",
  mixed: "Good start and a friendly tone. Next time confirm the next step with the customer before you close.",
  weak: "The request stayed open. Let's go through this conversation together in our next coaching session.",
};

/** Answer for question n of a form: strong = best option; mixed = best except every third; weak = best only every third (a realistic low score, not zero). */
export function pickAnswer(q: FormQuestion, n: number, result: EvaluationResult): { answerId?: string; markedNA?: boolean } | undefined {
  const opts = [...(q.answerOptions ?? [])].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  if (q.type === "multipleChoiceQuestion" && opts.length) {
    const best = result === "strong" || (result === "mixed" ? n % 3 !== 2 : n % 3 === 0);
    return { answerId: (best ? opts[0] : opts[opts.length - 1])!.id };
  }
  return q.naEnabled ? { markedNA: true } : undefined;
}

export function evaluationAnswers(form: PublishedForm, result: EvaluationResult, comment: string) {
  let n = 0;
  const questionGroupScores = (form.questionGroups ?? []).map((g) => ({
    questionGroupId: g.id,
    questionScores: (g.questions ?? []).flatMap((q) => {
      const a = pickAnswer(q, n++, result);
      return a ? [{ questionId: q.id, ...a }] : [];
    }),
  }));
  return { questionGroupScores, comments: comment };
}

/** The agent's ended conversations of the last days (analytics allows 7 days per query). */
export async function agentConversations(client: GenesysClient, userId: string, now = new Date(), days = 28) {
  type Conv = { conversationId: string; conversationStart?: string; conversationEnd?: string; participants?: Array<{ purpose?: string; userId?: string; participantName?: string; sessions?: Array<{ mediaType?: string; segments?: Array<{ segmentType?: string }> }> }> };
  const out: Array<{ id: string; start?: string; mediaType?: string; customer?: string }> = [];
  const week = 7 * 24 * 3600_000;
  for (let end = now.getTime(); end > now.getTime() - days * 24 * 3600_000; end -= week) {
    const res = await client.request<{ conversations?: Conv[] }>("POST", "/api/v2/analytics/conversations/details/query", {}, {
      interval: `${new Date(end - week).toISOString()}/${new Date(end).toISOString()}`,
      order: "desc",
      paging: { pageSize: 50, pageNumber: 1 },
      segmentFilters: [{ type: "and", predicates: [{ dimension: "userId", value: userId }] }],
    });
    for (const c of res.body.conversations ?? []) {
      if (!c.conversationEnd || out.some((o) => o.id === c.conversationId)) continue;
      const parts = c.participants ?? [];
      // Only conversations the agent really handled (not ones that only rang).
      const handled = parts.some((p) => p.purpose === "agent" && p.userId === userId && (p.sessions ?? []).some((x) => (x.segments ?? []).some((g) => g.segmentType === "interact")));
      if (!handled) continue;
      out.push({
        id: c.conversationId,
        start: c.conversationStart,
        mediaType: parts.flatMap((p) => p.sessions ?? []).find((s) => s.mediaType)?.mediaType,
        customer: parts.find((p) => p.purpose === "customer" || p.purpose === "external")?.participantName,
      });
    }
  }
  return out.sort((a, b) => String(b.start).localeCompare(String(a.start)));
}

/** The agent's evaluations of the last 90 days (the query endpoint ignores agentUserId, seen live; search works). */
export async function agentEvaluations(client: GenesysClient, userId: string, now = new Date()) {
  type Ev = { id: string; conversation?: { id: string }; evaluationForm?: { id: string; name?: string }; evaluator?: { id: string }; status?: string; releaseDate?: string; neverRelease?: boolean; createdDate?: string; answers?: { totalScore?: number } };
  const res = await client.request<{ results?: Ev[] }>("POST", "/api/v2/quality/evaluations/search", {}, {
    query: [
      { type: "EXACT", field: "agentId", value: userId },
      { type: "DATE_RANGE", field: "createdDate", startValue: new Date(now.getTime() - 89 * 24 * 3600_000).toISOString(), endValue: new Date(now.getTime() + 24 * 3600_000).toISOString() },
    ],
    pageSize: 100,
    pageNumber: 1,
  });
  return (res.body.results ?? []).map((e) => ({
    id: e.id,
    conversationId: e.conversation?.id,
    formId: e.evaluationForm?.id,
    evaluatorId: e.evaluator?.id,
    status: e.status,
    released: Boolean(e.releaseDate) && !e.neverRelease,
    score: e.answers?.totalScore,
    createdDate: e.createdDate,
  }));
}

/** Users whose roles may score evaluations (quality:evaluation:edit or editScore). */
async function evaluatorIds(client: GenesysClient): Promise<string[]> {
  const ids = new Set<string>();
  for (const permission of ["quality:evaluation:edit", "quality:evaluation:editScore"]) {
    for (const role of await entities<{ id: string }>(client, "/api/v2/authorization/roles", { permission })) {
      for (const u of await entities<{ id: string }>(client, `/api/v2/authorization/roles/${role.id}/users`)) ids.add(u.id);
    }
  }
  return [...ids];
}

const FORMS = "/api/v2/quality/forms/evaluations";
const PUBLISHED = "/api/v2/quality/publishedforms/evaluations";

export const evaluationsSection: DemoSection<EvaluationsInput> = {
  id: "evaluations",
  title: "Evaluations",

  parse(input, now) {
    const i = (input ?? {}) as Record<string, unknown>;
    const f = (i.form ?? {}) as Record<string, unknown>;
    const form = f.id !== undefined ? { id: assertId(f.id, "form") } : { name: text(f.name, "Form name", 100) };
    const evaluatorId = assertId(i.evaluatorId, "evaluator");
    const list = Array.isArray(i.evaluations) ? i.evaluations : [];
    if (!list.length) throw invalid("Choose at least one conversation to evaluate.");
    if (list.length > 20) throw invalid("At most 20 evaluations at a time.");
    const evaluations = list.map((raw, n): EvaluationItem => {
      const e = (raw ?? {}) as Record<string, unknown>;
      const result = e.result === "weak" || e.result === "mixed" ? e.result : e.result === "strong" || e.result === undefined ? "strong" : null;
      if (!result) throw invalid(`Evaluation ${n + 1}: the result must be strong, mixed or weak.`);
      return { conversationId: assertId(e.conversationId, `Evaluation ${n + 1}: conversation`), result, comment: text(e.comment, `Evaluation ${n + 1}: comment`, 2000, false) || EVALUATION_COMMENTS[result] };
    });
    if (new Set(evaluations.map((e) => e.conversationId)).size < evaluations.length) throw invalid("A conversation is in the list twice.");
    void now;
    return { form, evaluatorId, evaluations };
  },

  async status(client, userId, now = new Date()) {
    const [forms, conversations, evaluations, evaluators] = await Promise.all([
      entities<PublishedForm>(client, PUBLISHED).then((fs) => fs.map((f) => ({ id: f.id, name: f.name }))),
      agentConversations(client, userId, now).catch((err: unknown) => ({ error: err instanceof GctkError ? err.message : String(err) })),
      agentEvaluations(client, userId, now).catch((err: unknown) => ({ error: err instanceof GctkError ? err.message : String(err) })),
      evaluatorIds(client).catch(() => [] as string[]),
    ]);
    return { forms, conversations, evaluations, evaluators: evaluators.filter((id) => id !== userId), defaults: { form: EVALUATION_FORM_TEMPLATE.name, comments: EVALUATION_COMMENTS } };
  },

  async next(userId, input, { ctx, group, now = new Date() }) {
    const client = ctx.client;
    const notes: string[] = [];
    if (input.evaluatorId === userId) return { steps: [], notes: ["The agent cannot evaluate their own conversations; choose another evaluator."] };

    // The form: an existing published one, or the template, created and published once (found again by name).
    let form: PublishedForm | undefined;
    if ("id" in input.form) {
      try {
        form = (await client.get<PublishedForm>(`${PUBLISHED}/${input.form.id}`)).body;
      } catch (err) {
        if (!(err instanceof GctkError && err.code === "HTTP_404")) throw err;
        return { steps: [], notes: [`Published form ${input.form.id} does not exist.`] };
      }
    } else {
      const name = input.form.name;
      const published = (await entities<PublishedForm>(client, PUBLISHED)).find((f) => f.name === name);
      if (published) form = (await client.get<PublishedForm>(`${PUBLISHED}/${published.id}`)).body;
      else {
        const draftId = createdInRun(group, FORMS).get(name) ?? createdByDemo(client.profile.name, FORMS).get(name) ?? (await entities<{ id: string; name: string }>(client, FORMS)).find((f) => f.name === name)?.id;
        if (!draftId || !(await exists(client, `${FORMS}/${draftId}`))) {
          return { steps: [{ title: `create evaluation form "${name}"`, request: { method: "POST", path: FORMS, body: { ...EVALUATION_FORM_TEMPLATE, name } } }], notes };
        }
        const tried = listRecords({ group, status: "applied", limit: 1000 }).some((p) => p.request.path === PUBLISHED && (p.request.body as { id?: string })?.id === draftId);
        if (tried) return { steps: [], notes, busy: `Genesys Cloud is still publishing form "${name}"; press Continue in a minute.` };
        return { steps: [{ title: `publish evaluation form "${name}"`, request: { method: "POST", path: PUBLISHED, body: { id: draftId, published: true } } }], notes };
      }
    }

    // One evaluation per conversation and form; released right away so the agent sees it.
    const existing = await agentEvaluations(client, userId, now);
    const formIds = new Set([form.id, form.contextId].filter(Boolean));
    const done = new Set(listRecords({ group, limit: 1000 }).map((p) => p.subject).filter(Boolean));
    const steps: DemoStep[] = [];
    for (const e of input.evaluations) {
      const subject = `demo-ready:evaluation:${e.conversationId}`;
      if (done.has(subject)) continue;
      if (existing.some((x) => x.conversationId === e.conversationId && x.formId && formIds.has(x.formId))) {
        notes.push(`Conversation ${e.conversationId.slice(0, 8)} already has an evaluation with "${form.name}".`);
        continue;
      }
      steps.push({
        subject,
        title: `evaluate conversation ${e.conversationId.slice(0, 8)} with "${form.name}" (${e.result})`,
        request: {
          method: "POST",
          path: `/api/v2/quality/conversations/${e.conversationId}/evaluations`,
          body: { evaluationForm: { id: form.id }, evaluator: { id: input.evaluatorId }, agent: { id: userId }, status: "FINISHED", releaseDate: now.toISOString().replace(/\.\d{3}Z$/, ".000Z"), answers: evaluationAnswers(form, e.result, e.comment) },
        },
      });
    }
    return { steps, notes };
  },
};

// --------------------------------------------------------------- schedule

export interface ShiftPattern {
  /** Local start time in the business unit's time zone, "HH:MM". */
  start: string;
  lengthMinutes: number;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** A 60-minute training block in the middle of Wednesday's shift. */
  training: boolean;
}

export interface ScheduleInput {
  businessUnit: { id: string } | { name: string; timeZone: string };
  managementUnit: { id: string } | { name: string };
  /** Weeks from the current one (1–4). */
  weeks: number;
  pattern: ShiftPattern;
}

export const SCHEDULE_DESCRIPTION = "Demo ready schedule";
export const DEFAULT_BU = "Demo ready WFM";
export const DEFAULT_MU = "Demo ready agents";
const WFM = "/api/v2/workforcemanagement";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Offset of a time zone from UTC at an instant, in minutes (Intl only, no library). */
function tzOffset(tz: string, at: Date): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The UTC instant of a wall-clock time (yyyy-MM-dd, HH:MM) in a time zone. */
export function zonedTime(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  const first = guess - tzOffset(tz, new Date(guess)) * 60_000;
  return new Date(guess - tzOffset(tz, new Date(first)) * 60_000);
}

/** The first day (yyyy-MM-dd) of the week containing `now` in a time zone. */
export function weekStart(now: Date, tz: string, startDay: string): string {
  const local = new Date(now.getTime() + tzOffset(tz, now) * 60_000);
  const back = (local.getUTCDay() - DAY_NAMES.indexOf(startDay) + 7) % 7;
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back)).toISOString().slice(0, 10);
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Shifts of the pattern for `weeks` weeks from weekDate: on queue, two breaks, lunch, training on Wednesdays. */
export function buildShifts(weekDate: string, weeks: number, p: ShiftPattern, tz: string, codes: { onQueue: string; break: string; meal: string; training?: string }) {
  const shifts = [];
  for (let i = 0; i < weeks * 7; i++) {
    const date = addDays(weekDate, i);
    if (!p.days.includes(new Date(`${date}T00:00:00Z`).getUTCDay())) continue;
    const start = zonedTime(date, p.start, tz);
    const at = (min: number) => new Date(start.getTime() + min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const L = p.lengthMinutes;
    const blocks: Array<[number, number, string, string, boolean]> = [];
    const breaks = [Math.round(L * 0.25 / 15) * 15, Math.round(L * 0.75 / 15) * 15];
    const lunch = Math.round(L * 0.5 / 15) * 15;
    const training = p.training && codes.training && new Date(`${date}T00:00:00Z`).getUTCDay() === 3 ? lunch + 60 : -1;
    // Everything that is not a break, lunch or training is on queue.
    const special = new Map<number, [number, string, string, boolean]>([
      [breaks[0]!, [15, codes.break, "Break", true]],
      [lunch, [30, codes.meal, "Lunch", false]],
      ...(training >= 0 ? ([[training, [60, codes.training!, "Training", true]]] as Array<[number, [number, string, string, boolean]]>) : []),
      [breaks[1]!, [15, codes.break, "Break", true]],
    ]);
    let t = 0;
    for (const [s, [len, code, desc, paid]] of [...special].sort((a, b) => a[0] - b[0])) {
      if (s > t) blocks.push([t, s - t, codes.onQueue, "On queue", true]);
      blocks.push([s, len, code, desc, paid]);
      t = s + len;
    }
    if (t < L) blocks.push([t, L - t, codes.onQueue, "On queue", true]);
    shifts.push({ startDate: at(0), lengthMinutes: L, activities: blocks.map(([s, len, code, description, paid]) => ({ startDate: at(s), lengthMinutes: len, activityCodeId: code, description, paid })) });
  }
  return shifts;
}

/** Writes the gzip upload to the gctk cache (agent-protected) and returns its path. */
export function stageScheduleUpload(doc: unknown): { file: string; size: number } {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(doc)));
  const dir = path.join(paths.cacheDir(), "wfm-uploads");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.createHash("sha256").update(gz).digest("hex")}.json.gz`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, gz, { mode: 0o600 });
  return { file, size: gz.length };
}

type Bu = { id: string; name: string; settings?: { startDayOfWeek?: string; timeZone?: string }; division?: { id?: string } };
type Mu = { id: string; name: string; businessUnit?: { id?: string } };
type BuSchedule = { id: string; weekDate?: string; weekCount?: number; description?: string; published?: boolean };

/** The agent's management unit: the agent endpoint answers 403 when the agent has none (seen live), then the MUs are checked. */
export async function agentManagementUnit(client: GenesysClient, userId: string): Promise<{ id: string; businessUnitId?: string } | null> {
  try {
    const r = (await client.get<{ managementUnit?: { id: string }; businessUnit?: { id: string } }>(`${WFM}/agents/${userId}/managementunit`)).body;
    if (r.managementUnit?.id) return { id: r.managementUnit.id, businessUnitId: r.businessUnit?.id };
  } catch (err) {
    if (!(err instanceof GctkError && (err.code === "HTTP_403" || err.code === "HTTP_404"))) throw err;
  }
  for (const bu of await entities<Bu>(client, `${WFM}/businessunits`)) {
    for (const mu of await entities<Mu>(client, `${WFM}/businessunits/${bu.id}/managementunits`)) {
      if (await exists(client, `${WFM}/managementunits/${mu.id}/agents/${userId}`)) return { id: mu.id, businessUnitId: bu.id };
    }
  }
  return null;
}

async function activityCodes(client: GenesysClient, buId: string) {
  const r = (await client.get<{ entities?: Record<string, { id?: string; name?: string; category?: string; active?: boolean; default?: boolean }> | Array<{ id: string; name?: string; category?: string; active?: boolean; default?: boolean }> }>(`${WFM}/businessunits/${buId}/activitycodes`)).body;
  const list = (Array.isArray(r.entities) ? r.entities : Object.entries(r.entities ?? {}).map(([id, v]) => ({ ...v, id: v.id ?? id }))) as Array<{ id: string; category?: string; active?: boolean; default?: boolean }>;
  const pick = (cat: string) => list.filter((c) => c.category === cat && c.active !== false).sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)))[0]?.id;
  return { onQueue: pick("OnQueueWork"), break: pick("Break"), meal: pick("Meal"), training: pick("Training") ?? pick("Meeting") };
}

export const scheduleSection: DemoSection<ScheduleInput> = {
  id: "schedule",
  title: "Schedule",

  parse(input) {
    const i = (input ?? {}) as Record<string, unknown>;
    const b = (i.businessUnit ?? {}) as Record<string, unknown>;
    let businessUnit: ScheduleInput["businessUnit"];
    if (b.id !== undefined) businessUnit = { id: assertId(b.id, "business unit") };
    else {
      const timeZone = text(b.timeZone, "Time zone", 60);
      try {
        new Intl.DateTimeFormat("en-US", { timeZone });
      } catch {
        throw invalid(`"${timeZone}" is not a time zone like Europe/London.`);
      }
      businessUnit = { name: text(b.name, "Business unit name", 100), timeZone };
    }
    const m = (i.managementUnit ?? {}) as Record<string, unknown>;
    const managementUnit = m.id !== undefined ? { id: assertId(m.id, "management unit") } : { name: text(m.name, "Management unit name", 100) };
    const weeks = Number(i.weeks ?? 2);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 4) throw invalid("Weeks must be 1 to 4.");
    const p = (i.pattern ?? {}) as Record<string, unknown>;
    const start = typeof p.start === "string" ? p.start : "09:00";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) throw invalid("The shift start must be a time like 09:00.");
    const lengthMinutes = Number(p.lengthMinutes ?? 480);
    if (!Number.isInteger(lengthMinutes) || lengthMinutes < 240 || lengthMinutes > 720 || lengthMinutes % 15) throw invalid("The shift length must be 4 to 12 hours, in steps of 15 minutes.");
    const days = [...new Set((Array.isArray(p.days) ? p.days : [1, 2, 3, 4, 5]).map(Number))];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw invalid("Choose the working days.");
    return { businessUnit, managementUnit, weeks, pattern: { start, lengthMinutes, days, training: p.training !== false } };
  },

  async status(client, userId, now = new Date()) {
    const bus = await entities<Bu>(client, `${WFM}/businessunits`);
    const units = await Promise.all(bus.map(async (bu) => ({ id: bu.id, name: bu.name, managementUnits: (await entities<Mu>(client, `${WFM}/businessunits/${bu.id}/managementunits`)).map((m) => ({ id: m.id, name: m.name })) })));
    const current = await agentManagementUnit(client, userId);
    let schedules: Array<BuSchedule & { shifts?: number }> = [];
    let week: string | undefined;
    if (current?.businessUnitId) {
      const bu = (await client.get<Bu>(`${WFM}/businessunits/${current.businessUnitId}`, { expand: "settings" })).body;
      const tz = bu.settings?.timeZone ?? "UTC";
      week = weekStart(now, tz, bu.settings?.startDayOfWeek ?? "Monday");
      const list = (await client.get<{ entities?: BuSchedule[] }>(`${WFM}/businessunits/${bu.id}/weeks/${week}/schedules`, { includeOnlyPublished: false, expand: "managementUnits" }).catch(() => ({ body: { entities: [] } }))).body.entities ?? [];
      schedules = await Promise.all(list.map(async (s) => {
        const q = await client.request<{ result?: { agentSchedules?: Array<{ shifts?: unknown[] }> } }>("POST", `${WFM}/businessunits/${bu.id}/weeks/${s.weekDate ?? week}/schedules/${s.id}/agentschedules/query`, {}, { managementUnitId: current.id, userIds: [userId] }).catch(() => undefined);
        return { ...s, shifts: q?.body.result?.agentSchedules?.[0]?.shifts?.length };
      }));
    }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { businessUnits: units, current, week, schedules, defaults: { businessUnit: DEFAULT_BU, managementUnit: DEFAULT_MU, timeZone: tz, description: SCHEDULE_DESCRIPTION } };
  },

  async next(userId, input, { ctx, group, now = new Date() }) {
    const client = ctx.client;
    const notes: string[] = [];
    const available = async <T>(path: string, query?: Record<string, string>) => {
      try {
        return (await client.get<T>(path, query)).body;
      } catch (err) {
        if (err instanceof GctkError && (err.code === "HTTP_404" || err.code === "HTTP_403")) return undefined;
        throw err;
      }
    };

    // Business unit: an existing one, or found or created by name (Genesys needs a minute or two before it is usable).
    let buId: string | undefined;
    if ("id" in input.businessUnit) buId = input.businessUnit.id;
    else {
      const { name, timeZone } = input.businessUnit;
      buId = createdInRun(group, `${WFM}/businessunits`).get(name) ?? createdByDemo(client.profile.name, `${WFM}/businessunits`).get(name) ?? (await entities<Bu>(client, `${WFM}/businessunits`)).find((b) => b.name === name)?.id;
      if (buId && !(await available(`${WFM}/businessunits/${buId}`)) && !createdInRun(group, `${WFM}/businessunits`).has(name)) buId = undefined;
      if (!buId) {
        const home = (await client.get<{ id: string }>("/api/v2/authorization/divisions/home")).body.id;
        return { steps: [{ title: `create business unit "${name}" (${timeZone})`, request: { method: "POST", path: `${WFM}/businessunits`, body: { name, divisionId: home, settings: { startDayOfWeek: "Monday", timeZone } } } }], notes };
      }
    }
    const bu = await available<Bu>(`${WFM}/businessunits/${buId}`, { expand: "settings" });
    if (!bu) return { steps: [], notes, busy: "Genesys Cloud is still setting up the business unit (it takes a minute or two); press Continue in a moment." };
    const tz = bu.settings?.timeZone ?? "UTC";

    // Management unit in that business unit.
    let muId: string | undefined;
    if ("id" in input.managementUnit) muId = input.managementUnit.id;
    else {
      const name = input.managementUnit.name;
      muId = createdInRun(group, `${WFM}/managementunits`).get(name) ?? (await entities<Mu>(client, `${WFM}/businessunits/${bu.id}/managementunits`)).find((m) => m.name === name)?.id;
      if (!muId) return { steps: [{ title: `create management unit "${name}" in "${bu.name}"`, request: { method: "POST", path: `${WFM}/managementunits`, body: { name, businessUnitId: bu.id, divisionId: bu.division?.id } } }], notes };
    }
    const mu = await available<Mu>(`${WFM}/managementunits/${muId}`);
    if (!mu) return { steps: [], notes, busy: "Genesys Cloud is still setting up the management unit; press Continue in a moment." };
    if (mu.businessUnit?.id && mu.businessUnit.id !== bu.id) return { steps: [], notes: [`Management unit "${mu.name}" belongs to another business unit.`] };

    // The agent into the management unit (the previous one is kept for Clean up).
    const current = await agentManagementUnit(client, userId);
    if (current?.id !== mu.id) {
      const moved = listRecords({ group, status: "applied", limit: 1000 }).some((p) => p.request.path === `${WFM}/agents` && (p.request.body as { destinationManagementUnitId?: string })?.destinationManagementUnitId === mu.id);
      if (moved) return { steps: [], notes, busy: "Genesys Cloud is still moving the agent into the management unit; press Continue in a moment." };
      return {
        steps: [{ title: `move the agent into management unit "${mu.name}"`, subject: `demo-ready:before:${JSON.stringify({ managementUnit: current?.id ?? null })}`, request: { method: "POST", path: `${WFM}/agents`, body: { userIds: [userId], destinationManagementUnitId: mu.id } } }],
        notes,
      };
    }

    // The schedule: imported (gzip JSON through a presigned URL) and published, once per week.
    const week = weekStart(now, tz, bu.settings?.startDayOfWeek ?? "Monday");
    const schedules = (await client.get<{ entities?: BuSchedule[] }>(`${WFM}/businessunits/${bu.id}/weeks/${week}/schedules`, { includeOnlyPublished: "false" })).body.entities ?? [];
    if (schedules.some((s) => s.description === SCHEDULE_DESCRIPTION)) return { steps: [], notes };
    if (schedules.length && "id" in input.businessUnit) {
      return { steps: [], notes: [`"${bu.name}" has a schedule for the week of ${week} already; the page does not add another one there. Use a new business unit for the demo.`] };
    }
    const plans = listRecords({ group, limit: 1000 });
    const upload = plans.find((p) => p.subject === `demo-ready:schedule-upload:${bu.id}:${week}` && p.status === "applied");
    const imported = plans.find((p) => p.subject === `demo-ready:schedule-import:${bu.id}:${week}` && p.status === "applied");
    if (imported) return { steps: [], notes, busy: "Genesys Cloud is still importing the schedule; press Continue in a moment." };
    if (upload) {
      const key = (upload.result?.body as { uploadKey?: string } | undefined)?.uploadKey;
      if (!key) return { steps: [], notes: ["The upload returned no upload key; start again."] };
      return { steps: [{ title: `import the schedule for the week of ${week}`, subject: `demo-ready:schedule-import:${bu.id}:${week}`, request: { method: "POST", path: `${WFM}/businessunits/${bu.id}/weeks/${week}/schedules/import`, body: { uploadKey: key } } }], notes };
    }
    const codes = await activityCodes(client, bu.id);
    if (!codes.onQueue || !codes.break || !codes.meal) return { steps: [], notes: [`"${bu.name}" lacks default activity codes (on queue, break, meal).`] };
    const doc = {
      description: SCHEDULE_DESCRIPTION,
      weekCount: input.weeks,
      published: true,
      agentSchedules: [{ userId, shifts: buildShifts(week, input.weeks, input.pattern, tz, { onQueue: codes.onQueue, break: codes.break, meal: codes.meal, training: codes.training }) }],
    };
    const staged = stageScheduleUpload(doc);
    return {
      steps: [{
        title: `upload a ${input.weeks}-week schedule for the agent (from ${week}, ${input.pattern.days.length} days a week, ${input.pattern.start} for ${input.pattern.lengthMinutes / 60} h)`,
        subject: `demo-ready:schedule-upload:${bu.id}:${week}`,
        request: { method: "POST", path: `${WFM}/businessunits/${bu.id}/weeks/${week}/schedules/import/uploadurl`, body: { contentLengthBytes: staged.size }, uploadFile: staged.file },
      }],
      notes,
    };
  },
};

// -------------------------------------------------------------- scorecard

export interface ScorecardInput {
  /** Switch gamification on if it is off (org-wide; without it the scorecard stays empty). */
  activate: boolean;
  /** An existing performance profile (only the agent's membership changes) or one found or created by name. */
  profile: { id: string } | { name: string };
  /** Metric definitions for a profile Demo ready created (existing profiles keep their metrics). */
  metrics: string[];
}

/** Metrics that show values for an agent who handles emails and messages and gets evaluated. */
export const DEFAULT_SCORECARD_METRICS = ["QUALITY_EVALUATION_SCORE", "NUMBER_OF_INTERACTION_ANSWERED", "INTERACTION_ANSWERED_RATIO", "AVERAGE_HANDLE_TIME", "AVERAGE_AFTER_CALL_WORK"];
export const DEFAULT_PROFILE_NAME = "Demo ready performance";

type MetricDefinition = { id: string; name: string; defaultObjective?: { templateId?: string; zones?: unknown[]; enabled?: boolean } };
type Profile = { id: string; name: string; active?: boolean; memberCount?: number; division?: { id?: string } };

/** "AVERAGE_HANDLE_TIME" → "Average handle time". */
const metricLabel = (name: string) => name.charAt(0) + name.slice(1).toLowerCase().replace(/_/g, " ");
const today = (now: Date) => now.toISOString().slice(0, 10);

async function currentProfile(client: GenesysClient, userId: string, now: Date): Promise<string | undefined> {
  const res = await client.request<{ profiles?: Array<{ id: string; dateStartWorkday?: string; dateEndWorkday?: string }> }>("POST", `/api/v2/gamification/profiles/users/${userId}/query`, {}, { startWorkday: today(now), endWorkday: today(now) });
  return res.body.profiles?.[0]?.id;
}

/** Performance profiles Demo ready created (their metrics may be changed; others are left alone). */
function ownProfiles(profile: string): Set<string> {
  return new Set(
    listRecords({ profile, status: "applied", limit: 100_000 })
      .filter((p) => p.group?.startsWith("demo ready · scorecard · ") && p.request.method === "POST" && p.request.path === "/api/v2/gamification/profiles")
      .map((p) => (p.result?.body as { id?: string } | undefined)?.id)
      .filter((id): id is string => Boolean(id)),
  );
}

export const scorecardSection: DemoSection<ScorecardInput> = {
  id: "scorecard",
  title: "Scorecard",

  parse(input) {
    const i = (input ?? {}) as Record<string, unknown>;
    const p = (i.profile ?? {}) as Record<string, unknown>;
    const profile = p.id !== undefined ? { id: text(p.id, "profile", 100) } : { name: text(p.name, "Profile name", 100) };
    const metrics = [...new Set((Array.isArray(i.metrics) ? i.metrics : []).map((m) => assertId(m, "metric definition")))];
    if (metrics.length > 12) throw invalid("At most 12 metrics.");
    return { activate: i.activate !== false, profile, metrics };
  },

  async status(client, userId, now = new Date()) {
    const [status, profiles, definitions, current] = await Promise.all([
      client.get<{ isActive?: boolean; dateStart?: string }>("/api/v2/gamification/status").then((r) => r.body),
      client.get<{ entities?: Profile[] }>("/api/v2/gamification/profiles").then((r) => (r.body.entities ?? []).map((p) => ({ id: p.id, name: p.name === "DEFAULT_PROFILE_NAME" ? "Default profile" : p.name, active: p.active, memberCount: p.memberCount }))),
      client.get<{ entities?: MetricDefinition[] }>("/api/v2/gamification/metricdefinitions").then((r) => (r.body.entities ?? []).map((d) => ({ id: d.id, name: d.name, label: metricLabel(d.name) }))),
      currentProfile(client, userId, now).catch(() => undefined),
    ]);
    const currentMetrics = current
      ? ((await client.get<{ entities?: Array<{ name?: string }> }>(`/api/v2/gamification/profiles/${current}/metrics`).catch(() => ({ body: { entities: [] } }))).body.entities ?? []).map((m) => m.name).filter(Boolean)
      : [];
    return { gamification: { active: Boolean(status.isActive), dateStart: status.dateStart }, profiles, definitions, currentProfile: current, currentMetrics, own: [...ownProfiles(client.profile.name)], defaults: { profile: DEFAULT_PROFILE_NAME, metrics: DEFAULT_SCORECARD_METRICS } };
  },

  async next(userId, input, { ctx, group, now = new Date() }) {
    const client = ctx.client;
    const steps: DemoStep[] = [];
    const notes: string[] = [];
    const status = (await client.get<{ isActive?: boolean; dateStart?: string; automaticUserAssignment?: boolean }>("/api/v2/gamification/status")).body;
    if (!status.isActive) {
      if (!input.activate) notes.push("Gamification is off, so the scorecard stays empty until someone switches it on.");
      else {
        const was = { isActive: false, ...(status.dateStart ? { dateStart: status.dateStart } : {}) };
        return {
          steps: [{ title: "switch gamification on", subject: `demo-ready:before:${JSON.stringify(was)}`, request: { method: "PUT", path: "/api/v2/gamification/status", body: { isActive: true, dateStart: today(now), automaticUserAssignment: Boolean(status.automaticUserAssignment) } } }],
          notes,
        };
      }
    }

    let profile: Profile | undefined;
    if ("id" in input.profile) {
      try {
        profile = (await client.get<Profile>(`/api/v2/gamification/profiles/${encodeURIComponent(input.profile.id)}`)).body;
      } catch (err) {
        if (!(err instanceof GctkError && err.code === "HTTP_404")) throw err;
        return { steps, notes: [...notes, `Performance profile ${input.profile.id} does not exist.`] };
      }
    } else {
      const name = input.profile.name;
      const id = createdInRun(group, "/api/v2/gamification/profiles").get(name) ?? (await client.get<{ entities?: Profile[] }>("/api/v2/gamification/profiles")).body.entities?.find((p) => p.name === name)?.id;
      if (!id) {
        const home = (await client.get<{ id: string }>("/api/v2/authorization/divisions/home")).body.id;
        steps.push({
          title: `create performance profile "${name}"`,
          // Without copyMetrics=false Genesys copies the default profile's metrics (seen live).
          request: { method: "POST", path: "/api/v2/gamification/profiles", query: { copyMetrics: false }, body: { name, division: { id: home }, description: "Scorecard for agent demos (gctk Demo ready).", reportingIntervals: [{ intervalType: "Week", intervalValue: 4 }], active: true, maxLeaderboardRankSize: 300 } },
        });
        return { steps, notes };
      }
      profile = (await client.get<Profile>(`/api/v2/gamification/profiles/${id}`)).body;
    }
    const label = profile.name === "DEFAULT_PROFILE_NAME" ? "Default profile" : profile.name;
    const own = ownProfiles(client.profile.name).has(profile.id) || createdInRun(group, "/api/v2/gamification/profiles").get(profile.name) === profile.id;
    if (profile.active === false) {
      // Profiles cannot be deleted: Clean up deactivates the page's own ones, and a new run turns them on again.
      if (own) return { steps: [{ title: `activate performance profile "${label}"`, request: { method: "POST", path: `/api/v2/gamification/profiles/${profile.id}/activate`, body: {} } }], notes };
      return { steps, notes: [...notes, `"${label}" is not active; choose another profile or name.`] };
    }

    // Metrics only for profiles Demo ready created; other profiles belong to the org and stay as they are.
    if (own) {
      const have = new Set(((await client.get<{ entities?: Array<{ metricDefinitionId?: string }> }>(`/api/v2/gamification/profiles/${profile.id}/metrics`)).body.entities ?? []).map((m) => m.metricDefinitionId));
      const wanted = input.metrics.filter((m) => !have.has(m));
      if (wanted.length) {
        const defs = (await client.get<{ entities?: MetricDefinition[] }>("/api/v2/gamification/metricdefinitions")).body.entities ?? [];
        for (const id of wanted) {
          const d = defs.find((x) => x.id === id);
          if (!d) {
            notes.push(`Metric definition ${id} does not exist; skipped.`);
            continue;
          }
          const o = d.defaultObjective ?? {};
          steps.push({
            title: `add metric "${metricLabel(d.name)}" to "${label}"`,
            // Genesys refuses objectives that start in the past.
            request: { method: "POST", path: `/api/v2/gamification/profiles/${profile.id}/metrics`, body: { name: metricLabel(d.name), metricDefinitionId: d.id, objective: { templateId: o.templateId, zones: o.zones ?? [], enabled: true, dateStart: today(now) } } },
          });
        }
      }
    } else if (input.metrics.length) notes.push(`"${label}" is an existing profile: its metrics are left as they are.`);

    const current = await currentProfile(client, userId, now);
    if (current !== profile.id) {
      steps.push({
        title: `add the agent to performance profile "${label}"`,
        subject: `demo-ready:before:${JSON.stringify({ profile: current ?? null })}`,
        request: { method: "POST", path: `/api/v2/gamification/profiles/${profile.id}/members`, body: { membersToAssign: [userId], membersToRemove: [] } },
      });
    }
    return { steps, notes };
  },
};

// ---------------------------------------------------------------- cleanup

/**
 * What Demo ready created or changed for an agent, read from its records. Only these objects
 * are removed or restored; objects the page merely reused (an existing queue, a published module,
 * an existing program) never appear here.
 */
export type CreatedKind =
  | "appointment"
  | "assignment"
  | "module"
  | "member"
  | "sta-settings"
  | "transcription-settings"
  | "queue-transcription"
  | "program"
  | "topic"
  | "sta-mapping"
  | "sta-unmapped"
  | "evaluation"
  | "evaluation-form"
  | "wfm-bu"
  | "wfm-mu"
  | "wfm-agent"
  | "wfm-schedule"
  | "gamification"
  | "profile"
  | "profile-member";

export interface Created {
  section: string;
  kind: CreatedKind;
  /** Object id; for links the pair (e.g. program and queue). */
  id: string;
  label: string;
  planId: string;
  queueId?: string;
  moduleId?: string;
  /** Settings the page changed: the values before the change. */
  before?: Record<string, unknown>;
  programId?: string;
  /** profile-member: the profile, and the one the agent was in before (null: none). */
  profileId?: string;
  previousProfile?: string | null;
}

const CLEANABLE = ["coaching", "learning", "sta", "evaluations", "scorecard", "schedule"];

export function demoInventory(profile: string, userId: string): Created[] {
  const out: Created[] = [];
  // Timed-out requests may have changed the org as well (Clean up checks the live state anyway).
  const plans = listRecords({ profile, limit: 100_000 })
    .filter((p) => p.status === "applied" || (p.status === "failed" && timedOut(p.result?.error)))
    .reverse();
  for (const p of plans) {
    const m = p.group?.match(/^demo ready · ([\w-]+) · ([0-9a-f-]{36}) · /);
    if (!m || m[2] !== userId || !(CLEANABLE.includes(m[1]!) || m[1] === "refresh")) continue;
    // A refresh only adds schedules (dates are moved on objects the page created anyway).
    const section = m[1] === "refresh" ? "schedule" : m[1]!;
    const { method, path } = p.request;
    const body = (p.request.body ?? {}) as Record<string, any>;
    const res = (p.result?.body ?? {}) as Record<string, any>;
    // Settings the page changed carry their previous values in the record's subject.
    const was = p.subject?.startsWith("demo-ready:before:") ? (JSON.parse(p.subject.slice("demo-ready:before:".length)) as Record<string, any>) : undefined;
    const quoted = p.title.match(/"(.*)"/)?.[0];
    const base = { section, planId: p.id };
    let x: RegExpMatchArray | null;
    if (method === "POST" && path === "/api/v2/coaching/appointments" && res.id) out.push({ ...base, kind: "appointment", id: res.id, label: `coaching appointment "${body.name}"` });
    else if (method === "POST" && path === "/api/v2/learning/assignments" && res.id)
      out.push({ ...base, kind: "assignment", id: res.id, moduleId: body.moduleId, label: `assignment of "${res.module?.name ?? p.title.match(/"(.*)"/)?.[1] ?? body.moduleId}"` });
    else if (method === "POST" && path === "/api/v2/learning/modules" && res.id) out.push({ ...base, kind: "module", id: res.id, label: `learning module "${body.name}"` });
    else if (method === "POST" && (x = path.match(/^\/api\/v2\/routing\/queues\/([^/]+)\/members$/)))
      out.push({ ...base, kind: "member", id: `${x[1]}:${userId}`, queueId: x[1], label: `membership in queue ${quoted ?? x[1]}` });
    else if (method === "PUT" && (x = path.match(/^\/api\/v2\/routing\/queues\/([^/]+)$/)) && was && "enableTranscription" in was)
      out.push({ ...base, kind: "queue-transcription", id: x[1]!, queueId: x[1], label: `transcription in queue ${quoted ?? x[1]}`, before: was });
    else if (method === "PATCH" && path === "/api/v2/speechandtextanalytics/settings" && was)
      out.push({ ...base, kind: "sta-settings", id: `sta-settings:${Object.keys(was).sort().join(",")}`, label: p.title.replace(/^Demo ready \([^)]*\): /, ""), before: was });
    else if (method === "PATCH" && path === "/api/v2/routing/settings/transcription" && was)
      out.push({ ...base, kind: "transcription-settings", id: "transcription-settings", label: "voice transcription for queues and flows", before: was });
    else if (method === "POST" && path === "/api/v2/speechandtextanalytics/programs" && res.id) out.push({ ...base, kind: "program", id: res.id, label: `program "${body.name}"` });
    else if (method === "POST" && path === "/api/v2/speechandtextanalytics/topics" && res.id) out.push({ ...base, kind: "topic", id: res.id, label: `topic "${body.name}" (${body.dialect})` });
    else if (method === "PUT" && (x = path.match(/^\/api\/v2\/speechandtextanalytics\/programs\/([^/]+)\/mappings$/)) && p.subject?.startsWith("demo-ready:added-queue:")) {
      const q = p.subject.slice("demo-ready:added-queue:".length);
      out.push({ ...base, kind: "sta-mapping", id: `${x[1]}:${q}`, programId: x[1], queueId: q, label: `queue in ${quoted ?? "the program"}` });
    } else if (method === "PUT" && (x = path.match(/^\/api\/v2\/speechandtextanalytics\/programs\/([^/]+)\/mappings$/)) && p.subject?.startsWith("demo-ready:removed-queue:")) {
      const q = p.subject.slice("demo-ready:removed-queue:".length);
      out.push({ ...base, kind: "sta-unmapped", id: `${x[1]}:${q}`, programId: x[1], queueId: q, label: `queue ${quoted ?? q} back in its previous program` });
    } else if (method === "POST" && (x = path.match(/^\/api\/v2\/quality\/conversations\/([^/]+)\/evaluations$/)) && res.id)
      out.push({ ...base, kind: "evaluation", id: `${x[1]}:${res.id}`, label: `evaluation of conversation ${x[1]!.slice(0, 8)}${res.answers?.totalScore !== undefined ? ` (score ${Math.round(res.answers.totalScore)})` : ""}` });
    else if (method === "POST" && path === "/api/v2/quality/forms/evaluations" && res.id) out.push({ ...base, kind: "evaluation-form", id: res.id, label: `evaluation form "${body.name}"` });
    else if (method === "POST" && path === `${WFM}/businessunits` && res.id) out.push({ ...base, kind: "wfm-bu", id: res.id, label: `business unit "${body.name}"` });
    else if (method === "POST" && path === `${WFM}/managementunits` && res.id) out.push({ ...base, kind: "wfm-mu", id: res.id, label: `management unit "${body.name}"` });
    else if (method === "POST" && path === `${WFM}/agents` && was)
      out.push({ ...base, kind: "wfm-agent", id: `wfm-agent:${body.destinationManagementUnitId}`, profileId: body.destinationManagementUnitId, previousProfile: (was as { managementUnit?: string | null }).managementUnit ?? null, label: `the agent in ${quoted ?? "the management unit"}` });
    else if (p.subject?.startsWith("demo-ready:schedule-import:")) {
      const [bu, week] = p.subject.slice("demo-ready:schedule-import:".length).split(":");
      out.push({ ...base, kind: "wfm-schedule", id: `${bu}:${week}`, label: `schedule from the week of ${week}` });
    } else if (method === "PUT" && path === "/api/v2/gamification/status" && was)
      out.push({ ...base, kind: "gamification", id: "gamification", label: "gamification switched on", before: was });
    else if (method === "POST" && path === "/api/v2/gamification/profiles" && res.id) out.push({ ...base, kind: "profile", id: res.id, label: `performance profile "${body.name}"` });
    else if (method === "POST" && (x = path.match(/^\/api\/v2\/gamification\/profiles\/([^/]+)\/members$/)) && was)
      out.push({ ...base, kind: "profile-member", id: `${x[1]}:${userId}`, label: `membership in ${quoted ?? "a performance profile"}`, previousProfile: (was as { profile?: string | null }).profile ?? null, profileId: x[1] });
  }
  // Each object once, with the earliest previous values (a second run may have changed it again).
  return out.filter((c, i) => out.findIndex((o) => o.kind === c.kind && o.id === c.id) === i);
}

export interface CleanupInput {
  sections: string[];
}

export interface CleanupItem {
  section: string;
  label: string;
  state: "remove" | "restore" | "gone" | "kept";
  reason?: string;
}

/** Assesses every created item live and, with a run's group, returns the removals that are possible now. */
async function assessCleanup(client: GenesysClient, userId: string, sections: string[], group?: string) {
  const inv = demoInventory(client.profile.name, userId).filter((c) => sections.includes(c.section));
  const items: CleanupItem[] = [];
  const steps: DemoStep[] = [];
  const notes: string[] = [];
  const item = (c: Created, state: CleanupItem["state"], reason?: string) => items.push({ section: c.section, label: c.label, state, ...(reason ? { reason } : {}) });
  const of = (k: CreatedKind) => inv.filter((c) => c.kind === k);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  const appointments = of("appointment").length ? await listAppointments(client, userId) : [];
  for (const c of of("appointment")) {
    const a = appointments.find((x) => x.id === c.id);
    if (!a) item(c, "gone");
    else if (a.status !== "Scheduled") item(c, "kept", `it is ${a.status?.toLowerCase()}; Genesys Cloud only deletes scheduled appointments`);
    else {
      item(c, "remove");
      steps.push({ title: `delete ${c.label}`, request: { method: "DELETE", path: `/api/v2/coaching/appointments/${c.id}` } });
    }
  }

  const assignments = of("assignment").length || of("module").length ? await listAssignments(client, userId) : [];
  for (const c of of("assignment")) {
    if (!assignments.some((a) => a.id === c.id)) item(c, "gone");
    else {
      item(c, "remove");
      steps.push({ title: `remove the ${c.label}`, request: { method: "DELETE", path: `/api/v2/learning/assignments/${c.id}` } });
    }
  }
  for (const c of of("module")) {
    let mod: { isPublished?: boolean; isArchived?: boolean };
    try {
      mod = (await client.get<{ isPublished?: boolean; isArchived?: boolean }>(`/api/v2/learning/modules/${c.id}`)).body;
    } catch (err) {
      if (err instanceof GctkError && err.code === "HTTP_404") {
        item(c, "gone");
        continue;
      }
      throw err;
    }
    if (mod.isArchived) {
      item(c, "gone", "archived; Genesys Cloud keeps published modules archived instead of deleting them");
      continue;
    }
    const ours = of("assignment").filter((a) => a.moduleId === c.id).map((a) => a.id);
    const all = await entities<{ id: string; state?: string }>(client, "/api/v2/learning/assignments", { moduleId: c.id }, 200);
    const others = all.filter((a) => a.state !== "Deleted" && !ours.includes(a.id));
    if (others.length) {
      item(c, "kept", `assigned to ${others.length} other assignment${others.length > 1 ? "s" : ""}`);
      continue;
    }
    // Published modules cannot be deleted, only archived; after the agent's assignment is gone (an earlier wave).
    item(c, "remove", mod.isPublished ? "archived: Genesys Cloud does not delete published modules" : undefined);
    if (!all.some((a) => a.state !== "Deleted" && ours.includes(a.id))) {
      steps.push(
        mod.isPublished
          ? { title: `archive ${c.label}`, request: { method: "POST", path: `/api/v2/learning/modules/${c.id}/jobs`, body: { action: "ImmediateArchive" } } }
          : { title: `delete ${c.label}`, request: { method: "DELETE", path: `/api/v2/learning/modules/${c.id}` } },
      );
    }
  }

  // Speech and text analytics. Programs the page created are deleted (their queue mappings go with
  // them); a queue added to an existing program is taken out again; a queue the page took out of
  // another program goes back there once it is in no program any more (one program per queue).
  if (of("member").length) {
    const mine = await entities<{ id: string }>(client, `/api/v2/users/${userId}/queues`);
    for (const c of of("member")) {
      if (!mine.some((q) => q.id === c.queueId)) item(c, "gone");
      else {
        item(c, "remove");
        steps.push({ title: `take the agent out of ${c.label.replace(/^membership in /, "")}`, request: { method: "DELETE", path: `/api/v2/routing/queues/${c.queueId}/members/${userId}` } });
      }
    }
  }
  const ownPrograms = new Set<string>();
  for (const c of of("program")) {
    if (!(await exists(client, `/api/v2/speechandtextanalytics/programs/${c.id}`))) {
      item(c, "gone");
      continue;
    }
    ownPrograms.add(c.id);
    item(c, "remove");
    steps.push({ title: `delete ${c.label}`, request: { method: "DELETE", path: `/api/v2/speechandtextanalytics/programs/${c.id}` } });
  }
  // Deleting a topic also takes it out of every program, which stay published (seen live).
  for (const c of of("topic")) {
    if (!(await exists(client, `/api/v2/speechandtextanalytics/topics/${c.id}`))) item(c, "gone");
    else {
      item(c, "remove");
      steps.push({ title: `delete ${c.label}`, request: { method: "DELETE", path: `/api/v2/speechandtextanalytics/topics/${c.id}` } });
    }
  }
  const mappings = of("sta-mapping").length || of("sta-unmapped").length ? await programMappings(client) : [];
  for (const c of of("sta-mapping")) {
    // Goes with the program; also right after its deletion, while the mappings list still shows it (seen live).
    if (of("program").some((p) => p.id === c.programId)) continue;
    const m = mappings.find((x) => x.program?.id === c.programId);
    if (!(m?.queues ?? []).some((q) => q.id === c.queueId)) {
      item(c, "gone");
      continue;
    }
    item(c, "restore", "the queue leaves the program");
    steps.push({ title: `take the queue out of ${c.label.replace(/^queue in /, "")}`, request: { method: "PUT", path: `/api/v2/speechandtextanalytics/programs/${c.programId}/mappings`, body: mappingBody(m, (m!.queues ?? []).map((q) => q.id).filter((q) => q !== c.queueId)) } });
  }
  for (const c of of("sta-unmapped")) {
    const now = programOf(mappings, c.queueId!);
    if (now === c.programId) {
      item(c, "gone");
      continue;
    }
    item(c, "restore");
    // Only once the queue is in no program (after the steps above were applied).
    const leaving = now && (ownPrograms.has(now) || of("sta-mapping").some((x) => x.programId === now && x.queueId === c.queueId));
    if (!now && (await exists(client, `/api/v2/speechandtextanalytics/programs/${c.programId}`))) {
      const m = mappings.find((x) => x.program?.id === c.programId);
      steps.push({ title: `put the queue back into its previous program`, request: { method: "PUT", path: `/api/v2/speechandtextanalytics/programs/${c.programId}/mappings`, body: mappingBody(m, [...(m?.queues ?? []).map((q) => q.id), c.queueId!]) } });
    } else if (now && !leaving) items[items.length - 1] = { section: c.section, label: c.label, state: "kept", reason: "the queue is in another program now" };
  }
  for (const c of of("sta-settings")) {
    const now = (await client.get<Record<string, unknown>>("/api/v2/speechandtextanalytics/settings")).body;
    const back = Object.fromEntries(Object.entries(c.before ?? {}).filter(([k, v]) => !same(now[k] ?? (k === "expectedDialects" ? [] : false), v)));
    if (!Object.keys(back).length) item(c, "gone");
    else {
      item(c, "restore", "changes analytics for the whole org");
      steps.push({ title: `restore the ${c.label.replace(/ on\b/g, "")}`, request: { method: "PATCH", path: "/api/v2/speechandtextanalytics/settings", body: back } });
    }
  }
  for (const c of of("transcription-settings")) {
    const now = (await client.get<TranscriptionSettings>("/api/v2/routing/settings/transcription")).body;
    if (same(now.transcription, c.before?.transcription)) item(c, "gone");
    else {
      item(c, "restore", "voice transcription back off for the whole org");
      steps.push({ title: "restore the voice transcription setting", request: { method: "PATCH", path: "/api/v2/routing/settings/transcription", body: { transcription: c.before?.transcription, transcriptionConfidenceThreshold: now.transcriptionConfidenceThreshold ?? 60 } } });
    }
  }
  for (const c of of("queue-transcription")) {
    let q: Queue;
    try {
      q = (await client.get<Queue>(`/api/v2/routing/queues/${c.queueId}`)).body;
    } catch (err) {
      if (err instanceof GctkError && err.code === "HTTP_404") {
        item(c, "gone");
        continue;
      }
      throw err;
    }
    if (Boolean(q.enableTranscription) === Boolean(c.before?.enableTranscription)) item(c, "gone");
    else {
      item(c, "restore");
      steps.push({ title: `restore ${c.label}`, request: { method: "PUT", path: `/api/v2/routing/queues/${c.queueId}`, body: { ...q, enableTranscription: Boolean(c.before?.enableTranscription) } } });
    }
  }

  // Evaluations the page created are deleted; its forms only while unpublished (Genesys keeps published forms).
  for (const c of of("evaluation")) {
    const [conv, id] = c.id.split(":");
    const path = `/api/v2/quality/conversations/${conv}/evaluations/${id}`;
    if (!(await exists(client, path))) item(c, "gone");
    else {
      item(c, "remove");
      steps.push({ title: `delete the ${c.label}`, request: { method: "DELETE", path } });
    }
  }
  for (const c of of("evaluation-form")) {
    const path = `/api/v2/quality/forms/evaluations/${c.id}`;
    if (!(await exists(client, path))) {
      item(c, "gone");
      continue;
    }
    const published = (await entities<{ id: string }>(client, "/api/v2/quality/publishedforms/evaluations")).some((f) => f.id === c.id);
    if (published) item(c, "kept", "published: Genesys Cloud does not delete published evaluation forms");
    else {
      item(c, "remove");
      steps.push({ title: `delete ${c.label}`, request: { method: "DELETE", path } });
    }
  }

  // Schedule: the page's schedules, the agent back where it was, then the management unit and the
  // business unit the page created (Genesys deletes a business unit only without management units).
  let schedulesLeft = false;
  for (const c of of("wfm-schedule")) {
    const [bu, week] = c.id.split(":");
    const list = (await client.get<{ entities?: BuSchedule[] }>(`${WFM}/businessunits/${bu}/weeks/${week}/schedules`, { includeOnlyPublished: "false" }).catch(() => ({ body: { entities: [] as BuSchedule[] } }))).body.entities ?? [];
    const ours = list.filter((x) => x.description === SCHEDULE_DESCRIPTION);
    if (!ours.length) item(c, "gone");
    else {
      item(c, "remove");
      schedulesLeft = true;
      for (const x of ours) steps.push({ title: `delete the ${c.label}`, request: { method: "DELETE", path: `${WFM}/businessunits/${bu}/weeks/${week}/schedules/${x.id}` } });
    }
  }
  const wfmAgent = of("wfm-agent");
  const agentNow = wfmAgent.length || of("wfm-mu").length ? await agentManagementUnit(client, userId) : null;
  // Moving an agent takes a moment (seen live): a move this run made already is waited for, not repeated.
  const movedThisRun = Boolean(group && listRecords({ group, status: "applied", limit: 1000 }).some((p) => p.request.path === `${WFM}/agents` && ((p.request.body as { userIds?: string[] })?.userIds ?? []).includes(userId)));
  let busy: string | undefined;
  for (const c of wfmAgent) {
    if (agentNow?.id !== c.profileId) {
      item(c, "gone");
      continue;
    }
    item(c, "restore", c.previousProfile ? "back to the management unit it was in before" : "out of the management unit");
    if (movedThisRun) {
      busy = "Genesys Cloud is still moving the agent out of the management unit; press Continue in a moment.";
      continue;
    }
    steps.push({ title: c.previousProfile ? "move the agent back to their previous management unit" : "take the agent out of the management unit", request: { method: "POST", path: `${WFM}/agents`, body: { userIds: [userId], ...(c.previousProfile ? { destinationManagementUnitId: c.previousProfile } : {}) } } });
  }
  const musLeft = new Set<string>();
  for (const c of of("wfm-mu")) {
    if (!(await exists(client, `${WFM}/managementunits/${c.id}`))) {
      item(c, "gone");
      continue;
    }
    musLeft.add(c.id);
    item(c, "remove");
    // After the schedule is deleted and the agent is out (earlier waves).
    if (agentNow?.id !== c.id && !schedulesLeft) steps.push({ title: `delete ${c.label}`, request: { method: "DELETE", path: `${WFM}/managementunits/${c.id}` } });
  }
  for (const c of of("wfm-bu")) {
    if (!(await exists(client, `${WFM}/businessunits/${c.id}`))) {
      item(c, "gone");
      continue;
    }
    const mus = await entities<Mu>(client, `${WFM}/businessunits/${c.id}/managementunits`);
    if (mus.some((m) => !musLeft.has(m.id))) item(c, "kept", "it has management units the page did not create");
    else {
      item(c, "remove");
      if (!mus.length) steps.push({ title: `delete ${c.label}`, request: { method: "DELETE", path: `${WFM}/businessunits/${c.id}` } });
    }
  }

  // Scorecard: the agent back to the profile before, then profiles Demo ready created deactivated
  // (Genesys cannot delete them), then gamification switched off again if it was off before.
  const members = of("profile-member");
  const profiles = of("profile");
  let pending = false;
  if (members.length || profiles.length) {
    const current = await currentProfile(client, userId, new Date()).catch(() => undefined);
    for (const c of members) {
      const pid = c.profileId!;
      if (current !== pid) {
        item(c, "gone");
        continue;
      }
      item(c, "restore", c.previousProfile ? "back to the profile the agent was in before" : undefined);
      pending = true;
      steps.push(
        c.previousProfile
          ? { title: `move the agent back to their previous performance profile`, request: { method: "POST", path: `/api/v2/gamification/profiles/${c.previousProfile}/members`, body: { membersToAssign: [userId], membersToRemove: [] } } }
          : { title: `take the agent out of ${c.label.replace(/^membership in /, "")}`, request: { method: "POST", path: `/api/v2/gamification/profiles/${pid}/members`, body: { membersToAssign: [], membersToRemove: [userId] } } },
      );
    }
    for (const c of profiles) {
      let prof: { active?: boolean; memberCount?: number };
      try {
        prof = (await client.get<{ active?: boolean; memberCount?: number }>(`/api/v2/gamification/profiles/${c.id}`)).body;
      } catch (err) {
        if (err instanceof GctkError && err.code === "HTTP_404") {
          item(c, "gone");
          continue;
        }
        throw err;
      }
      if (!prof.active) {
        item(c, "gone", "deactivated; Genesys Cloud cannot delete performance profiles");
        continue;
      }
      const others = (prof.memberCount ?? 0) - (current === c.id ? 1 : 0);
      if (others > 0) {
        item(c, "kept", `${others} other member${others > 1 ? "s" : ""} use it`);
        continue;
      }
      item(c, "remove", "deactivated: Genesys Cloud cannot delete performance profiles");
      pending = true;
      if (current !== c.id) steps.push({ title: `deactivate ${c.label}`, request: { method: "POST", path: `/api/v2/gamification/profiles/${c.id}/deactivate`, body: {} } });
    }
  }
  for (const c of of("gamification")) {
    const st = (await client.get<{ isActive?: boolean; dateStart?: string; automaticUserAssignment?: boolean }>("/api/v2/gamification/status")).body;
    if (!st.isActive || c.before?.isActive) {
      item(c, "gone");
      continue;
    }
    item(c, "restore", "switches gamification off for the whole org");
    if (!pending) steps.push({ title: "switch gamification off again", request: { method: "PUT", path: "/api/v2/gamification/status", body: { isActive: false, dateStart: st.dateStart, automaticUserAssignment: Boolean(st.automaticUserAssignment) } } });
  }
  return { items, steps, notes, busy };
}

async function exists(client: GenesysClient, path: string): Promise<boolean> {
  try {
    await client.get(path);
    return true;
  } catch (err) {
    if (err instanceof GctkError && (err.code === "HTTP_404" || err.code === "HTTP_410")) return false;
    throw err;
  }
}

export const cleanupSection: DemoSection<CleanupInput> = {
  id: "cleanup",
  title: "Clean up",

  parse(input) {
    const i = (input ?? {}) as { sections?: unknown };
    const sections = (Array.isArray(i.sections) ? i.sections : []).filter((s): s is string => typeof s === "string");
    const unknown = sections.filter((s) => !CLEANABLE.includes(s));
    if (unknown.length) throw invalid(`Unknown section(s): ${unknown.join(", ")}.`);
    if (!sections.length) throw invalid("Choose at least one section to clean up.");
    return { sections };
  },

  async status(client, userId) {
    const { items } = await assessCleanup(client, userId, CLEANABLE);
    return { items, notRemovable: ["Conversations and their analytics results stay in Genesys Cloud; there is no API to delete them. They age out with the org's data retention."] };
  },

  async next(userId, input, { ctx, group }) {
    const { steps, notes, busy } = await assessCleanup(ctx.client, userId, input.sections, group);
    return { steps, notes, ...(busy && !steps.length ? { busy } : {}) };
  },
};

// ---------------------------------------------------------------- refresh

/**
 * Demo data ages: appointments and due dates slip into the past, and the schedule covers only the
 * weeks it was made for. Refresh moves what the page created (never other objects) forward by whole
 * weeks, so weekday and time stay as they were, and publishes a new schedule when the current week
 * has none.
 */
export interface RefreshInput {
  coaching: boolean;
  learning: boolean;
  schedule: boolean;
}

const WEEK = 7 * 86_400_000;
/** Whole weeks to add so the date lies at least an hour ahead; 0 when it already does. */
export function weeksToFuture(iso: string, now: Date): number {
  const late = now.getTime() + 3_600_000 - Date.parse(iso);
  return late < 0 ? 0 : Math.floor(late / WEEK) + 1;
}
const plusWeeks = (iso: string, weeks: number) => new Date(Date.parse(iso) + weeks * WEEK).toISOString().replace(/\.\d{3}Z$/, "Z");
const weeksText = (n: number) => `${n} week${n > 1 ? "s" : ""}`;

/** Schedules the page imported (any run), with the weeks each covers. */
function demoSchedules(profile: string, userId: string): Array<{ bu: string; week: string; weeks: number }> {
  const out: Array<{ bu: string; week: string; weeks: number }> = [];
  const plans = listRecords({ profile, status: "applied", limit: 100_000 }).filter((p) => p.group?.startsWith("demo ready · ") && p.group.includes(` · ${userId} · `));
  for (const p of plans) {
    if (!p.subject?.startsWith("demo-ready:schedule-import:")) continue;
    const [bu, week] = p.subject.slice("demo-ready:schedule-import:".length).split(":");
    const upload = plans.find((u) => u.subject === `demo-ready:schedule-upload:${bu}:${week}`);
    out.push({ bu: bu!, week: week!, weeks: Number(upload?.title.match(/a (\d)-week schedule/)?.[1] ?? 1) });
  }
  return out;
}

async function refreshState(client: GenesysClient, userId: string, now: Date) {
  const inv = demoInventory(client.profile.name, userId);
  const ids = (k: CreatedKind) => new Set(inv.filter((c) => c.kind === k).map((c) => c.id));
  const own = { appointments: ids("appointment"), assignments: ids("assignment") };
  const appointments = (own.appointments.size ? await listAppointments(client, userId, now) : [])
    .filter((a) => own.appointments.has(a.id) && a.status === "Scheduled" && weeksToFuture(a.dateStart, now) > 0)
    .map((a) => ({ id: a.id, name: a.name, dateStart: a.dateStart, weeks: weeksToFuture(a.dateStart, now), newDate: plusWeeks(a.dateStart, weeksToFuture(a.dateStart, now)) }));
  const assignments = (own.assignments.size ? await listAssignments(client, userId) : [])
    .filter((a): a is Assignment & { dueDate: string } => own.assignments.has(a.id) && Boolean(a.dueDate) && a.state !== "Completed" && weeksToFuture(a.dueDate!, now) > 0)
    .map((a) => ({ id: a.id, moduleName: a.moduleName, dueDate: a.dueDate, weeks: weeksToFuture(a.dueDate, now), newDate: plusWeeks(a.dueDate, weeksToFuture(a.dueDate, now)) }));

  // Schedule: only where the page made one before, in the agent's current business unit.
  const made = demoSchedules(client.profile.name, userId);
  let schedule: { state: "none" | "current" | "stale"; week?: string; weeks?: number; businessUnit?: { id: string; name: string; timeZone: string; createdByDemo: boolean }; managementUnit?: string } = { state: "none" };
  if (made.length) {
    const mu = await agentManagementUnit(client, userId);
    const mine = made.filter((m) => m.bu === mu?.businessUnitId);
    if (mu?.businessUnitId && mine.length) {
      const bu = (await client.get<Bu>(`${WFM}/businessunits/${mu.businessUnitId}`, { expand: "settings" })).body;
      const tz = bu.settings?.timeZone ?? "UTC";
      const week = weekStart(now, tz, bu.settings?.startDayOfWeek ?? "Monday");
      const covered = mine.some((m) => m.week <= week && week < addDays(m.week, m.weeks * 7));
      schedule = {
        state: covered ? "current" : "stale",
        week,
        weeks: mine[mine.length - 1]!.weeks,
        businessUnit: { id: bu.id, name: bu.name, timeZone: tz, createdByDemo: inv.some((c) => c.kind === "wfm-bu" && c.id === bu.id) },
        managementUnit: mu.id,
      };
    }
  }
  return { appointments, assignments, schedule, stale: appointments.length + assignments.length + (schedule.state === "stale" ? 1 : 0) };
}

export const refreshSection: DemoSection<RefreshInput> = {
  id: "refresh",
  title: "Refresh dates",

  parse(input) {
    const i = (input ?? {}) as Record<string, unknown>;
    const r = { coaching: i.coaching !== false, learning: i.learning !== false, schedule: i.schedule !== false };
    if (!r.coaching && !r.learning && !r.schedule) throw invalid("Choose at least one part to refresh.");
    return r;
  },

  status: (client, userId, now = new Date()) => refreshState(client, userId, now),

  async next(userId, input, env) {
    const now = env.now ?? new Date();
    const client = env.ctx.client;
    const st = await refreshState(client, userId, now);
    const steps: DemoStep[] = [];
    const notes: string[] = [];
    if (input.coaching) {
      for (const a of st.appointments) {
        steps.push({ title: `move coaching appointment "${a.name}" forward by ${weeksText(a.weeks)}`, request: { method: "PATCH", path: `/api/v2/coaching/appointments/${a.id}`, body: { dateStart: a.newDate } } });
      }
    }
    if (input.learning) {
      for (const a of st.assignments) {
        steps.push({ title: `move the due date of "${a.moduleName}" forward by ${weeksText(a.weeks)}`, request: { method: "PATCH", path: `/api/v2/learning/assignments/${a.id}/reschedule`, body: { dateRecommendedForCompletion: a.newDate } } });
      }
    }
    let busy: string | undefined;
    if (input.schedule && st.schedule.state === "stale") {
      const { businessUnit: bu, managementUnit, weeks } = st.schedule;
      // A business unit the page created takes another demo schedule; an existing one only when its week is free.
      const parsed = scheduleSection.parse({ businessUnit: bu!.createdByDemo ? { name: bu!.name, timeZone: bu!.timeZone } : { id: bu!.id }, managementUnit: { id: managementUnit }, weeks: Math.max(2, weeks ?? 2) });
      const wave = await scheduleSection.next(userId, parsed, env);
      steps.push(...wave.steps);
      notes.push(...wave.notes);
      busy = wave.busy;
    }
    return { steps, notes, ...(busy ? { busy } : {}) };
  },
};

export const SECTIONS: Record<string, DemoSection<any>> = { coaching: coachingSection, learning: learningSection, sta: staSection, evaluations: evaluationsSection, scorecard: scorecardSection, schedule: scheduleSection, refresh: refreshSection, cleanup: cleanupSection };

export function demoSection(id: string): DemoSection<unknown> {
  const s = SECTIONS[id];
  if (!s) throw invalid(`Unknown demo section "${id}".`);
  return s;
}

// ----------------------------------------------------------------- runner

const timedOut = (error?: string) => Boolean(error && /HTTP_504|gateway\.timeout/.test(error));

export interface DemoRunResult {
  group: string;
  /** Nothing is left to do for this input. */
  done: boolean;
  applied: Array<{ id: string; title: string; status: string; error?: string }>;
  /** Genesys is still working (e.g. publishing): run again with the same input a bit later. */
  busy?: boolean;
  notes: string[];
}

/** Groups of the page start with this, then section and agent. */
export const demoGroupPrefix = (section: string, userId: string) => `demo ready · ${section} · ${userId} · `;

// Some sections need several waves (create, then publish, then assign).
const MAX_WAVES = 8;

/** Runs a section wave by wave: sends each wave to the org, then asks the section for the next one. */
export async function runDemoSection(
  section: DemoSection<unknown>,
  input: unknown,
  opts: { client: GenesysClient; userId: string; agentName?: string; now?: Date; uploadFetch?: typeof fetch },
): Promise<DemoRunResult> {
  const { client, userId } = opts;
  const parsed = section.parse(input, opts.now);
  // The random part keeps two presses within one second apart (one-off actions are sent once per group).
  const group = `${demoGroupPrefix(section.id, userId)}${new Date().toISOString().slice(0, 19)}Z ${crypto.randomBytes(2).toString("hex")}`;
  const result: DemoRunResult = { group, done: false, applied: [], notes: [] };
  const who = opts.agentName ? ` for ${opts.agentName}` : "";

  for (let wave = 0; wave <= MAX_WAVES; wave++) {
    const { steps, notes, busy } = await section.next(userId, parsed, { ctx: { client }, group, now: opts.now });
    for (const n of notes) if (!result.notes.includes(n)) result.notes.push(n);
    if (!steps.length) {
      if (busy) {
        result.busy = true;
        result.notes.push(busy);
      } else result.done = true;
      return result;
    }
    if (wave === MAX_WAVES) break;
    const sent = [];
    for (const step of steps) {
      const rec = await sendStep(client, { group, title: `Demo ready (${section.title}${who}): ${step.title}`, ...(step.subject ? { subject: step.subject } : {}), request: step.request }, { uploadFetch: opts.uploadFetch, now: opts.now });
      const row = { id: rec.id, title: rec.title, status: rec.status, ...(rec.result?.error ? { error: rec.result.error } : {}) };
      result.applied.push(row);
      sent.push(row);
    }
    // A gateway timeout often still changes the org (seen live with gamification activation):
    // look at the state again in the next wave instead of stopping.
    const failed = sent.filter((a) => a.status !== "applied");
    if (failed.some((a) => !timedOut(a.error))) return result;
    for (const a of failed) {
      const n = `Genesys Cloud timed out on "${a.title.replace(/^Demo ready \([^)]*\): /, "")}"; the state is checked again.`;
      if (!result.notes.includes(n)) result.notes.push(n);
    }
  }
  result.notes.push("Stopped after several rounds although changes are still missing; check the agent's data in Genesys Cloud.");
  return result;
}
