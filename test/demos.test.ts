import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenesysClient } from "../src/core/client.js";
import { fillTemplate } from "../src/core/demo-local.js";
import { applyParameters, demoPermissions, loadStory, removeFlowActions, commandStatus, deployDemo, joinDemo, leaveDemo, listDemos, loadManifest, orgDemoStatus, parameterValues, registerDeployment, removeDemo, setSnapshotSource, snapshotSource, startCommand, stopCommand, takeSnapshot } from "../src/core/demos.js";
import { saveProfile } from "../src/core/profiles.js";

type Obj = Record<string, any>;
let tmp: string;
const saved = { ...process.env };

const NOT_MINE = Symbol("not the registry");
/** The org's "gctk demos" data table as Genesys answers it: a second row with the same key is refused. */
function fakeRegistry() {
  const tables: Obj[] = [];
  const rows = new Map<string, Obj>();
  const fail = (code: string, msg: string) => Object.assign(new Error(msg), { code });
  const handle = (method: string, p: string, q: Obj, body: any): any => {
    if (p === "/api/v2/flows/datatables") {
      if (method === "GET") return { entities: tables.filter((t) => !q.name || t.name === q.name) };
      const t = { ...body, id: crypto.randomUUID() };
      tables.push(t);
      return t;
    }
    if (/^\/api\/v2\/flows\/datatables\/[^/]+\/rows$/.test(p) && method === "POST") {
      if (rows.has(body.key)) throw fail("HTTP_400", `POST ${p} failed [flows.datatables.not.unique]: key name is not unique`);
      rows.set(body.key, body);
      return body;
    }
    const m = p.match(/^\/api\/v2\/flows\/datatables\/[^/]+\/rows\/(.+)$/);
    if (m) {
      const k = decodeURIComponent(m[1]!);
      if (method === "GET") {
        if (!rows.has(k)) throw fail("HTTP_404", "not found");
        return rows.get(k);
      }
      if (method === "PUT") return void rows.set(k, body);
      if (method === "DELETE") return void rows.delete(k);
    }
    return NOT_MINE;
  };
  return { tables, rows, handle, entry: (k: string) => JSON.parse(rows.get(k)!.entry) };
}

/** A tiny org: wrap-up codes, queues (with wrap-up codes and members), checklists, response libraries, the gctk registry. */
function fakeOrg(name: string) {
  const db: Record<string, Obj[]> = { contacts: [], wrapupcodes: [], queues: [], checklists: [], libraries: [], responses: [], divisions: [{ id: crypto.randomUUID(), name: "Home", homeDivision: true }] };
  const queueWraps = new Map<string, string[]>();
  const members = new Map<string, string[]>();
  const calls: string[] = [];
  const registry = fakeRegistry();
  const list = (k: string, q: Obj = {}) => ({ entities: db[k]!.filter((x) => !q.name || x.name === q.name), pageCount: 1 });
  const add = (k: string, body: Obj) => {
    const o = { ...body, id: crypto.randomUUID() };
    db[k]!.push(o);
    return o;
  };
  const route = (method: string, p: string, q: Obj, body: any): any => {
    calls.push(`${method} ${p}`);
    const reg = registry.handle(method, p, q, body);
    if (reg !== NOT_MINE) return reg;
    let m: RegExpMatchArray | null;
    if (p === "/api/v2/authorization/divisions") return list("divisions");
    if ((m = p.match(/^\/api\/v2\/users\/(.+)$/))) return { id: m[1], name: "Pat Presenter" };
    if (p === "/api/v2/routing/wrapupcodes") return method === "GET" ? list("wrapupcodes", q) : add("wrapupcodes", body);
    if ((m = p.match(/^\/api\/v2\/routing\/wrapupcodes\/(.+)$/))) {
      if (method === "DELETE") return void (db.wrapupcodes = db.wrapupcodes!.filter((x) => x.id !== m![1]));
      return db.wrapupcodes!.find((x) => x.id === m![1]);
    }
    if (p === "/api/v2/routing/queues") return method === "GET" ? list("queues", q) : add("queues", body);
    if ((m = p.match(/^\/api\/v2\/routing\/queues\/([^/]+)\/wrapupcodes$/))) {
      if (method === "POST") return void queueWraps.set(m[1]!, [...(queueWraps.get(m[1]!) ?? []), ...body.map((x: Obj) => x.id)]);
      return { entities: (queueWraps.get(m[1]!) ?? []).map((id) => db.wrapupcodes!.find((w) => w.id === id)) };
    }
    if ((m = p.match(/^\/api\/v2\/routing\/queues\/([^/]+)\/members$/))) return void members.set(m[1]!, [...new Set([...(members.get(m[1]!) ?? []), ...body.map((x: Obj) => x.id)])]);
    if ((m = p.match(/^\/api\/v2\/routing\/queues\/([^/]+)\/members\/([^/]+)$/)) && method === "DELETE") return void members.set(m[1]!, (members.get(m[1]!) ?? []).filter((x) => x !== m![2]));
    if (p === "/api/v2/externalcontacts/contacts") return method === "GET" ? { entities: db.contacts!.filter((x) => !q.q || `${x.firstName} ${x.lastName}`.includes(q.q)), pageCount: 1 } : add("contacts", body);
    if ((m = p.match(/^\/api\/v2\/externalcontacts\/contacts\/(.+)$/))) {
      const i = db.contacts!.findIndex((x) => x.id === m![1]);
      if (i < 0) throw Object.assign(new Error("not found"), { code: "HTTP_404" });
      if (method === "DELETE") return void db.contacts!.splice(i, 1);
      if (method === "PUT") return (db.contacts![i] = { ...body, id: m[1] });
      return db.contacts![i];
    }
    if ((m = p.match(/^\/api\/v2\/routing\/queues\/([^/]+)$/))) {
      if (method === "DELETE") return void (db.queues = db.queues!.filter((x) => x.id !== m![1]));
      return db.queues!.find((x) => x.id === m![1]);
    }
    if (p === "/api/v2/assistants/agentchecklists") return method === "GET" ? list("checklists") : add("checklists", body);
    if ((m = p.match(/^\/api\/v2\/assistants\/agentchecklists\/(.+)$/))) {
      if (method === "DELETE") return void (db.checklists = db.checklists!.filter((x) => x.id !== m![1]));
      return db.checklists!.find((x) => x.id === m![1]);
    }
    if (p === "/api/v2/responsemanagement/libraries") return method === "GET" ? list("libraries") : add("libraries", body);
    if ((m = p.match(/^\/api\/v2\/responsemanagement\/libraries\/(.+)$/))) {
      if (method === "DELETE") return void (db.libraries = db.libraries!.filter((x) => x.id !== m![1]));
      return db.libraries!.find((x) => x.id === m![1]);
    }
    if (p === "/api/v2/responsemanagement/responses") return method === "GET" ? { entities: db.responses!.filter((r) => r.libraries[0].id === q.libraryId) } : add("responses", body);
    if ((m = p.match(/^\/api\/v2\/responsemanagement\/responses\/(.+)$/))) return void (db.responses = db.responses!.filter((x) => x.id !== m![1]));
    throw new Error(`fake org: ${method} ${p}`);
  };
  const request = async (method: string, p: string, q: Obj = {}, body?: unknown) => ({ status: 200, body: route(method, p, q, body) });
  const get = (p: string, q: Obj = {}) => request("GET", p, q);
  const client = {
    profile: { name, region: "mypurecloud.de", tier: "sandbox", credentials: "env" },
    request,
    get,
    async getAll(p: string, q: Obj = {}) {
      const first = await get(p, q);
      return { first, paged: { items: first.body.entities, pages: 1, truncated: false } };
    },
  } as unknown as GenesysClient;
  return { db, client, calls, members, queueWraps, registry };
}

