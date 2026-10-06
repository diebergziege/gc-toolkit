import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenProvider } from "../src/core/auth.js";
import { GenesysClient } from "../src/core/client.js";
import { GctkError } from "../src/core/errors.js";
import { buildShifts, cleanupSection, coachingSection, demoInventory, demoSection, evaluationAnswers, evaluationsSection, pickAnswer, refreshSection, scheduleSection, scorecardSection, staSection, weekStart, weeksToFuture, zonedTime, learningSection, richText, runDemoSection, type DemoSection } from "../src/core/demo-ready.js";
import { listRecords } from "../src/core/demo-log.js";
import { saveProfile, type Profile } from "../src/core/profiles.js";

const AGENT = "1a037595-f2e7-4cb6-8b2e-72eb3d9fcae3";
const COACH = "c7625bec-9914-4b02-95f3-225f53010647";
const NOW = new Date("2026-09-26T12:00:00Z");

type Appt = { id: string; name: string; description: string; dateStart: string; lengthInMinutes: number; status: string; attendees: Array<{ id: string }>; facilitator?: { id: string } };
let home: string;
type Mod = { id: string; name: string; isPublished: boolean; isArchived?: boolean; source?: string };
type Asg = { id: string; module: { id: string; name: string }; user: { id: string }; state: string; dateRecommendedForCompletion: string };
let org: { appointments: Appt[]; modules: Mod[]; assignments: Asg[]; calls: string[]; bodies: unknown[] };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function profile(kind = "none"): Profile {
  const p: Profile = { name: `demo-${kind}`, region: "euw2.pure.cloud", tier: "sandbox", credentials: "env" };
  saveProfile(p);
  return p;
}