/** A demo package in the built-in demos folder; its id is "test-demo". */
function demoFolder(): string {
  const folder = path.join(tmp, "builtin", "test-demo");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "demo.yaml"),
    [
      "name: Test demo",
      "include:",
      "  - { type: queue, names: [Sales] }",
      "  - { type: agentchecklist, names: [Greeting] }",
      "  - { type: responselibrary, names: [Lib] }",
      "commands:",
      "  - id: probe",
      "    label: Probe",
      "    cwd: .",
      "    run: [node, -e, \"require('fs').writeFileSync('env.json', JSON.stringify({ q: process.env.QUEUE_ID, id: process.env.CLIENT, skip: process.env.SKIP ?? null }))\"]",
      "    env: { QUEUE_ID: '@{queue:Sales}', CLIENT: '@{org.clientId}' }",
      "    envOtherOrg: { SKIP: '1' }",
    ].join("\n"),
  );
  setSnapshotSource("test-demo", { profile: "src-org" });
  return folder;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-demos-"));
  process.env.GCTK_HOME = path.join(tmp, "gctk");
  process.env.GCTK_DEMOS_DIR = path.join(tmp, "builtin");
  process.env.GCTK_CLIENT_ID = "client-1";
  process.env.GCTK_CLIENT_SECRET = "secret-1";
  for (const name of ["src-org", "dst-org"]) saveProfile({ name, region: "mypurecloud.de", tier: "sandbox", credentials: "env" });
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sourceOrg() {
  const src = fakeOrg("src-org");
  const won = src.db.wrapupcodes!.push({ id: crypto.randomUUID(), name: "Won" });
  void won;
  const lost = { id: crypto.randomUUID(), name: "Lost" };
  src.db.wrapupcodes!.push(lost);
  const q = { id: crypto.randomUUID(), name: "Sales", description: "d", mediaSettings: { call: { alertingTimeoutSeconds: 8 } }, division: { id: src.db.divisions![0]!.id } };
  src.db.queues!.push(q);
  src.queueWraps.set(q.id, src.db.wrapupcodes!.map((w) => w.id));
  src.db.checklists!.push({ id: crypto.randomUUID(), name: "Greeting", language: "de-de", checklistItems: [{ id: "x", name: "Say hello" }] });
  const lib = { id: crypto.randomUUID(), name: "Lib" };
  src.db.libraries!.push(lib);
  Object.assign(q, { cannedResponseLibraries: { mode: "SelectedOnly", libraryIds: [lib.id] } });
  src.db.responses!.push({ id: crypto.randomUUID(), name: "Hello", libraries: [{ id: lib.id }], texts: [{ content: "Hi" }] });
  return src;
}

describe("demos", () => {
  it("snapshots by name, deploys with the target's ids, reuses what exists, and removes only what it created", async () => {
    demoFolder();
    const id = "test-demo";
    const src = sourceOrg();
    const snap = await takeSnapshot(id, { client: src.client });
    expect(snap.objects.map((o) => `${o.type}:${o.name}`)).toEqual(["wrapupcode:Won", "wrapupcode:Lost", "responselibrary:Lib", "queue:Sales", "agentchecklist:Greeting"]);
    expect(snap.objects.find((o) => o.type === "queue")!.spec.cannedResponseLibraries).toEqual({ mode: "SelectedOnly", libraryIds: ["@{responselibrary:Lib}"] });
    expect(snap.objects.find((o) => o.type === "queue")!.spec.wrapupCodes).toEqual(["@{wrapupcode:Won}", "@{wrapupcode:Lost}"]);
    expect(snap.objects.find((o) => o.type === "agentchecklist")!.spec.checklistItems).toEqual([{ name: "Say hello" }]);
    expect(snap.unresolved).toEqual([]);

    const dst = fakeOrg("dst-org");
    dst.db.wrapupcodes!.push({ id: "already-there", name: "Lost" });
    const presenter = crypto.randomUUID();
    const rec = await deployDemo(id, { profile: "dst-org", client: dst.client, presenterId: presenter });
    expect(rec.created.map((x) => x.name)).toEqual(["Won", "Lib", "Sales", "Greeting"]);
    expect(rec.reused.map((x) => x.name)).toEqual(["Lost"]);
    const q = dst.db.queues!.find((x) => x.name === "Sales")!;
    expect(dst.queueWraps.get(q.id)).toEqual([rec.ids["@{wrapupcode:Won}"], "already-there"]);
    expect(q.divisionId).toBe(dst.db.divisions![0]!.id);
    expect(q.cannedResponseLibraries).toEqual({ mode: "SelectedOnly", libraryIds: [rec.ids["@{responselibrary:Lib}"]] });
    expect(dst.members.get(q.id)).toEqual([presenter]);
    expect(rec.presenter).toEqual({ id: presenter, name: "Pat Presenter" });
    expect(dst.db.responses!).toHaveLength(1);
    expect(rec.ids["@{responselibrary:Lib#response:Hello}"]).toBe(dst.db.responses![0]!.id);

    // Never twice: a second deploy is refused; Update brings the same deployment up to date and creates nothing.
    await expect(deployDemo(id, { profile: "dst-org", client: dst.client })).rejects.toThrow(/deployed in this org already/);
    const again = await deployDemo(id, { profile: "dst-org", client: dst.client, update: true });
    expect(dst.db.queues).toHaveLength(1);
    expect(again.created).toHaveLength(4);
    expect(listDemos()[0]!.deployments).toEqual([expect.objectContaining({ profile: "dst-org", created: 4, reused: 1 })]);

    const r = await removeDemo(id, { profile: "dst-org", client: dst.client });
    expect(r).toEqual({ removed: 4, failed: [] });
    expect(dst.db.wrapupcodes!.map((w) => w.id)).toEqual(["already-there"]);
    expect(dst.db.queues).toEqual([]);
    expect(listDemos()[0]!.deployments).toEqual([]);
    expect(dst.registry.rows.size).toBe(0);
  });

  it("starts a command with the org's credentials and the deployed ids, and stops it", async () => {
    const folder = demoFolder();
    const id = "test-demo";
    const src = sourceOrg();
    await takeSnapshot(id, { client: src.client });
    await expect(startCommand(id, "probe", "dst-org")).rejects.toThrow(/Deploy the demo into dst-org first/);
    await deployDemo(id, { profile: "dst-org", client: fakeOrg("dst-org").client });
    await startCommand(id, "probe", "dst-org");
    const out = path.join(folder, "env.json");
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    const env = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(env.q).toMatch(/^[0-9a-f-]{36}$/);
    expect(env).toMatchObject({ id: "client-1", skip: "1" });
    expect(commandStatus(id)[0]).toMatchObject({ id: "probe", label: "Probe" });
    await stopCommand(id, "probe");
    expect(commandStatus(id)[0]!.running).toBe(false);
  });

  it("routes the chosen WhatsApp number to the demo's message flow, and Remove gives it the old flow back", async () => {
    const folder = demoFolder();
    fs.appendFileSync(path.join(folder, "demo.yaml"), "\nmessageRouting: { flow: Entry }\n");
    const id = "test-demo";
    fs.writeFileSync(path.join(folder, "snapshot.json"), JSON.stringify({ at: "x", region: "mypurecloud.de", unresolved: [], objects: [{ type: "messageflow", name: "Entry", spec: { name: "Entry", yaml: "" } }] }));
    const flows = [{ id: "flow-entry", name: "Entry" }];
    let routedTo: unknown = { id: "flow-old" };
    const puts: unknown[] = [];
    const registry = fakeRegistry();
    const request = async (method: string, p: string, _q: Obj = {}, body?: any): Promise<{ status: number; body: any }> => {
        const reg = registry.handle(method, p, _q, body);
        if (reg !== NOT_MINE) return { status: 200, body: reg };
        if (p === "/api/v2/authorization/divisions") return { status: 200, body: { entities: [{ id: "d1", name: "Home", homeDivision: true }] } };
        if (p === "/api/v2/flows") return { status: 200, body: { entities: flows } };
        if (p === "/api/v2/conversations/messaging/integrations/whatsapp/wa-1") return { status: 200, body: { id: "wa-1", name: "Demo Number", phoneNumber: "+44 20", recipient: { id: "rcp-1" } } };
        if (p === "/api/v2/routing/message/recipients/rcp-1") {
          if (method === "PUT") {
            puts.push(body);
            routedTo = body.flow;
          }
          return { status: 200, body: { id: "rcp-1", flow: routedTo && { ...(routedTo as Obj), name: (routedTo as Obj).id === "flow-old" ? "Old flow" : "Entry" } } };
        }
        throw new Error(`unexpected ${method} ${p}`);
    };
    const c = {
      profile: { name: "dst-org", region: "mypurecloud.de" },
      request,
      get: (p: string, q: Obj = {}) => request("GET", p, q),
      async getAll(p: string, q: Obj = {}) {
        const first = await request("GET", p, q);
        return { first, paged: { items: first.body.entities, pages: 1, truncated: false } };
      },
    } as unknown as GenesysClient;
    const rec = await deployDemo(id, { profile: "dst-org", client: c, whatsappIntegrationId: "wa-1" });
    expect(routedTo).toEqual({ id: "flow-entry" });
    expect(rec.routing).toMatchObject({ integration: "Demo Number", previousFlowId: "flow-old", previousFlow: "Old flow" });
    // A second deploy keeps "Old flow" as the one to go back to.
    expect((await deployDemo(id, { profile: "dst-org", client: c, whatsappIntegrationId: "wa-1", update: true })).routing).toMatchObject({ previousFlow: "Old flow" });
    expect(listDemos()[0]!.deployments[0]!.routing).toEqual({ integration: "Demo Number", phone: "+44 20" });
    await removeDemo(id, { profile: "dst-org", client: c });
    expect(routedTo).toEqual({ id: "flow-old" });
    expect(listDemos()[0]!.deployments).toEqual([]);
  });

  it("lists the demos that ship with gctk; only a source set on this computer allows a snapshot", async () => {
    const pkg = path.join(tmp, "builtin", "shipped");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "demo.yaml"), "name: Shipped\ninclude: []\n");
    expect(listDemos()[0]).toMatchObject({ id: "shipped", canSnapshot: false, folder: pkg });
    await expect(takeSnapshot("shipped")).rejects.toThrow(/No snapshot source/);
    expect(() => setSnapshotSource("shipped", { profile: "nobody-here" })).toThrow();
    setSnapshotSource("shipped", { profile: "src-org", replace: [{ value: "Pat", with: "@{presenter.name}" }] });
    expect(listDemos()[0]).toMatchObject({ canSnapshot: true, sourceProfile: "src-org" });
    expect(fs.readFileSync(path.join(pkg, "demo.yaml"), "utf8")).not.toMatch(/src-org/);
    setSnapshotSource("shipped", undefined);
    expect(snapshotSource("shipped")).toBeUndefined();
    expect(listDemos()[0]!.canSnapshot).toBe(false);
  });

  it("checks parameters and puts them into the contact instead of the source org's values", () => {
    const params = [
      { id: "phone", label: "Phone", format: "phone" as const, contact: { name: "Max Muster", fields: ["workPhone", "whatsAppId"] } },
      { id: "mail", label: "Mail", format: "email" as const, contact: { name: "Max Muster", fields: ["workEmail"] } },
      { id: "sms", label: "SMS", format: "phone" as const, optional: true },
    ];
    expect(() => parameterValues(params, { mail: "a@b.de" })).toThrow(/Enter "Phone"/);
    expect(() => parameterValues(params, { phone: "0151", mail: "a@b.de" })).toThrow(/international format/);
    expect(() => parameterValues(params, { phone: "+4915112345678", mail: "nope" })).toThrow(/not an email/);
    expect(parameterValues(params, { phone: "0049 151 1234-5678", mail: "a@b.de" })).toEqual({
      "@{param:phone}": "+4915112345678",
      "@{param:phone.digits}": "4915112345678",
      "@{param:phone.masked}": "+4915112•• ••78",
      "@{param:mail}": "a@b.de",
    });
    const objects = [{ type: "externalcontact", name: "Max Muster", spec: { workPhone: { userInput: "+49 170 999", e164: "+49170999" }, workEmail: "me@corp.de", whatsAppId: { displayName: "Max", phoneNumber: { userInput: "49170999" } } } }];
    applyParameters(objects, params);
    expect(JSON.stringify(objects)).not.toMatch(/999|me@corp/);
    expect(objects[0]!.spec).toMatchObject({ workPhone: { display: "@{param:phone}" }, workEmail: "@{param:mail}", whatsAppId: { displayName: "Max", phoneNumber: { userInput: "@{param:phone.digits}" } } });
  });

  it("deploys with the presenter's values and replaces source texts in the snapshot", async () => {
    const folder = demoFolder();
    fs.appendFileSync(path.join(folder, "demo.yaml"), "\nparameters:\n  - { id: who, label: Who }\nreplace:\n  - { value: Hi, with: 'Hi @{param:who}' }\n");
    // Replacements kept on this computer apply as well, without naming the text in the package.
    setSnapshotSource("test-demo", { profile: "src-org", replace: [{ value: "Say hello", with: "Greet @{presenter.name}" }] });
    const id = "test-demo";
    const snap = await takeSnapshot(id, { client: sourceOrg().client });
    expect(snap.objects.find((o) => o.type === "responselibrary")!.spec.responses[0].texts).toEqual([{ content: "Hi @{param:who}" }]);
    expect(snap.objects.find((o) => o.type === "agentchecklist")!.spec.checklistItems).toEqual([{ name: "Greet @{presenter.name}" }]);
    expect(snap).not.toHaveProperty("source");
    const dst = fakeOrg("dst-org");
    await expect(deployDemo(id, { profile: "dst-org", client: dst.client })).rejects.toThrow(/Enter "Who"/);
    expect(dst.registry.rows.size).toBe(0); // checked before anything is registered
    const rec = await deployDemo(id, { profile: "dst-org", client: dst.client, params: { who: 'Ann "A" Lee' } });
    expect(dst.db.responses![0]!.texts).toEqual([{ content: 'Hi Ann "A" Lee' }]);
    expect(rec.params).toEqual({ who: 'Ann "A" Lee' });
  });

  it("deploys only what the chosen customer channel needs, plus the package's own objects", async () => {
    const folder = demoFolder();
    fs.appendFileSync(
      path.join(folder, "demo.yaml"),
      [
        "",
        "channels:",
        "  - { id: web, label: Website }",
        "  - { id: whatsapp, label: WhatsApp }",
        "create:",
        "  - { type: agentchecklist, name: Web only, channel: web, spec: { name: Web only, language: de-de, checklistItems: [] } }",
        "  - { type: agentchecklist, name: Always, spec: { name: Always, language: de-de, checklistItems: [] } }",
      ].join("\n"),
    );
    const id = "test-demo";
    await takeSnapshot(id, { client: sourceOrg().client });
    expect(listDemos()[0]!.snapshot!.objects).toBe(7);
    const dst = fakeOrg("dst-org");
    await expect(deployDemo(id, { profile: "dst-org", client: dst.client, channel: "fax" })).rejects.toThrow(/Unknown customer channel "fax"/);
    const viaWhatsApp = await deployDemo(id, { profile: "dst-org", client: dst.client, channel: "whatsapp" });
    expect(viaWhatsApp.channel).toBe("whatsapp");
    expect(dst.db.checklists!.map((x) => x.name).sort()).toEqual(["Always", "Greeting"]);
    const byDefault = await deployDemo(id, { profile: "dst-org", client: dst.client, update: true });
    expect(byDefault.channel).toBe("web");
    expect(dst.db.checklists!.map((x) => x.name).sort()).toEqual(["Always", "Greeting", "Web only"]);
    expect(listDemos()[0]!.deployments[0]).toMatchObject({ channel: "web" });
  });

  it("removes a flow action by its tracking id and leaves the rest of the YAML as it was", () => {
    const yaml = [
      "digitalBot:",
      "  bots:",
      "    - bot:",
      "        actions:",
      "          - askForSlot:",
      "              name: Ask",
      "              trackingId: 37",
      "              question:",
      '                exp: "MakeCommunication(\\n  X)"',
      "          - communicate:",
      "              name: Hello",
      "              trackingId: 42",
      "  other: 1",
    ].join("\n");
    const r = removeFlowActions(yaml, [37, 99]);
    expect(r.removed).toBe(1);
    expect(r.yaml).toBe(["digitalBot:", "  bots:", "    - bot:", "        actions:", "          - communicate:", "              name: Hello", "              trackingId: 42", "  other: 1"].join("\n"));
  });

  it("runs the local part inside gctk: pages with the presenter's values and endpoints that call the org", async () => {
    const port = await new Promise<number>((r) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => r(p));
      });
    });
    const folder = demoFolder();
    fs.mkdirSync(path.join(folder, "pages"), { recursive: true });
    fs.writeFileSync(path.join(folder, "pages", "index.html"), "<p>Call @{param:phone.masked} on @{queue:Sales}</p>");
    fs.appendFileSync(
      path.join(folder, "demo.yaml"),
      [
        "",
        "parameters:",
        "  - { id: phone, label: Phone, format: phone }",
        "  - { id: sms, label: SMS, format: phone, optional: true }",
        "local:",
        "  label: Pages",
        "  web:",
        `    port: ${port}`,
        "    root: pages",
        "    endpoints:",
        "      - { path: /api/session, kind: session }",
        "      - path: /api/case",
        "        kind: request",
        "        call: { method: POST, path: /api/v2/things, body: { queue: '@{queue:Sales}', to: '@{param:phone}', note: 'ref {{input.ref}}' } }",
        "        reply: { reference: '{{response.reference}}', sent: '{{request.note}}' }",
        "      - path: /api/sms",
        "        kind: request",
        "        call: { method: POST, path: /api/v2/sms, body: { from: '@{param:sms}' } }",
        "        reply: { ok: yes }",
      ].join("\n"),
    );
    const id = "test-demo";
    await takeSnapshot(id, { client: sourceOrg().client });
    const dst = fakeOrg("dst-org");
    const rec = await deployDemo(id, { profile: "dst-org", client: dst.client, params: { phone: "+4915112345678" } });
    const posted: Obj[] = [];
    const client = { request: async (method: string, p: string, _q: Obj, body: Obj) => (posted.push({ method, p, body }), { status: 200, body: { reference: "C-1" } }) } as unknown as GenesysClient;
    const st = await startCommand(id, "local", "dst-org", client);
    expect(st).toMatchObject({ id: "local", label: "Pages", running: true, url: `http://localhost:${port}/` });
    try {
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/v/123/index.html`)).text()).toBe(`<p>Call +4915112•• ••78 on ${rec.ids["@{queue:Sales}"]}</p>`);
      expect((await fetch(`${base}/index.html`)).headers.get("cache-control")).toBe("no-store");
      expect((await fetch(`${base}/now/index.html`, { redirect: "manual" })).headers.get("location")).toMatch(/^\/v\/\d+\/index.html$/);
      expect((await fetch(`${base}/..%2fdemo.yaml`)).status).toBe(404);
      expect(await (await fetch(`${base}/api/session`)).json()).toEqual({ session: expect.stringMatching(/^\d+$/) });
      const r = await fetch(`${base}/api/case`, { method: "POST", body: JSON.stringify({ ref: "X9" }) });
      expect(await r.json()).toEqual({ reference: "C-1", sent: "ref X9" });
      expect(posted).toEqual([{ method: "POST", p: "/api/v2/things", body: { queue: rec.ids["@{queue:Sales}"], to: "+4915112345678", note: "ref X9" } }]);
      const sms = await fetch(`${base}/api/sms`, { method: "POST" });
      expect(sms.status).toBe(502);
      expect((await sms.json()).error).toMatch(/"sms" is not set/);
    } finally {
      await stopCommand(id, "local");
    }
    expect(commandStatus(id)[0]!.running).toBe(false);
  });

  it("ships the Lumea demo complete and without anyone's phone or email", () => {
    const pkg = path.resolve("demos/lumea");
    const m = loadManifest(pkg);
    const snap = fs.readFileSync(path.join(pkg, "snapshot.json"), "utf8");
    const declared = new Set((m.parameters ?? []).map((p) => p.id));
    for (const [, used] of snap.matchAll(/@\{param:(\w+)/g)) expect(declared).toContain(used);
    expect(snap).not.toMatch(/"\+?49\s?1[5-7]\d[\d ]{6,}"/);
    expect(JSON.parse(snap).objects.find((o: Obj) => o.type === "externalcontact").spec.workEmail).toBe("@{param:customerEmail}");
    const groups = Object.fromEntries(demoPermissions(m, JSON.parse(snap)).map((g) => [g.title, g.items]));
    expect(groups["Deploy and remove"]).toEqual(expect.arrayContaining(["caseManagement:caseplan:add", "architect:job:create", "scripter:script:add", "assistants:copilot:edit"]));
    expect(groups['Only for the channel "Lumea website with Web Messenger"']).toContain("webDeployments:deployment:add");
    expect(groups['Only for the channel "WhatsApp"']).toEqual(["messaging:integration:view", "routing:message:manage"]);
    expect(Object.keys(groups).find((k) => k.startsWith("During the demo"))).toBeTruthy();
    expect(Object.values(groups).flat()).toContain("conversation:suggestion:edit");
    // Every text of the story is a string (an unquoted "x: y" in YAML would become an object).
    const story = loadStory(pkg, m, JSON.parse(snap))!;
    const texts = [story.summary, story.persona, ...(story.rules ?? []), ...(story.before ?? []), ...story.scenes.flatMap((s) => [s.title, s.screen, ...(s.steps ?? []).map((x) => x.text), ...(s.triggers ?? []).flatMap((x) => [x.when, x.then]), ...(s.notes ?? [])])].filter((x) => x !== undefined);
    for (const x of texts) expect(typeof x).toBe("string");
    expect(story.reference.copilot.find((r) => r.when.includes("Rechnungsfrage"))!.then.join(" ")).toMatch(/Third-party answer from gctk.*Script page „Abrechnung“/);
    expect(story.reference.copilot.find((r) => r.when.includes("Bestaetigung gesendet"))!.when).toMatch(/never fires/);
    for (const page of ["index.html", "cockpit.html", "nba.html", "workitem.html", "assets/lumea.js", "assets/lumea.css", "assets/lumea_logo.png"]) expect(fs.existsSync(path.join(pkg, m.local!.web!.root, page))).toBe(true);
    expect(fillTemplate(m.local!.web!.endpoints!.find((e) => e.path === "/api/angebot"), { "@{caseplan:Lumea Vertragsangebot}": "cp", "@{externalcontact:Markus Berger}": "ct" })).toMatchObject({ call: { body: { caseplanId: "cp", externalContactId: "ct" } } });
  });

  it("refuses unknown demos and unknown types", async () => {
    await expect(deployDemo("nope", { profile: "dst-org" })).rejects.toThrow(/Unknown demo/);
    const folder = demoFolder();
    fs.writeFileSync(path.join(folder, "demo.yaml"), "name: x\ninclude:\n  - { type: spaceship, names: [a] }\n");
    expect(listDemos()[0]!.error).toMatch(/unknown type "spaceship"/);
  });
});

describe("one deployment per org, whoever deploys", () => {
  const otherComputer = () => { process.env.GCTK_HOME = path.join(tmp, `gctk-${crypto.randomUUID()}`); saveProfile({ name: "dst-org", region: "mypurecloud.de", tier: "sandbox", credentials: "env" }); };

  it("keeps the deployment in the org: another computer sees it, cannot deploy again, joins, and can remove it", async () => {
    demoFolder();
    const id = "test-demo";
    await takeSnapshot(id, { client: sourceOrg().client });
    const dst = fakeOrg("dst-org");
    await deployDemo(id, { profile: "dst-org", client: dst.client, presenterId: "user-a" });
    expect(dst.registry.entry(id)).toMatchObject({ demo: id, state: "deployed", by: "Pat Presenter", presenters: [{ id: "user-a" }] });
    expect(JSON.stringify(dst.registry.entry(id))).not.toContain('"profile"');

    otherComputer();
    const st = await orgDemoStatus(id, "dst-org", dst.client);
    expect(st.deployment).toMatchObject({ state: "deployed", by: "Pat Presenter", created: 5, reused: 0 });
    await expect(deployDemo(id, { profile: "dst-org", client: dst.client, presenterId: "user-b" })).rejects.toThrow(/never deployed twice/);
    expect(dst.db.queues).toHaveLength(1);

    const q = dst.db.queues![0]!;
    await joinDemo(id, { profile: "dst-org", presenterId: "user-b", client: dst.client });
    expect(dst.members.get(q.id)).toEqual(["user-a", "user-b"]);
    expect(dst.registry.entry(id).presenters.map((p: Obj) => p.id)).toEqual(["user-a", "user-b"]);

    expect(await removeDemo(id, { profile: "dst-org", client: dst.client })).toEqual({ removed: 5, failed: [] });
    expect(dst.db.queues).toEqual([]);
    expect(dst.registry.rows.size).toBe(0);
    expect((await orgDemoStatus(id, "dst-org", dst.client)).deployment).toBeUndefined();
  });

  it("lets only one deploy start, and refuses one while another is running", async () => {
    demoFolder();
    const id = "test-demo";
    await takeSnapshot(id, { client: sourceOrg().client });
    const dst = fakeOrg("dst-org");
    const busy = { demo: id, state: "deploying", by: "Sam", at: new Date().toISOString(), heartbeat: new Date().toISOString(), version: "x", presenters: [], record: { at: "", ids: {}, created: [], reused: [] } };
    dst.registry.handle("POST", "/api/v2/flows/datatables", {}, { name: "gctk demos" });
    dst.registry.rows.set(id, { key: id, entry: JSON.stringify(busy) });
    await expect(deployDemo(id, { profile: "dst-org", client: dst.client })).rejects.toThrow(/Sam is deploying/);
    await expect(removeDemo(id, { profile: "dst-org", client: dst.client })).rejects.toThrow(/deploying this demo right now/);
    // A deploy that stopped writing long ago (a closed laptop) is taken over.
    dst.registry.rows.set(id, { key: id, entry: JSON.stringify({ ...busy, heartbeat: new Date(Date.now() - 3600_000).toISOString() }) });
    await deployDemo(id, { profile: "dst-org", client: dst.client });
    expect(dst.registry.entry(id).state).toBe("deployed");
  });

  it("shows what exists in an org without a deployment, and registers an older local deployment", async () => {
    demoFolder();
    const id = "test-demo";
    await takeSnapshot(id, { client: sourceOrg().client });
    const handMade = fakeOrg("dst-org");
    handMade.db.queues!.push({ id: "mine", name: "Sales" });
    expect((await orgDemoStatus(id, "dst-org", handMade.client)).existing).toEqual(['Queue "Sales"']);

    const dst = fakeOrg("dst-org");
    await deployDemo(id, { profile: "dst-org", client: dst.client });
    dst.registry.rows.clear(); // as if deployed before the org kept the registry
    expect((await orgDemoStatus(id, "dst-org", dst.client)).unregistered).toMatchObject({ created: 5 });
    expect((await registerDeployment(id, "dst-org", dst.client)).deployment).toMatchObject({ state: "deployed", created: 5 });
  });
});

describe("every presenter plays their own customer", () => {
  /** A package whose customer contact is a template (presenterContact), with the presenter's phone. */
  function personaDemo() {
    const folder = path.join(tmp, "builtin", "persona-demo");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "demo.yaml"), [
      "name: Persona demo",
      "include: []",
      "presenterContact: Markus Berger",
      "parameters:",
      "  - { id: customerPhone, label: Phone, format: phone, perPresenter: true, contact: { name: Markus Berger, fields: [workPhone] } }",
    ].join("\n"));
    fs.writeFileSync(path.join(folder, "snapshot.json"), JSON.stringify({ at: "x", region: "mypurecloud.de", unresolved: [], objects: [
      { type: "queue", name: "Sales", spec: { name: "Sales", wrapupCodes: [] } },
      { type: "externalcontact", name: "Markus Berger", spec: { firstName: "Markus", lastName: "Berger", salutation: "Herr", workPhone: { display: "@{param:customerPhone}" }, personalEmail: "markus.berger@muster.de", whatsAppId: { displayName: "Markus Berger", phoneNumber: { display: "@{param:customerPhone.digits}" } } } },
    ] }));
    return "persona-demo";
  }

  it("gives each presenter an own contact with a name unique in the org, and their own values on their computer", async () => {
    const id = personaDemo();
    const dst = fakeOrg("dst-org");
    await expect(deployDemo(id, { profile: "dst-org", client: dst.client, presenterId: "user-a", persona: { firstName: "M4x", lastName: "" }, params: { customerPhone: "+4915100000001" } })).rejects.toThrow(/first and last name/);
    expect(dst.registry.rows.size).toBe(0);
    await deployDemo(id, { profile: "dst-org", client: dst.client, presenterId: "user-a", persona: { salutation: "Herr", firstName: "Max", lastName: "Muster" }, params: { customerPhone: "+4915100000001" } });
    // The template is never deployed as such: Max Muster is user A's customer.
    expect(dst.db.contacts!.map((c) => `${c.firstName} ${c.lastName}`)).toEqual(["Max Muster"]);
    expect(dst.db.contacts![0]).toMatchObject({ salutation: "Herr", workPhone: { display: "+4915100000001" }, personalEmail: "max.muster@muster.de", whatsAppId: { displayName: "Max Muster", phoneNumber: { display: "4915100000001" } } });
    expect(dst.registry.entry(id).presenters).toEqual([expect.objectContaining({ id: "user-a", customer: "Max Muster", contactId: dst.db.contacts![0]!.id })]);

    // Another computer, another presenter: the same customer name is taken.
    process.env.GCTK_HOME = path.join(tmp, "gctk-b");
    saveProfile({ name: "dst-org", region: "mypurecloud.de", tier: "sandbox", credentials: "env" });
    await expect(joinDemo(id, { profile: "dst-org", presenterId: "user-b", persona: { firstName: "Max", lastName: "Muster" }, params: { customerPhone: "+4915100000002" }, client: dst.client })).rejects.toThrow(/plays the customer "Max Muster" already/);
    const st = await joinDemo(id, { profile: "dst-org", presenterId: "user-b", persona: { salutation: "Frau", firstName: "Erika", lastName: "Beispiel" }, params: { customerPhone: "+4915100000002" }, client: dst.client });
    expect(st.me).toMatchObject({ presenterId: "user-b", persona: { firstName: "Erika" }, params: { customerPhone: "+4915100000002" } });
    expect(dst.db.contacts!.map((c) => c.workPhone.display).sort()).toEqual(["+4915100000001", "+4915100000002"]);
    const q = dst.db.queues![0]!;
    expect(dst.members.get(q.id)).toEqual(["user-a", "user-b"]);
    // A hand-made contact with a name blocks it too.
    dst.db.contacts!.push({ id: "theirs", firstName: "Hans", lastName: "Hand" });
    await expect(joinDemo(id, { profile: "dst-org", presenterId: "user-c", persona: { firstName: "Hans", lastName: "Hand" }, params: { customerPhone: "+4915100000003" }, client: dst.client })).rejects.toThrow(/has a contact "Hans Hand" already/);

    // B leaves: their customer goes, A's stays; Remove takes A's too and leaves the hand-made one.
    await leaveDemo(id, { profile: "dst-org", presenterId: "user-b", client: dst.client });
    expect(dst.members.get(q.id)).toEqual(["user-a"]);
    expect(dst.db.contacts!.map((c) => c.firstName).sort()).toEqual(["Hans", "Max"]);
    await removeDemo(id, { profile: "dst-org", client: dst.client });
    expect(dst.db.contacts!.map((c) => c.firstName)).toEqual(["Hans"]);
    expect(dst.registry.rows.size).toBe(0);
  });
});

describe("a package that was renamed", () => {
  it("moves this computer's records, logs and snapshot source from the former id", () => {
    const pkg = path.join(tmp, "builtin", "new-name");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "demo.yaml"), "name: Renamed\nformerIds: [old-name]\ninclude: []\n");
    const demos = path.join(process.env.GCTK_HOME!, "demos");
    fs.mkdirSync(path.join(demos, "old-name"), { recursive: true });
    fs.writeFileSync(path.join(demos, "old-name", "dst-org.json"), JSON.stringify({ profile: "dst-org", at: "2026-10-01T10:00:00Z", ids: {}, created: [{ type: "queue", name: "Q", id: "q1" }], reused: [] }));
    fs.writeFileSync(path.join(demos, "old-name-local.log"), "x");
    fs.writeFileSync(path.join(process.env.GCTK_HOME!, "demo-sources.json"), JSON.stringify({ "old-name": { profile: "src-org" } }));
    const [d] = listDemos();
    expect(d).toMatchObject({ id: "new-name", sourceProfile: "src-org", deployments: [expect.objectContaining({ profile: "dst-org", created: 1 })] });
    expect(fs.existsSync(path.join(demos, "old-name"))).toBe(false);
    expect(fs.existsSync(path.join(demos, "new-name-local.log"))).toBe(true);
    expect(snapshotSource("new-name")).toEqual({ profile: "src-org" });
  });
});