/** A tiny coaching API: list with userIds filter, create, status change, delete (scheduled only). */
function client(p: Profile): GenesysClient {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith("login.")) return json({ access_token: "t", expires_in: 3600 });
    const method = init.method ?? "GET";
    org.calls.push(`${method} ${url.pathname}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (body !== undefined) org.bodies.push(body);
    const lm = url.pathname.match(/^\/api\/v2\/learning\/modules(?:\/([^/]+))?(\/publish|\/jobs)?$/);
    if (lm) {
      if (method === "GET" && !lm[1]) return json({ entities: org.modules, pageSize: 100, pageNumber: 1, pageCount: 1 });
      if (method === "GET") {
        const mod = org.modules.find((x) => x.id === lm[1]);
        return mod ? json(mod) : json({ message: "not found" }, 404);
      }
      if (method === "DELETE") {
        if (org.modules.find((x) => x.id === lm[1])?.isPublished) return json({ code: "wem.learning.forbidden.action" }, 400);
        org.modules = org.modules.filter((x) => x.id !== lm[1]);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && !lm[1]) {
        const mod: Mod = { id: uuid(), name: body.name, isPublished: false };
        org.modules.push(mod);
        return json(mod);
      }
      const mod = org.modules.find((x) => x.id === lm[1]);
      if (!mod) return json({ message: "not found" }, 404);
      if (lm[2] === "/jobs") {
        mod.isArchived = body.action === "ImmediateArchive";
        return json({ id: "job-1" });
      }
      mod.isPublished = true;
      return json({ id: mod.id, version: 1 });
    }
    const la = url.pathname.match(/^\/api\/v2\/learning\/assignments(?:\/([^/]+))?(\/reschedule)?$/);
    if (la) {
      if (method === "PATCH" && la[2]) {
        const a = org.assignments.find((x) => x.id === la[1]);
        if (!a) return json({ message: "not found" }, 404);
        a.dateRecommendedForCompletion = body.dateRecommendedForCompletion;
        return json(a);
      }
      if (method === "GET") {
        const byModule = url.searchParams.get("moduleId");
        return json({ entities: org.assignments.filter((a) => (byModule ? a.module.id === byModule : a.user.id === url.searchParams.get("userId"))), pageSize: 100, pageNumber: 1, pageCount: 1 });
      }
      if (method === "POST") {
        const mod = org.modules.find((x) => x.id === body.moduleId && x.isPublished);
        if (!mod) return json({ code: "wem.learning.module.not.found" }, 404);
        const a: Asg = { id: uuid(), module: { id: mod.id, name: mod.name }, user: { id: body.userId }, state: "Assigned", dateRecommendedForCompletion: body.recommendedCompletionDate };
        org.assignments.push(a);
        return json(a);
      }
      org.assignments = org.assignments.filter((a) => a.id !== la[1]);
      return new Response(null, { status: 204 });
    }
    const m = url.pathname.match(/^\/api\/v2\/coaching\/appointments(?:\/([^/]+))?(\/status)?$/);
    if (!m) return json({ message: "not found" }, 404);
    if (method === "GET" && !m[1]) {
      const user = url.searchParams.get("userIds");
      return json({ entities: org.appointments.filter((a) => a.attendees.some((x) => x.id === user)), pageSize: 100, pageNumber: 1, pageCount: 1 });
    }
    const appt = org.appointments.find((a) => a.id === m[1]);
    if (method === "POST") {
      const a: Appt = { id: `0000000${org.appointments.length}-0000-4000-8000-000000000000`, ...body, status: "Scheduled", attendees: body.attendeeIds.map((id: string) => ({ id })), ...(body.facilitatorId ? { facilitator: { id: body.facilitatorId } } : {}) };
      org.appointments.push(a);
      return json(a, 201);
    }
    if (!appt) return json({ message: "not found" }, 404);
    if (method === "GET") return json(appt);
    if (method === "PATCH" && m[2]) {
      appt.status = body.status;
      return json({ status: body.status });
    }
    if (method === "PATCH") {
      Object.assign(appt, body);
      return json(appt);
    }
    if (method === "DELETE") {
      if (appt.status !== "Scheduled") return json({ code: "appointment.conflict", message: "Cannot delete in progress or completed appointment." }, 409);
      org.appointments = org.appointments.filter((a) => a !== appt);
      return new Response(null, { status: 204 });
    }
    return json({ message: "unexpected" }, 400);
  }) as typeof fetch;
  return new GenesysClient(p, { source: "ui", fetchImpl, tokens: new TokenProvider(p.region, () => ({ clientId: "a", clientSecret: "b" }), fetchImpl) });
}

const run = (c: GenesysClient, input: unknown, section: DemoSection<any> = coachingSection) =>
  runDemoSection(section, input, { client: c, userId: AGENT, agentName: "Alex", now: NOW });

const input = {
  appointments: [
    { name: "Kick-off", description: "Goals", dateStart: "2026-09-28T07:00:00.000Z", lengthInMinutes: 30, completed: true },
    { name: "Weekly 1:1", description: "", dateStart: "2026-09-28T08:30:00.000Z", lengthInMinutes: 30, facilitatorId: COACH },
  ],
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-demo-"));
  process.env.GCTK_HOME = home;
  process.env.GCTK_APPROVAL_KEY = "test-approval-key";
  org = { appointments: [], modules: [], assignments: [], calls: [], bodies: [] };
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.GCTK_HOME;
  delete process.env.GCTK_APPROVAL_KEY;
});

describe("demo ready: coaching", () => {
  it("validates the page's input", () => {
    const parse = (i: unknown) => coachingSection.parse(i, NOW);
    expect(() => parse({ appointments: [] })).toThrow(/at least one/);
    expect(() => parse({ appointments: [{ ...input.appointments[0], dateStart: "2026-09-25T09:00:00Z" }] })).toThrow(/past/);
    expect(() => parse({ appointments: [{ ...input.appointments[0], lengthInMinutes: 2 }] })).toThrow(/5 to 480/);
    expect(() => parse({ appointments: [{ ...input.appointments[0], facilitatorId: "../users" }] })).toThrow(/facilitator/);
    expect(() => parse({ appointments: [], remove: ["x/../y"] })).toThrow(/appointment ids/);
    const ok = parse(input);
    // Rounded to the minute; the API requires a description, so the name stands in.
    expect(ok.appointments[1]).toMatchObject({ dateStart: "2026-09-28T08:30:00Z", description: "Weekly 1:1", facilitatorId: COACH });
    expect(() => demoSection("nope")).toThrow(/Unknown demo section/);
  });

  it("creates, then completes, in waves, and a second run changes nothing", async () => {
    const c = client(profile("none"));
    const r = await run(c, input);
    expect(r.done).toBe(true);
    expect(r.applied.map((a) => a.status)).toEqual(["applied", "applied", "applied"]);
    const kickoff = org.appointments.find((a) => a.name === "Kick-off")!;
    expect(org.calls.filter((x) => !x.startsWith("GET"))).toEqual([
      "POST /api/v2/coaching/appointments",
      "POST /api/v2/coaching/appointments",
      `PATCH /api/v2/coaching/appointments/${kickoff.id}/status`,
    ]);
    expect(kickoff).toMatchObject({ attendees: [{ id: AGENT }], status: "Completed" });
    expect(kickoff).not.toHaveProperty("facilitator");
    expect(org.appointments.find((a) => a.name === "Weekly 1:1")).toMatchObject({ status: "Scheduled", facilitator: { id: COACH } });
    expect(new Set(listRecords({ limit: 100 }).map((p) => p.group)).size).toBe(1);

    const again = await run(c, input);
    expect(again).toMatchObject({ done: true, applied: [] });
    expect(org.appointments).toHaveLength(2);
  });

  it("deletes scheduled appointments only", async () => {
    const c = client(profile("none"));
    await run(c, input);
    const r = await run(c, { appointments: [], remove: org.appointments.map((a) => a.id) });
    expect(r.done).toBe(true);
    expect(r.notes.join(" ")).toMatch(/"Kick-off" is completed/);
    expect(org.appointments.map((a) => a.name)).toEqual(["Kick-off"]);
  });
});

describe("demo ready: learning", () => {
  const BEYOND = "11111111-1111-4111-8111-111111111111";
  const newModule = { name: "Handling difficult customers", description: "Five techniques", content: "Listen first.\n<b>Acknowledge</b> & own it.", lengthInMinutes: 15 };
  const input = { assignments: [{ moduleId: BEYOND, dueDate: "2026-10-01T15:00:00.000Z" }, { newModule, dueDate: "2026-10-05T15:00:00.000Z" }] };

  it("validates the page's input", () => {
    const parse = (i: unknown) => learningSection.parse(i, NOW);
    expect(() => parse({ assignments: [] })).toThrow(/at least one/);
    expect(() => parse({ assignments: [{ moduleId: BEYOND, dueDate: "2026-09-20T15:00:00Z" }] })).toThrow(/past/);
    expect(() => parse({ assignments: [{ moduleId: "../x", dueDate: "2026-10-01T15:00:00Z" }] })).toThrow(/module must be an id/);
    expect(() => parse({ assignments: [{ newModule: { ...newModule, content: "" }, dueDate: "2026-10-01T15:00:00Z" }] })).toThrow(/content is required/);
    expect(() => parse({ assignments: [input.assignments[0], input.assignments[0]] })).toThrow(/twice/);
    expect(() => parse({ assignments: [{ newModule: { ...newModule, lengthInMinutes: 10 }, dueDate: "2026-10-01T15:00:00Z" }] })).toThrow(/steps of 15/);
    expect(parse(input).assignments[1]!.dueDate).toBe("2026-10-05T15:00:00Z");
  });

  it("escapes module text into rich text paragraphs", () => {
    expect(richText(newModule.content)).toBe("<p>Listen first.</p><p>&lt;b&gt;Acknowledge&lt;/b&gt; &amp; own it.</p>");
  });

  it("reuses the org's module, creates, publishes and assigns a new one in waves, and assigns nothing twice", async () => {
    org.modules.push({ id: BEYOND, name: "Coaching for Agents", isPublished: true, source: "GenesysBeyond" });
    const c = client(profile("none"));
    const r = await run(c, input, learningSection);
    expect(r).toMatchObject({ done: true });
    const created = org.modules.find((m) => m.name === newModule.name)!;
    expect(org.calls.filter((x) => !x.startsWith("GET"))).toEqual([
      "POST /api/v2/learning/assignments",
      "POST /api/v2/learning/modules",
      `POST /api/v2/learning/modules/${created.id}/publish`,
      "POST /api/v2/learning/assignments",
    ]);
    const createBody = org.bodies.find((b) => (b as { informSteps?: unknown }).informSteps) as { type: string; informSteps: Array<{ order: number; value: string }> };
    expect(createBody.type).toBe("Native");
    expect(createBody.informSteps[0]).toMatchObject({ order: 1, value: richText(newModule.content) });
    expect(org.assignments.map((a) => [a.module.name, a.dateRecommendedForCompletion])).toEqual([
      ["Coaching for Agents", "2026-10-01T15:00:00Z"],
      [newModule.name, "2026-10-05T15:00:00Z"],
    ]);

    const again = await run(c, input, learningSection);
    expect(again).toMatchObject({ done: true, applied: [] });
    expect(org.modules).toHaveLength(2);

    const removed = await run(c, { assignments: [], remove: [org.assignments[0]!.id] }, learningSection);
    expect(removed.applied.map((a) => a.title)).toEqual(['Demo ready (Learning for Alex): remove the assignment of "Coaching for Agents"']);
    expect(org.assignments).toHaveLength(1);
  });

  it("skips modules that no longer exist", async () => {
    const r = await run(client(profile("none")), { assignments: [{ moduleId: BEYOND, dueDate: "2026-10-01T15:00:00Z" }] }, learningSection);
    expect(r.done).toBe(true);
    expect(r.notes.join(" ")).toMatch(/does not exist/);
  });
});

describe("demo ready: clean up", () => {
  it("removes what coaching and learning created, keeps completed appointments and reused modules", async () => {
    const BEYOND = "11111111-1111-4111-8111-111111111111";
    org.modules.push({ id: BEYOND, name: "Coaching for Agents", isPublished: true });
    const c = client(profile("none"));
    await run(c, input);
    await run(c, { assignments: [{ moduleId: BEYOND, dueDate: "2026-10-01T15:00:00Z" }, { newModule: { name: "Own module", description: "", content: "Text", lengthInMinutes: 15 }, dueDate: "2026-10-02T15:00:00Z" }] }, learningSection);
    expect(demoInventory("demo-none", AGENT).map((x) => x.kind).sort()).toEqual(["appointment", "appointment", "assignment", "assignment", "module"]);

    const before = (await cleanupSection.status(c, AGENT)) as { items: Array<{ label: string; state: string }> };
    expect(before.items.find((i) => i.label.includes("Kick-off"))).toMatchObject({ state: "kept" });
    expect(before.items.filter((i) => i.state === "remove")).toHaveLength(4);

    const r = await run(c, { sections: ["coaching", "learning"] }, cleanupSection);
    expect(r.done).toBe(true);
    expect(org.appointments.map((a) => a.name)).toEqual(["Kick-off"]);
    expect(org.assignments).toEqual([]);
    // The org's own module stays; the one Demo ready created is archived (published modules cannot be deleted).
    expect(org.modules.map((m) => [m.name, Boolean(m.isArchived)])).toEqual([["Coaching for Agents", false], ["Own module", true]]);
    const after = (await cleanupSection.status(c, AGENT)) as { items: Array<{ state: string }> };
    expect(after.items.every((i) => i.state === "gone" || i.state === "kept")).toBe(true);
  });

  it("also removes what an earlier version created through plans", async () => {
    const c = client(profile("none"));
    org.appointments.push({ id: "00000009-0000-4000-8000-000000000000", name: "Old 1:1", description: "x", dateStart: "2026-09-29T08:00:00Z", lengthInMinutes: 30, status: "Scheduled", attendees: [{ id: AGENT }] });
    fs.mkdirSync(path.join(home, "plans"), { recursive: true });
    fs.writeFileSync(path.join(home, "plans", "p-0000old1.json"), JSON.stringify({
      id: "p-0000old1", createdAt: "2026-09-20T10:00:00.000Z", profile: "demo-none", group: `demo ready · coaching · ${AGENT} · 2026-09-20T10:00:00Z ab12`,
      title: 'Demo ready (Coaching): create coaching appointment "Old 1:1"', request: { method: "POST", path: "/api/v2/coaching/appointments", body: { name: "Old 1:1" } },
      status: "applied", result: { body: { id: "00000009-0000-4000-8000-000000000000" } },
    }));
    expect(demoInventory("demo-none", AGENT).map((x) => x.label)).toEqual(['coaching appointment "Old 1:1"']);
    await run(c, { sections: ["coaching"] }, cleanupSection);
    expect(org.appointments).toEqual([]);
  });

  it("rejects unknown sections", () => {
    expect(() => cleanupSection.parse({ sections: ["queues"] })).toThrow(/Unknown section/);
    expect(() => cleanupSection.parse({ sections: [] })).toThrow(/at least one/);
  });
});

describe("demo ready: scorecard", () => {
  type GP = { id: string; name: string; active: boolean; members: string[]; metrics: Array<{ id: string; metricDefinitionId: string; objective: { dateStart: string } }> };
  let gs: { status: Record<string, unknown>; profiles: GP[]; calls: string[] };
  const QES = "3d7fc397-9d58-4da5-b7e6-0651f4d89a3f";
  const AHT = "0c0ef13d-e05c-580c-8319-5ba6c35a1cf2";

  function gclient(p: Profile): GenesysClient {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.hostname.startsWith("login.")) return json({ access_token: "t", expires_in: 3600 });
      const method = init.method ?? "GET";
      const path = url.pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== "GET" && !path.endsWith("/query")) gs.calls.push(`${method} ${path}`);
      let m: RegExpMatchArray | null;
      if (path === "/api/v2/gamification/status") {
        if (method === "PUT") gs.status = body;
        return json(gs.status);
      }
      if (path === "/api/v2/authorization/divisions/home") return json({ id: "div-home" });
      if (path === "/api/v2/gamification/metricdefinitions")
        return json({ entities: [{ id: QES, name: "QUALITY_EVALUATION_SCORE", defaultObjective: { templateId: "t1", zones: [{ label: "Z" }] } }, { id: AHT, name: "AVERAGE_HANDLE_TIME", defaultObjective: { templateId: "t2", zones: [] } }] });
      if (path === "/api/v2/gamification/profiles") {
        if (method === "POST") {
          // Like Genesys: the default profile's metrics are copied unless copyMetrics=false.
          const g: GP = { id: uuid(), name: body.name, active: true, members: [], metrics: url.searchParams.get("copyMetrics") === "false" ? [] : [...gs.profiles[0]!.metrics] };
          gs.profiles.push(g);
          return json({ id: g.id, name: g.name });
        }
        return json({ entities: gs.profiles.map((g) => ({ id: g.id, name: g.name, active: g.active, memberCount: g.members.length })) });
      }
      if ((m = path.match(/^\/api\/v2\/gamification\/profiles\/users\/([^/]+)\/query$/))) {
        const g = gs.profiles.find((x) => x.members.includes(m![1]!));
        return json({ profiles: g ? [{ id: g.id }] : [] });
      }
      if ((m = path.match(/^\/api\/v2\/gamification\/profiles\/([^/]+)(\/metrics|\/members|\/deactivate|\/activate)?$/))) {
        const g = gs.profiles.find((x) => x.id === m![1]);
        if (!g) return json({ message: "not found" }, 404);
        if (!m[2]) return json({ id: g.id, name: g.name, active: g.active, memberCount: g.members.length });
        if (m[2] === "/metrics") {
          if (method === "POST") g.metrics.push({ id: uuid(), metricDefinitionId: body.metricDefinitionId, objective: body.objective });
          return json({ entities: g.metrics });
        }
        if (m[2] === "/deactivate" || m[2] === "/activate") {
          g.active = m[2] === "/activate";
          return json({});
        }
        for (const u of body.membersToAssign) for (const other of gs.profiles) other.members = other.members.filter((x) => x !== u);
        g.members.push(...body.membersToAssign);
        g.members = g.members.filter((u) => !body.membersToRemove.includes(u));
        return json({ assignedMembers: body.membersToAssign.map((id: string) => ({ id })) });
      }
      return json({ message: `unexpected ${method} ${path}` }, 400);
    }) as typeof fetch;
    return new GenesysClient(p, { source: "ui", fetchImpl, tokens: new TokenProvider(p.region, () => ({ clientId: "a", clientSecret: "b" }), fetchImpl) });
  }

  beforeEach(() => {
    gs = { status: {}, profiles: [{ id: "DEFAULT", name: "DEFAULT_PROFILE_NAME", active: true, members: [], metrics: [{ id: "m0", metricDefinitionId: "punctuality", objective: { dateStart: "2024-09-03" } }] }], calls: [] };
  });

  it("switches gamification on, creates a profile with metrics from today, adds the agent; clean up undoes it", async () => {
    const c = gclient(profile("none"));
    const r = await run(c, { activate: true, profile: { name: "Demo ready performance" }, metrics: [QES, AHT] }, scorecardSection);
    expect(r).toMatchObject({ done: true });
    expect(gs.status).toMatchObject({ isActive: true, dateStart: "2026-09-26" });
    const g = gs.profiles.find((x) => x.name === "Demo ready performance")!;
    expect(g.metrics.map((x) => [x.metricDefinitionId, x.objective.dateStart])).toEqual([[QES, "2026-09-26"], [AHT, "2026-09-26"]]);
    expect(g.members).toEqual([AGENT]);
    // The org's own profile is untouched.
    expect(gs.profiles[0]!.metrics).toHaveLength(1);

    const again = await run(c, { activate: true, profile: { name: "Demo ready performance" }, metrics: [QES, AHT] }, scorecardSection);
    expect(again).toMatchObject({ done: true, applied: [] });

    const cleaned = await run(c, { sections: ["scorecard"] }, cleanupSection);
    expect(cleaned.done).toBe(true);
    expect(g.members).toEqual([]);
    expect(g.active).toBe(false);
    expect(gs.status).toMatchObject({ isActive: false });
    expect(gs.calls.slice(-3)).toEqual([`POST /api/v2/gamification/profiles/${g.id}/members`, `POST /api/v2/gamification/profiles/${g.id}/deactivate`, "PUT /api/v2/gamification/status"]);
    // A new run reuses the deactivated profile (Genesys cannot delete profiles) instead of creating another.
    const back = await run(c, { activate: true, profile: { name: "Demo ready performance" }, metrics: [QES, AHT] }, scorecardSection);
    expect(back.done).toBe(true);
    expect(gs.profiles.filter((x) => x.name === "Demo ready performance")).toHaveLength(1);
    expect(g).toMatchObject({ active: true, members: [AGENT] });
    expect(g.metrics).toHaveLength(2);
  });

  it("with an existing profile only changes the membership, and clean up moves the agent back", async () => {
    gs.status = { isActive: true, dateStart: "2026-01-01" };
    const team: GP = { id: uuid(), name: "Team A", active: true, members: [AGENT, "someone-else"], metrics: [] };
    gs.profiles.push(team);
    const c = gclient(profile("none"));
    const r = await run(c, { activate: true, profile: { id: "DEFAULT" }, metrics: [QES] }, scorecardSection);
    expect(r.notes.join(" ")).toMatch(/existing profile: its metrics are left as they are/);
    expect(gs.profiles[0]!.members).toEqual([AGENT]);
    expect(gs.profiles[0]!.metrics).toHaveLength(1);
    expect(gs.calls.filter((x) => x.startsWith("PUT"))).toEqual([]);

    await run(c, { sections: ["scorecard"] }, cleanupSection);
    expect(team.members).toContain(AGENT);
    expect(gs.profiles[0]!.members).toEqual([]);
    // Gamification was already on and the profile belongs to the org: both stay.
    expect(gs.status).toMatchObject({ isActive: true });
    expect(gs.profiles[0]!.active).toBe(true);
  });

  it("continues after a gateway timeout that still changed the org", async () => {
    const c = gclient(profile("none"));
    const base = c.request.bind(c);
    let first = true;
    c.request = (async (method: string, path: string, ...rest: unknown[]) => {
      if (first && method === "PUT" && path === "/api/v2/gamification/status") {
        first = false;
        await base(method, path, ...(rest as []));
        throw new GctkError("HTTP_504", `PUT ${path} failed [gateway.timeout]: The request timed out.`);
      }
      return base(method, path, ...(rest as []));
    }) as typeof c.request;
    const r = await run(c, { activate: true, profile: { id: "DEFAULT" }, metrics: [] }, scorecardSection);
    expect(r.done).toBe(true);
    expect(r.notes.join(" ")).toMatch(/timed out on "switch gamification on"; the state is checked again/);
    expect(gs.profiles[0]!.members).toEqual([AGENT]);
    // Clean up still knows the activation came from Demo ready.
    expect(demoInventory("demo-none", AGENT).map((x) => x.kind)).toContain("gamification");
  });
});

describe("demo ready: speech and text analytics", () => {
  const GENERAL = "5ba6a1c0-af79-4df1-98c4-dae1506d1638";
  const T1 = "fd448b67-0f1c-49df-93d7-65f44198ba25";
  const T2 = "0ec1747e-db30-45e5-9d37-a4f1b0b82a66";
  type Prog = { id: string; name: string; published: boolean; topicIds: string[] };
  let st: {
    settings: Record<string, unknown>;
    transcription: { transcription: string; transcriptionConfidenceThreshold: number };
    queues: Array<{ id: string; name: string; enableTranscription?: boolean }>;
    members: Record<string, string[]>;
    programs: Prog[];
    topics: Array<{ id: string; name: string; dialect: string; published: boolean; phrases: Array<{ text: string }> }>;
    mappings: Record<string, string[]>;
    lag: Set<string>;
    calls: string[];
  };
  const Q = "33333333-3333-4333-8333-333333333333";

  function sclient(p: Profile): GenesysClient {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const page = (entities: unknown[]) => json({ entities, pageSize: 100, pageNumber: 1, pageCount: 1 });
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.hostname.startsWith("login.")) return json({ access_token: "t", expires_in: 3600 });
      const method = init.method ?? "GET";
      const path = url.pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== "GET") st.calls.push(`${method} ${path}`);
      let m: RegExpMatchArray | null;
      if (path === "/api/v2/speechandtextanalytics/settings") {
        if (method === "PATCH") Object.assign(st.settings, body);
        return json(st.settings);
      }
      if (path === "/api/v2/routing/settings/transcription") {
        if (method === "PATCH") Object.assign(st.transcription, body);
        return json(st.transcription);
      }
      if ((m = path.match(/^\/api\/v2\/routing\/queues\/([^/]+)$/))) {
        const q = st.queues.find((x) => x.id === m![1]);
        if (!q) return json({ message: "not found" }, 404);
        if (method === "PUT") Object.assign(q, body);
        return json(q);
      }
      if ((m = path.match(/^\/api\/v2\/routing\/queues\/([^/]+)\/members(?:\/([^/]+))?$/))) {
        if (method === "POST") (st.members[m[1]!] ??= []).push(...body.map((b: { id: string }) => b.id));
        else st.members[m[1]!] = (st.members[m[1]!] ?? []).filter((u) => u !== m![2]);
        return json({});
      }
      if ((m = path.match(/^\/api\/v2\/users\/([^/]+)\/queues$/))) return page(st.queues.filter((q) => st.members[q.id]?.includes(m![1]!)));
      if (path === "/api/v2/speechandtextanalytics/programs/mappings")
        return page(st.programs.map((pr) => ({ program: { id: pr.id }, queues: (st.mappings[pr.id] ?? []).map((id) => ({ id })), flows: [] })));
      if (path === "/api/v2/speechandtextanalytics/topics") {
        if (method === "POST") {
          const t = { id: uuid(), name: body.name, dialect: body.dialect, published: false, phrases: body.phrases };
          st.topics.push(t);
          return json(t);
        }
        return page(st.topics);
      }
      if (path === "/api/v2/speechandtextanalytics/topics/publishjobs") {
        for (const id of body.topicIds) st.topics.find((x) => x.id === id)!.published = true;
        return json({ id: "job", state: "Completed" });
      }
      if ((m = path.match(/^\/api\/v2\/speechandtextanalytics\/topics\/([^/]+)$/))) {
        const t = st.topics.find((x) => x.id === m![1]);
        if (!t) return json({ message: "not found" }, 404);
        if (method === "DELETE") {
          // Like Genesys: the topic leaves every program, which stay published.
          st.topics = st.topics.filter((x) => x !== t);
          for (const pr of st.programs) pr.topicIds = pr.topicIds.filter((id) => id !== t.id);
          return new Response(null, { status: 204 });
        }
        return json(t);
      }
      if (path === "/api/v2/speechandtextanalytics/programs/publishjobs") {
        for (const id of body.programIds) st.programs.find((x) => x.id === id)!.published = true;
        return json({ id: "job" });
      }
      if (path === "/api/v2/speechandtextanalytics/programs") {
        if (method === "POST") {
          const pr: Prog = { id: uuid(), name: body.name, published: false, topicIds: body.topicIds };
          st.programs.push(pr);
          st.lag.add(pr.id);
          return json(pr);
        }
        return page(st.programs.filter((x) => !st.lag.has(x.id)));
      }
      if ((m = path.match(/^\/api\/v2\/speechandtextanalytics\/programs\/([^/]+)(\/mappings)?$/))) {
        const pr = st.programs.find((x) => x.id === m![1]);
        if (!pr) return json({ message: "not found" }, 404);
        if (method === "DELETE") {
          st.programs = st.programs.filter((x) => x !== pr);
          delete st.mappings[pr.id];
          return new Response(null, { status: 204 });
        }
        if (!m[2] && method === "PUT") {
          // Like Genesys: the program and its newly linked topics become unpublished.
          for (const t of st.topics) if (body.topicIds.includes(t.id) && !pr.topicIds.includes(t.id)) t.published = false;
          pr.topicIds = body.topicIds;
          pr.published = false;
          return json(pr);
        }
        if (m[2] && method === "PUT") {
          for (const q of body.queueIds as string[]) {
            const other = Object.entries(st.mappings).find(([pid, qs]) => pid !== pr.id && qs.includes(q));
            if (other) return json({ code: "conflict", message: `queue with id ${q} is already mapped to another program ${other[0]}` }, 409);
          }
          st.mappings[pr.id] = body.queueIds;
        }
        return m[2] ? json({ queues: (st.mappings[pr.id] ?? []).map((id) => ({ id })), flows: [] }) : json({ ...pr, topics: pr.topicIds.map((id) => ({ id })) });
      }
      return json({ message: `unexpected ${method} ${path}` }, 400);
    }) as typeof fetch;
    return new GenesysClient(p, { source: "ui", fetchImpl, tokens: new TokenProvider(p.region, () => ({ clientId: "a", clientSecret: "b" }), fetchImpl) });
  }

  beforeEach(() => {
    st = {
      settings: { textAnalyticsEnabled: true, sentimentAnalysisEnabled: false, agentEmpathyEnabled: false, expectedDialects: [], defaultProgram: { id: GENERAL } },
      transcription: { transcription: "Disabled", transcriptionConfidenceThreshold: 60 },
      queues: [{ id: Q, name: "Service" }],
      members: {},
      programs: [{ id: GENERAL, name: "General", published: true, topicIds: [T1] }],
      topics: [],
      mappings: { [GENERAL]: [Q] },
      lag: new Set(),
      calls: [],
    };
  });

  const input = { queueId: Q, addAgent: true, analytics: true, dialect: "en-GB", transcription: true, program: { name: "Demo ready analytics", topicIds: [T1, T2] }, newTopics: [] as unknown[] };
  const parcel = { name: "Parcel not delivered", dialect: "en-GB", strictness: "72", description: "", phrases: ["where is my parcel", "  ", "parcel has not arrived", "where is my parcel"] };

  it("validates the page's input", () => {
    const parse = (i: unknown) => staSection.parse(i);
    expect(() => parse({ ...input, queueId: "../x" })).toThrow(/queue must be an id/);
    expect(() => parse({ ...input, dialect: "english" })).toThrow(/not a dialect/);
    expect(() => parse({ ...input, program: { name: "" } })).toThrow(/Program name is required/);
    expect(parse({ ...input, program: { id: GENERAL } }).program).toEqual({ id: GENERAL });
    expect(parse({ ...input, newTopics: [parcel] }).newTopics[0]).toMatchObject({ phrases: ["where is my parcel", "parcel has not arrived"], strictness: "72" });
    expect(() => parse({ ...input, newTopics: [{ ...parcel, phrases: [" "] }] })).toThrow(/at least one phrase/);
    expect(() => parse({ ...input, newTopics: [{ ...parcel, strictness: "50" }] })).toThrow(/strictness must be one of/);
    expect(() => parse({ ...input, newTopics: [{ ...parcel, dialect: "gb" }] })).toThrow(/not a dialect/);
    expect(() => parse({ ...input, newTopics: [parcel, parcel] })).toThrow(/twice/);
  });

  it("sets up analytics, transcription, a new program and moves the queue into it; clean up restores everything", async () => {
    const c = sclient(profile("none"));
    const r = await run(c, input, staSection);
    expect(r).toMatchObject({ done: true });
    expect(r.applied.every((a) => a.status === "applied")).toBe(true);
    expect(st.settings).toMatchObject({ sentimentAnalysisEnabled: true, agentEmpathyEnabled: true, expectedDialects: ["en-GB"] });
    expect(st.transcription.transcription).toBe("EnabledQueueFlow");
    expect(st.queues[0]!.enableTranscription).toBe(true);
    expect(st.members[Q]).toEqual([AGENT]);
    // One program, found again although the name search lagged behind the create.
    const demo = st.programs.filter((x) => x.name === "Demo ready analytics");
    expect(demo).toHaveLength(1);
    expect(demo[0]).toMatchObject({ published: true, topicIds: [T1, T2] });
    // A queue belongs to one program: out of General first, then into the new one.
    expect(st.mappings).toEqual({ [GENERAL]: [], [demo[0]!.id]: [Q] });

    const again = await run(c, input, staSection);
    expect(again).toMatchObject({ done: true, applied: [] });

    const cleaned = await run(c, { sections: ["sta"] }, cleanupSection);
    expect(cleaned.done).toBe(true);
    expect(st.programs.map((x) => x.name)).toEqual(["General"]);
    expect(st.mappings).toEqual({ [GENERAL]: [Q] });
    expect(st.settings).toMatchObject({ textAnalyticsEnabled: true, sentimentAnalysisEnabled: false, agentEmpathyEnabled: false, expectedDialects: [] });
    expect(st.transcription.transcription).toBe("Disabled");
    expect(st.queues[0]!.enableTranscription).toBe(false);
    expect(st.members[Q]).toEqual([]);
    const after = (await cleanupSection.status(c, AGENT)) as { items: Array<{ state: string }> };
    expect(after.items.every((i) => i.state === "gone")).toBe(true);
  });

  it("with an existing program only adds the queue, and leaves settings that were on alone", async () => {
    st.mappings = { [GENERAL]: [] };
    st.settings = { textAnalyticsEnabled: true, sentimentAnalysisEnabled: true, agentEmpathyEnabled: true, expectedDialects: ["en-US"] };
    st.transcription.transcription = "EnabledGlobally";
    const c = sclient(profile("none"));
    await run(c, { ...input, dialect: "", addAgent: false, program: { id: GENERAL } }, staSection);
    expect(st.calls.filter((x) => x.includes("settings"))).toEqual([]);
    expect(st.mappings[GENERAL]).toEqual([Q]);
    expect(st.programs).toHaveLength(1);
    await run(c, { sections: ["sta"] }, cleanupSection);
    expect(st.mappings[GENERAL]).toEqual([]);
    expect(st.programs).toHaveLength(1);
  });

  it("creates and publishes own topics before the new program, which gets them with the chosen ones", async () => {
    const c = sclient(profile("none"));
    const r = await run(c, { ...input, newTopics: [parcel] }, staSection);
    expect(r).toMatchObject({ done: true });
    const topic = st.topics.find((t) => t.name === "Parcel not delivered")!;
    expect(topic).toMatchObject({ published: true, dialect: "en-GB", phrases: [{ text: "where is my parcel" }, { text: "parcel has not arrived" }] });
    const demo = st.programs.find((x) => x.name === "Demo ready analytics")!;
    expect(demo).toMatchObject({ published: true, topicIds: [T1, T2, topic.id] });
    const order = st.calls.filter((x) => /topics|programs$|programs\/publishjobs/.test(x));
    expect(order).toEqual(["POST /api/v2/speechandtextanalytics/topics", "POST /api/v2/speechandtextanalytics/programs", "POST /api/v2/speechandtextanalytics/topics/publishjobs", "POST /api/v2/speechandtextanalytics/programs/publishjobs"]);

    await run(c, { sections: ["sta"] }, cleanupSection);
    expect(st.topics).toEqual([]);
    expect(st.programs.map((x) => x.name)).toEqual(["General"]);
  });

  it("adds own topics to an existing program and publishes it again; clean up takes them out by deleting them", async () => {
    st.mappings = { [GENERAL]: [Q] };
    const c = sclient(profile("none"));
    const r = await run(c, { ...input, program: { id: GENERAL }, newTopics: [parcel] }, staSection);
    expect(r.done).toBe(true);
    const topic = st.topics[0]!;
    expect(st.programs[0]).toMatchObject({ published: true, topicIds: [T1, topic.id] });
    await run(c, { sections: ["sta"] }, cleanupSection);
    expect(st.programs[0]).toMatchObject({ published: true, topicIds: [T1] });
    expect(st.topics).toEqual([]);
  });

});

describe("demo ready: evaluations", () => {
  const EVALUATOR = "44444444-4444-4444-8444-444444444444";
  const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
  const C2 = "c2c2c2c2-0000-4000-8000-000000000002";
  type Form = { id: string; name: string; published: boolean; questionGroups: Array<{ id: string; questions: Array<{ id: string; type: string; answerOptions: Array<{ id: string; value: number }> }> }> };
  type Ev = { id: string; conversation: { id: string }; evaluationForm: { id: string }; agent: { id: string }; evaluator: { id: string }; releaseDate?: string; answers: { questionGroupScores: unknown[]; totalScore: number } };
  let q: { forms: Form[]; evals: Ev[]; lag: Set<string>; calls: string[] };

  function qclient(p: Profile): GenesysClient {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const page = (entities: unknown[]) => json({ entities, pageSize: 100, pageNumber: 1, pageCount: 1 });
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.hostname.startsWith("login.")) return json({ access_token: "t", expires_in: 3600 });
      const method = init.method ?? "GET";
      const path = url.pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== "GET" && !path.endsWith("/search")) q.calls.push(`${method} ${path}`);
      let m: RegExpMatchArray | null;
      if (path === "/api/v2/quality/forms/evaluations") {
        if (method === "POST") {
          let n = 0;
          const f: Form = { id: uuid(), name: body.name, published: false, questionGroups: body.questionGroups.map((g: { questions: unknown[] }) => ({ id: uuid(), questions: g.questions.map(() => ({ id: `q${n++}`, type: "multipleChoiceQuestion", answerOptions: [{ id: `no${n}`, value: 0 }, { id: `yes${n}`, value: 1 }] })) })) };
          q.forms.push(f);
          q.lag.add(f.id);
          return json(f);
        }
        return page(q.forms.filter((f) => !q.lag.has(f.id)));
      }
      if (path === "/api/v2/quality/publishedforms/evaluations") {
        if (method === "POST") {
          q.forms.find((f) => f.id === body.id)!.published = true;
          return json({ id: body.id });
        }
        return page(q.forms.filter((f) => f.published));
      }
      if ((m = path.match(/^\/api\/v2\/quality\/(publishedforms|forms)\/evaluations\/([^/]+)$/))) {
        const f = q.forms.find((x) => x.id === m![2] && (m![1] === "forms" || x.published));
        if (!f) return json({ message: "not found" }, 404);
        if (method === "DELETE") {
          if (f.published) return json({ code: "evaluation.cannot.be.deleted" }, 409);
          q.forms = q.forms.filter((x) => x !== f);
          return new Response(null, { status: 204 });
        }
        return json(f);
      }
      if (path === "/api/v2/quality/evaluations/search") {
        const agent = body.query.find((x: { field: string }) => x.field === "agentId").value;
        return json({ results: q.evals.filter((e) => e.agent.id === agent) });
      }
      if ((m = path.match(/^\/api\/v2\/quality\/conversations\/([^/]+)\/evaluations(?:\/([^/]+))?$/))) {
        if (method === "POST") {
          const scores = body.answers.questionGroupScores.flatMap((g: { questionScores: Array<{ answerId: string }> }) => g.questionScores);
          const e: Ev = { id: uuid(), conversation: { id: m[1]! }, evaluationForm: body.evaluationForm, agent: body.agent, evaluator: body.evaluator, releaseDate: body.releaseDate, answers: { ...body.answers, totalScore: (100 * scores.filter((x: { answerId: string }) => x.answerId.startsWith("yes")).length) / scores.length } };
          q.evals.push(e);
          return json(e);
        }
        const e = q.evals.find((x) => x.id === m![2]);
        if (!e) return json({ message: "not found" }, 404);
        if (method === "DELETE") {
          q.evals = q.evals.filter((x) => x !== e);
          return new Response(null, { status: 204 });
        }
        return json(e);
      }
      return json({ message: `unexpected ${method} ${path}` }, 400);
    }) as typeof fetch;
    return new GenesysClient(p, { source: "ui", fetchImpl, tokens: new TokenProvider(p.region, () => ({ clientId: "a", clientSecret: "b" }), fetchImpl) });
  }

  beforeEach(() => {
    q = { forms: [], evals: [], lag: new Set(), calls: [] };
  });

  const input = { form: { name: "Customer service quality check" }, evaluatorId: EVALUATOR, evaluations: [{ conversationId: C1, result: "strong" }, { conversationId: C2, result: "weak", comment: "Let's talk." }] };

  it("validates the page's input", () => {
    const parse = (i: unknown) => evaluationsSection.parse(i);
    expect(() => parse({ ...input, evaluations: [] })).toThrow(/at least one conversation/);
    expect(() => parse({ ...input, evaluatorId: "x" })).toThrow(/evaluator must be an id/);
    expect(() => parse({ ...input, evaluations: [{ conversationId: C1, result: "great" }] })).toThrow(/strong, mixed or weak/);
    expect(() => parse({ ...input, evaluations: [input.evaluations[0], input.evaluations[0]] })).toThrow(/twice/);
    // Without a comment, the one that fits the result.
    expect(parse(input).evaluations[0]!.comment).toMatch(/Excellent/);
  });

  it("picks answers by result: strong the best, mixed the best except every third, weak the best only every third", () => {
    const qn = (id: string) => ({ id, type: "multipleChoiceQuestion", answerOptions: [{ id: `${id}-no`, value: 0 }, { id: `${id}-yes`, value: 1 }] });
    const form = { id: "f", name: "F", questionGroups: [{ id: "g", questions: [qn("a"), qn("b"), qn("c"), { id: "t", type: "freeTextQuestion", naEnabled: true }, { id: "u", type: "freeTextQuestion" }] }] };
    const ids = (r: "strong" | "mixed" | "weak") => (evaluationAnswers(form, r, "").questionGroupScores[0]!.questionScores as Array<{ answerId?: string; markedNA?: boolean }>).map((x) => x.answerId ?? (x.markedNA ? "NA" : "?"));
    expect(ids("strong")).toEqual(["a-yes", "b-yes", "c-yes", "NA"]);
    expect(ids("weak")).toEqual(["a-yes", "b-no", "c-no", "NA"]);
    expect(ids("mixed")).toEqual(["a-yes", "b-yes", "c-no", "NA"]);
    expect(pickAnswer({ id: "x", type: "npsQuestion" }, 0, "strong")).toBeUndefined();
  });

  it("creates and publishes the template form, evaluates each conversation once and releases it; clean up deletes the evaluations", async () => {
    const c = qclient(profile("none"));
    const r = await run(c, input, evaluationsSection);
    expect(r).toMatchObject({ done: true });
    expect(q.forms).toHaveLength(1);
    expect(q.forms[0]).toMatchObject({ name: "Customer service quality check", published: true });
    expect(q.evals.map((e) => [e.conversation.id, Math.round(e.answers.totalScore), e.releaseDate])).toEqual([[C1, 100, "2026-09-26T12:00:00.000Z"], [C2, 43, "2026-09-26T12:00:00.000Z"]]);
    expect(q.evals[1]!.evaluator.id).toBe(EVALUATOR);

    const again = await run(c, input, evaluationsSection);
    expect(again.applied).toEqual([]);
    expect(again.notes.join(" ")).toMatch(/already has an evaluation/);
    expect(q.evals).toHaveLength(2);

    const status = (await cleanupSection.status(c, AGENT)) as { items: Array<{ label: string; state: string; reason?: string }> };
    expect(status.items.find((i) => i.label.startsWith("evaluation form"))).toMatchObject({ state: "kept", reason: expect.stringMatching(/published/) });
    await run(c, { sections: ["evaluations"] }, cleanupSection);
    expect(q.evals).toEqual([]);
    expect(q.forms).toHaveLength(1);
  });

  it("uses an existing published form and refuses the agent as evaluator", async () => {
    q.forms.push({ id: "55555555-5555-4555-8555-555555555555", name: "Org form", published: true, questionGroups: [{ id: "g", questions: [{ id: "q", type: "multipleChoiceQuestion", answerOptions: [{ id: "yes", value: 1 }] }] }] });
    const c = qclient(profile("none"));
    const self = await run(c, { ...input, form: { id: q.forms[0]!.id }, evaluatorId: AGENT }, evaluationsSection);
    expect(self.notes.join(" ")).toMatch(/cannot evaluate their own/);
    const r = await run(c, { ...input, form: { id: q.forms[0]!.id } }, evaluationsSection);
    expect(r.done).toBe(true);
    expect(q.calls.filter((x) => x.includes("forms"))).toEqual([]);
    expect(q.evals.map((e) => e.evaluationForm.id)).toEqual([q.forms[0]!.id, q.forms[0]!.id]);
  });
});

describe("demo ready: refresh dates", () => {
  const LATER = new Date("2026-10-17T12:00:00Z");
  const runAt = (c: GenesysClient, input: unknown, now: Date, section: DemoSection<any> = refreshSection) =>
    runDemoSection(section, input, { client: c, userId: AGENT, agentName: "Alex", now });

  it("counts whole weeks to the future and keeps dates that are ahead", () => {
    expect(weeksToFuture("2026-09-28T08:30:00Z", LATER)).toBe(3);
    expect(weeksToFuture("2026-10-17T12:30:00Z", LATER)).toBe(1);
    expect(weeksToFuture("2026-10-20T08:30:00Z", LATER)).toBe(0);
    expect(() => refreshSection.parse({ coaching: false, learning: false, schedule: false })).toThrow(/at least one/);
  });

  it("moves the page's overdue appointments and due dates forward by whole weeks, and nothing else", async () => {
    const c = client(profile("none"));
    await runAt(c, input, NOW, coachingSection);
    const mod: Mod = { id: "11111111-1111-4111-8111-111111111111", name: "Onboarding", isPublished: true };
    org.modules.push(mod);
    await runAt(c, { assignments: [{ moduleId: mod.id, dueDate: "2026-10-01T15:00:00Z" }] }, NOW, learningSection);
    // Someone else's appointment in the past stays where it is.
    org.appointments.push({ id: "99999999-9999-4999-8999-999999999999", name: "Team meeting", description: "", dateStart: "2026-09-29T09:00:00Z", lengthInMinutes: 30, status: "Scheduled", attendees: [{ id: AGENT }] });

    const st = (await refreshSection.status(c, AGENT, LATER)) as { appointments: unknown[]; assignments: unknown[]; stale: number; schedule: { state: string } };
    expect(st).toMatchObject({ stale: 2, schedule: { state: "none" } });

    const r = await runAt(c, {}, LATER);
    expect(r).toMatchObject({ done: true });
    expect(r.applied.map((a) => a.title)).toEqual([
      'Demo ready (Refresh dates for Alex): move coaching appointment "Weekly 1:1" forward by 3 weeks',
      'Demo ready (Refresh dates for Alex): move the due date of "Onboarding" forward by 3 weeks',
    ]);
    expect(Object.fromEntries(org.appointments.map((a) => [a.name, a.dateStart]))).toEqual({
      "Kick-off": "2026-09-28T07:00:00Z", // completed: stays in the past
      "Weekly 1:1": "2026-10-19T08:30:00Z",
      "Team meeting": "2026-09-29T09:00:00Z",
    });
    expect(org.assignments[0]!.dateRecommendedForCompletion).toBe("2026-10-22T15:00:00Z");

    const again = await runAt(c, {}, LATER);
    expect(again).toMatchObject({ done: true, applied: [] });
    // Moved objects are still the page's own: Clean up removes them as before.
    const cleaned = await runAt(c, { sections: ["coaching", "learning"] }, LATER, cleanupSection);
    expect(cleaned.done).toBe(true);
    expect(org.appointments.map((a) => a.name).sort()).toEqual(["Kick-off", "Team meeting"]);
    expect(org.assignments).toEqual([]);
  });

});

describe("demo ready: schedule", () => {
  const W = "/api/v2/workforcemanagement";
  const codes = { onQueue: "oq", break: "br", meal: "ml", training: "tr" };
  type Sched = { id: string; weekDate: string; weekCount: number; description: string; published: boolean; agentSchedules: Array<{ userId: string; shifts: unknown[] }> };
  let w: { bus: Array<{ id: string; name: string }>; mus: Array<{ id: string; name: string; bu: string }>; agentMu: string | null; pendingMove?: string | null; lookups: number; schedules: Record<string, Sched[]>; uploads: Record<string, unknown>; lastUpload?: unknown; calls: string[] };

  function wclient(p: Profile): GenesysClient {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.hostname.startsWith("login.")) return json({ access_token: "t", expires_in: 3600 });
      const method = init.method ?? "GET";
      const path = url.pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== "GET" && !path.endsWith("/query")) w.calls.push(`${method} ${path.replace(W, "")}`);
      let m: RegExpMatchArray | null;
      if (path === "/api/v2/authorization/divisions/home") return json({ id: "div" });
      if (path === `${W}/businessunits`) {
        if (method === "POST") {
          const b = { id: uuid(), name: body.name };
          w.bus.push(b);
          return json(b);
        }
        return json({ entities: w.bus });
      }
      if ((m = path.match(/^\/api\/v2\/workforcemanagement\/businessunits\/([^/]+)$/))) {
        const b = w.bus.find((x) => x.id === m![1]);
        if (!b) return json({}, 404);
        if (method === "DELETE") {
          if (w.mus.some((x) => x.bu === b.id)) return json({ message: "has management units" }, 400);
          w.bus = w.bus.filter((x) => x !== b);
          return new Response(null, { status: 204 });
        }
        return json({ ...b, division: { id: "div" }, settings: { startDayOfWeek: "Monday", timeZone: "Europe/London" } });
      }
      if ((m = path.match(/^\/api\/v2\/workforcemanagement\/businessunits\/([^/]+)\/managementunits$/))) return json({ entities: w.mus.filter((x) => x.bu === m![1]) });
      if ((m = path.match(/^\/api\/v2\/workforcemanagement\/businessunits\/([^/]+)\/activitycodes$/)))
        return json({ entities: { oq: { category: "OnQueueWork", default: true }, br: { category: "Break", default: true }, ml: { category: "Meal", default: true }, tr: { category: "Training", default: true } } });
      if (path === `${W}/managementunits` && method === "POST") {
        const mu = { id: uuid(), name: body.name, bu: body.businessUnitId };
        w.mus.push(mu);
        return json(mu);
      }
      if ((m = path.match(/^\/api\/v2\/workforcemanagement\/managementunits\/([^/]+)(?:\/agents\/([^/]+))?$/))) {
        const mu = w.mus.find((x) => x.id === m![1]);
        if (!mu) return json({}, 404);
        if (m[2]) return w.agentMu === mu.id ? json({ user: { id: m[2] } }) : json({}, 404);
        if (method === "DELETE") {
          w.mus = w.mus.filter((x) => x !== mu);
          return new Response(null, { status: 204 });
        }
        return json({ id: mu.id, name: mu.name, businessUnit: { id: mu.bu } });
      }
      if ((m = path.match(/^\/api\/v2\/workforcemanagement\/agents\/([^/]+)\/managementunit$/))) {
        if (w.pendingMove !== undefined && w.lookups++ > 0) {
          w.agentMu = w.pendingMove;
          w.pendingMove = undefined;
          w.lookups = 0;
        }
        const mu = w.mus.find((x) => x.id === w.agentMu);
        return mu ? json({ managementUnit: { id: mu.id }, businessUnit: { id: mu.bu } }) : json({ code: "missing.any.permissions" }, 403);
      }
      if (path === `${W}/agents`) {
        // Like Genesys: the move shows up a moment later (after the next lookup).
        w.pendingMove = body.destinationManagementUnitId ?? null;
        return json({});
      }
      if ((m = path.match(/^\/api\/v2\/workforcemanagement\/businessunits\/([^/]+)\/weeks\/([^/]+)\/schedules(?:\/(import\/uploadurl|import)|\/([^/]+))?$/))) {
        const key = `${m[1]}:${m[2]}`;
        if (m[3] === "import/uploadurl") return json({ uploadKey: `key-${key}`, url: "https://bucket.s3.eu-west-2.amazonaws.com/upload", headers: { "Content-Encoding": "gzip" } });
        if (m[3] === "import") {
          const doc = (w.uploads[body.uploadKey] ?? w.lastUpload) as Omit<Sched, "id" | "weekDate">;
          (w.schedules[key] ??= []).push({ id: uuid(), weekDate: m[2]!, ...doc });
          return json({ status: "Processing", operationId: "op" });
        }
        if (m[4] && method === "DELETE") {
          w.schedules[key] = (w.schedules[key] ?? []).filter((x) => x.id !== m![4]);
          return new Response(null, { status: 204 });
        }
        return json({ entities: (w.schedules[key] ?? []).map(({ agentSchedules: _, ...x }) => x) });
      }
      return json({ message: `unexpected ${method} ${path}` }, 400);
    }) as typeof fetch;
    return new GenesysClient(p, { source: "ui", fetchImpl, tokens: new TokenProvider(p.region, () => ({ clientId: "a", clientSecret: "b" }), fetchImpl) });
  }
  /** Stands in for the presigned S3 upload: remembers the gunzipped document by upload key. */
  const s3 = (async (_u: string | URL | Request, init: RequestInit = {}) => {
    const doc = JSON.parse(zlib.gunzipSync(init.body as Buffer).toString("utf8"));
    for (const b of w.bus) w.uploads[`key-${b.id}:2026-09-21`] = doc;
    w.lastUpload = doc;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  const runW = (c: GenesysClient, input: unknown, section: DemoSection<any> = scheduleSection, now = NOW) =>
    runDemoSection(section, input, { client: c, userId: AGENT, agentName: "Alex", now, uploadFetch: s3 });

  beforeEach(() => {
    w = { bus: [], mus: [], agentMu: null, lookups: 0, schedules: {}, uploads: {}, calls: [] };
  });

  const input = { businessUnit: { name: "Demo ready WFM", timeZone: "Europe/London" }, managementUnit: { name: "Demo ready agents" }, weeks: 2, pattern: { start: "09:00", lengthMinutes: 480, days: [1, 2, 3, 4, 5], training: true } };

  it("computes times in the business unit's time zone", () => {
    expect(zonedTime("2026-09-28", "09:00", "Europe/London").toISOString()).toBe("2026-09-28T08:00:00.000Z");
    expect(zonedTime("2026-12-07", "09:00", "Europe/London").toISOString()).toBe("2026-12-07T09:00:00.000Z");
    expect(zonedTime("2026-09-28", "09:00", "America/New_York").toISOString()).toBe("2026-09-28T13:00:00.000Z");
    expect(weekStart(NOW, "Europe/London", "Monday")).toBe("2026-09-21");
    expect(weekStart(NOW, "Europe/London", "Sunday")).toBe("2026-09-20");
  });

  it("builds shifts with breaks, lunch and a training hour on Wednesdays, without gaps", () => {
    const shifts = buildShifts("2026-09-21", 1, input.pattern, "Europe/London", codes);
    expect(shifts).toHaveLength(5);
    for (const sh of shifts) {
      const acts = sh.activities;
      expect(acts.reduce((n, a) => n + a.lengthMinutes, 0)).toBe(480);
      for (let i = 1; i < acts.length; i++) expect(Date.parse(acts[i]!.startDate)).toBe(Date.parse(acts[i - 1]!.startDate) + acts[i - 1]!.lengthMinutes * 60_000);
      expect(acts.filter((a) => a.description === "Break")).toHaveLength(2);
      expect(acts.filter((a) => a.description === "Lunch")).toHaveLength(1);
    }
    expect(shifts[0]!.startDate).toBe("2026-09-21T08:00:00Z");
    expect(shifts.map((sh) => sh.activities.some((a) => a.description === "Training"))).toEqual([false, false, true, false, false]);
  });

  it("validates the page's input", () => {
    const parse = (i: unknown) => scheduleSection.parse(i);
    expect(() => parse({ ...input, businessUnit: { name: "X", timeZone: "Mars/Olympus" } })).toThrow(/not a time zone/);
    expect(() => parse({ ...input, weeks: 6 })).toThrow(/1 to 4/);
    expect(() => parse({ ...input, pattern: { ...input.pattern, lengthMinutes: 470 } })).toThrow(/steps of 15/);
    expect(() => parse({ ...input, pattern: { ...input.pattern, start: "9am" } })).toThrow(/like 09:00/);
    expect(() => parse({ ...input, pattern: { ...input.pattern, days: [] } })).toThrow(/working days/);
  });

  it("creates BU and MU, moves the agent, uploads and imports a published schedule; clean up removes all of it", async () => {
    const c = wclient(profile("none"));
    let r = await runW(c, input);
    // The agent's move shows up a moment later: the run stops once, Continue finishes it.
    expect(r.busy).toBe(true);
    r = await runW(c, input);
    expect(r).toMatchObject({ done: true });
    expect(w.calls).toEqual([
      "POST /businessunits",
      "POST /managementunits",
      "POST /agents",
      `POST /businessunits/${w.bus[0]!.id}/weeks/2026-09-21/schedules/import/uploadurl`,
      `POST /businessunits/${w.bus[0]!.id}/weeks/2026-09-21/schedules/import`,
    ]);
    const sched = w.schedules[`${w.bus[0]!.id}:2026-09-21`]![0]!;
    expect(sched).toMatchObject({ description: "Demo ready schedule", published: true, weekCount: 2 });
    expect(sched.agentSchedules[0]).toMatchObject({ userId: AGENT });
    expect(sched.agentSchedules[0]!.shifts).toHaveLength(10);
    expect(w.agentMu).toBe(w.mus[0]!.id);

    const again = await runW(c, input);
    expect(again).toMatchObject({ done: true, applied: [] });

    let cleaned = await runW(c, { sections: ["schedule"] }, cleanupSection);
    // The move out is waited for (Continue), not repeated.
    for (let i = 0; i < 3 && !cleaned.done; i++) cleaned = await runW(c, { sections: ["schedule"] }, cleanupSection);
    expect(cleaned.done).toBe(true);
    expect(w.calls.filter((x) => x === "POST /agents")).toHaveLength(2);
    expect(w.schedules[`${w.bus.length ? w.bus[0]!.id : ""}:2026-09-21`] ?? []).toEqual([]);
    expect(w.agentMu).toBeNull();
    expect(w.mus).toEqual([]);
    expect(w.bus).toEqual([]);
  });

  it("leaves an existing business unit with a schedule for the week alone", async () => {
    w.bus.push({ id: "66666666-6666-4666-8666-666666666666", name: "Ops" });
    w.mus.push({ id: "77777777-7777-4777-8777-777777777777", name: "Team", bu: "66666666-6666-4666-8666-666666666666" });
    w.schedules["66666666-6666-4666-8666-666666666666:2026-09-21"] = [{ id: "s", weekDate: "2026-09-21", weekCount: 1, description: "Real schedule", published: true, agentSchedules: [] }];
    const c = wclient(profile("none"));
    const existing = { ...input, businessUnit: { id: "66666666-6666-4666-8666-666666666666" }, managementUnit: { id: "77777777-7777-4777-8777-777777777777" } };
    let r = await runW(c, existing);
    if (r.busy) r = await runW(c, existing);
    expect(r.notes.join(" ")).toMatch(/has a schedule for the week of 2026-09-21 already/);
    expect(w.calls.filter((x) => x.includes("schedules"))).toEqual([]);
    // Clean up puts the agent back out of the org's management unit and deletes nothing of the org.
    for (let i = 0; i < 3 && w.agentMu; i++) await runW(c, { sections: ["schedule"] }, cleanupSection);
    expect(w.agentMu).toBeNull();
    expect(w.mus).toHaveLength(1);
    expect(w.bus).toHaveLength(1);
  });

  it("refresh publishes a new schedule once the old one has run out, and clean up removes both", async () => {
    const c = wclient(profile("none"));
    let r = await runW(c, input);
    if (r.busy) r = await runW(c, input);
    const bu = w.bus[0]!.id;
    const inTwoWeeks = new Date("2026-10-01T12:00:00Z");
    expect(((await refreshSection.status(c, AGENT, inTwoWeeks)) as { schedule: { state: string } }).schedule.state).toBe("current");

    const later = new Date("2026-10-14T12:00:00Z");
    expect(((await refreshSection.status(c, AGENT, later)) as { schedule: { state: string; week: string } }).schedule).toMatchObject({ state: "stale", week: "2026-10-12" });
    const refreshed = await runW(c, { coaching: false, learning: false }, refreshSection, later);
    expect(refreshed).toMatchObject({ done: true });
    expect(w.calls.slice(-2)).toEqual([`POST /businessunits/${bu}/weeks/2026-10-12/schedules/import/uploadurl`, `POST /businessunits/${bu}/weeks/2026-10-12/schedules/import`]);
    expect(w.schedules[`${bu}:2026-10-12`]![0]).toMatchObject({ description: "Demo ready schedule", weekCount: 2 });
    expect(((await refreshSection.status(c, AGENT, later)) as { schedule: { state: string } }).schedule.state).toBe("current");

    expect(demoInventory("demo-none", AGENT).filter((x) => x.kind === "wfm-schedule").map((x) => [x.section, x.id])).toEqual([
      ["schedule", `${bu}:2026-09-21`],
      ["schedule", `${bu}:2026-10-12`],
    ]);
  });
});
