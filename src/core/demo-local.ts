import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { GenesysClient } from "./client.js";
import { GctkError } from "./errors.js";

/**
 * The part of a demo that runs on this computer, inside the gctk UI process: a web server for
 * pages an agent script embeds (with endpoints that call the org for the page) and a Copilot
 * third-party action that answers with a prepared text. No Python, no extra Node packages.
 */

type Obj = Record<string, any>;

export type LocalEndpoint =
  | { path: string; kind: "session" }
  /** Calls the org; `call` and `reply` may use @{…} tokens, {{input.x}}, {{request.x}} and {{response.x}}. */
  | { path: string; kind: "request"; method?: "GET" | "POST"; call: { method: string; path: string; body?: unknown }; reply: Record<string, string> }
  /** Finds the newest email conversation of the customer and links to it in the Genesys UI. */
  | { path: string; kind: "latestEmail"; from: string[]; contact?: string };

export interface LocalRuntime {
  label: string;
  web?: { port: number; root: string; open?: string; links?: Array<{ label: string; path: string }>; endpoints?: LocalEndpoint[] };
  copilot?: { queues: string[]; title: string; text: string };
}

export interface LocalContext {
  client: GenesysClient;
  /** Package folder (web.root is relative to it). */
  dir: string;
  region: string;
  /** Token → value: deployed ids, @{param:…}, @{presenter.name}, @{org.region}. */
  values: Record<string, string>;
  log: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function get(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Obj)[k] : undefined), obj);
}

/** Fills tokens in every string of x. A token without a value fails with a message the page can show. */
export function fillTemplate(x: unknown, values: Record<string, string>, vars: Obj = {}): unknown {
  if (typeof x === "string") {
    return x
      .replace(/@\{[^}]+\}/g, (t) => {
        const v = values[t];
        if (v === undefined || v === "") throw new GctkError("DEMO_LOCAL", missingText(t));
        return v;
      })
      .replace(/\{\{([\w.]+)\}\}/g, (_m, k: string) => String(get(vars, k) ?? ""));
  }
  if (Array.isArray(x)) return x.map((v) => fillTemplate(v, values, vars));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillTemplate(v, values, vars)]));
  return x;
}

function missingText(token: string): string {
  const inner = token.slice(2, -1);
  if (inner.startsWith("param:")) return `"${inner.slice(6).split(".")[0]}" is not set: enter it on the Demos page and deploy again.`;
  return `${inner.replace(":", " ")} is not in this org: deploy the demo first.`;
}

/** Fills only @{…} tokens in a served text file; unknown tokens stay as they are. */
function fillPage(text: string, values: Record<string, string>): string {
  return text.replace(/@\{[^}]+\}/g, (t) => values[t] ?? t);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const TEXT = new Set([".html", ".css", ".js", ".json", ".txt", ".svg"]);

// ------------------------------------------------------------- endpoints

async function latestEmail(ctx: LocalContext, ep: Extract<LocalEndpoint, { kind: "latestEmail" }>): Promise<Obj> {
  const from = ep.from.map((f) => fillPage(f, ctx.values)).filter((f) => f && !f.includes("@{"));
  const contact = ep.contact ? ctx.values[ep.contact] : undefined;
  const fmt = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, ".000Z");
  // The analytics query allows at most 7 days per call: search back week by week (8 weeks).
  for (let week = 0; week < 8; week++) {
    const to = Date.now() - week * 7 * 86400_000 + 3600_000;
    const body = (await ctx.client.request<Obj>("POST", "/api/v2/analytics/conversations/details/query", {}, { interval: `${fmt(to - 7 * 86400_000)}/${fmt(to)}`, order: "desc", paging: { pageSize: 100, pageNumber: 1 } })).body;
    for (const c of (body?.conversations ?? []) as Obj[]) {
      const hit = (c.participants ?? []).some((p: Obj) =>
        (p.sessions ?? []).some((s: Obj) => s.mediaType === "email" && (from.some((f) => `${s.addressFrom ?? ""} ${s.addressOther ?? ""}`.includes(f)) || (contact && p.externalContactId === contact))),
      );
      if (hit) return { id: c.conversationId, link: `https://apps.${ctx.region}/directory/#/engage/admin/interactions/${c.conversationId}`, start: String(c.conversationStart ?? "").slice(0, 16) };
    }
  }
  throw new GctkError("DEMO_LOCAL", "No email conversation of the customer was found in the last 8 weeks.");
}

async function answer(ctx: LocalContext, ep: LocalEndpoint, input: Obj, session: string): Promise<Obj> {
  if (ep.kind === "session") return { session };
  if (ep.kind === "latestEmail") return latestEmail(ctx, ep);
  const call = fillTemplate(ep.call, ctx.values, { input }) as { method: string; path: string; body?: unknown };
  const response = (await ctx.client.request<Obj>(call.method, call.path, {}, call.body)).body ?? {};
  return fillTemplate(ep.reply, ctx.values, { input, request: call.body, response }) as Obj;
}

// ------------------------------------------------------------- web server

function startWeb(ctx: LocalContext, web: NonNullable<LocalRuntime["web"]>): Promise<http.Server> {
  const root = path.resolve(ctx.dir, web.root);
  // Every start is a new session: the pages drop their saved state when it changes.
  const session = String(Date.now());
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let p = decodeURIComponent(url.pathname);
    const json = (code: number, body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body));
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": raw.length, "Cache-Control": "no-store" });
      res.end(raw);
    };
    const ep = (web.endpoints ?? []).find((e) => e.path === p.replace(/\/$/, ""));
    if (ep) {
      const method = ep.kind === "request" ? (ep.method ?? "POST") : "GET";
      if (req.method !== method) return json(405, { error: `Use ${method}.` });
      try {
        let input: Obj = {};
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks).toString("utf8");
          input = raw ? (JSON.parse(raw) as Obj) : {};
        }
        const out = await answer(ctx, ep, input, session);
        if (ep.kind !== "session") ctx.log(`${req.method} ${p}: ok`);
        return json(200, out);
      } catch (err) {
        const msg = (err as Error).message.slice(0, 300);
        ctx.log(`${req.method} ${p}: ${msg}`);
        return json(502, { error: msg });
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "Not found." });
    // /now/<file> → /v/<ms>/<file>: a URL that never existed, for a page that hangs in a cache.
    if (p.startsWith("/now/")) {
      res.writeHead(302, { Location: `/v/${Date.now()}/${p.slice(5)}`, "Content-Length": 0 });
      return res.end();
    }
    p = p.replace(/^\/v\/[^/]+\//, "/");
    if (p.endsWith("/")) p += "index.html";
    const file = path.resolve(root, `.${p}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(file).toLowerCase();
    const body = TEXT.has(ext) ? Buffer.from(fillPage(fs.readFileSync(file, "utf8"), ctx.values)) : fs.readFileSync(file);
    // HTML fresh every time; assets are revalidated (cheap 304) so changes show at once.
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Content-Length": body.length, "Cache-Control": ext === ".html" ? "no-store" : "no-cache" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(new GctkError("DEMO_LOCAL", err.code === "EADDRINUSE" ? `Port ${web.port} is in use. Is another copy of the pages running (e.g. an old serve.sh)?` : err.message)),
    );
    server.listen(web.port, "127.0.0.1", () => resolve(server));
  });
}

// ------------------------------------------------------- Copilot answers

const FINAL = ["completed", "complete", "cancelled", "canceled", "failed", "dismissed", "expired", "closed"];

/**
 * Answers Copilot's third-party action for conversations in the given queues: a notification
 * channel watches the queues, each new conversation gets its suggestion topic, and every open
 * suggestion is answered once with the prepared title and text.
 */
class CopilotAnswers {
  private ws?: WebSocket;
  private channelId?: string;
  private topics = new Set<string>();
  private answered = new Set<string>();
  private stopped = false;

  constructor(
    private ctx: LocalContext,
    private cfg: NonNullable<LocalRuntime["copilot"]>,
  ) {}

  async start(): Promise<void> {
    const queues = this.cfg.queues.map((n) => {
      const id = this.ctx.values[`@{queue:${n}}`];
      if (!id) throw new GctkError("DEMO_LOCAL", `Queue "${n}" is not in this org: deploy the demo first.`);
      return id;
    });
    await this.connect(queues.map((id) => `v2.routing.queues.${id}.conversations`));
    this.ctx.log(`Copilot answers: watching ${this.cfg.queues.join(", ")}`);
  }

  private async connect(topics: string[]): Promise<void> {
    const ch = (await this.ctx.client.request<Obj>("POST", "/api/v2/notifications/channels", {}, {})).body;
    this.channelId = ch.id;
    this.topics.clear();
    const ws = new WebSocket(ch.connectUri);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new GctkError("DEMO_LOCAL", "The Genesys notification channel could not be opened."));
    });
    ws.onmessage = (m) => void this.onMessage(String(m.data)).catch((err) => this.ctx.log(`Copilot answers: ${(err as Error).message}`));
    ws.onclose = () => void this.reconnect();
    await this.subscribe(topics);
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    const topics = [...this.topics];
    for (let i = 0; !this.stopped; i++) {
      await sleep(Math.min(30_000, 2000 * 2 ** i));
      try {
        await this.connect(topics);
        this.ctx.log("Copilot answers: reconnected");
        return;
      } catch (err) {
        this.ctx.log(`Copilot answers: reconnect failed (${(err as Error).message})`);
      }
    }
  }

  private async subscribe(topics: string[]): Promise<void> {
    const fresh = topics.filter((t) => !this.topics.has(t));
    if (!fresh.length) return;
    await this.ctx.client.request("POST", `/api/v2/notifications/channels/${this.channelId}/subscriptions`, {}, fresh.map((id) => ({ id })));
    for (const t of fresh) this.topics.add(t);
  }

  private async onMessage(raw: string): Promise<void> {
    const msg = JSON.parse(raw) as Obj;
    const topic = String(msg.topicName ?? "");
    if (topic === "v2.system.socket_closing") return void this.ws?.close();
    if (/^v2\.routing\.queues\.[^.]+\.conversations$/.test(topic)) {
      const id = msg.eventBody?.id;
      if (id) await this.subscribe([`v2.conversations.${id}.suggestions.thirdpartyaction`]);
      return;
    }
    const conv = /^v2\.conversations\.([^.]+)\.suggestions\.thirdpartyaction$/.exec(topic)?.[1];
    if (!conv) return;
    const ev = (msg.eventBody?.eventBody ?? msg.eventBody ?? {}) as Obj;
    const sid = ev.suggestionId as string | undefined;
    if (!sid || this.answered.has(sid) || FINAL.includes(String(ev.state ?? "").toLowerCase()) || ev.thirdPartySuggestion?.text) return;
    this.answered.add(sid);
    await this.ctx.client.request("PATCH", `/api/v2/conversations/${ev.conversationId ?? conv}/suggestions/${sid}`, {}, { thirdPartySuggestion: { title: this.cfg.title, text: this.cfg.text.trim() } });
    this.ctx.log(`Copilot answers: answered a suggestion in conversation ${conv}`);
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }
}

// --------------------------------------------------------------- control

export interface LocalHandle {
  url?: string;
  stop(): Promise<void>;
}

export async function startLocal(rt: LocalRuntime, ctx: LocalContext): Promise<LocalHandle> {
  const server = rt.web ? await startWeb(ctx, rt.web) : undefined;
  if (rt.web) ctx.log(`Pages: http://localhost:${rt.web.port}/${rt.web.open ?? ""}`);
  let copilot: CopilotAnswers | undefined;
  try {
    if (rt.copilot) {
      copilot = new CopilotAnswers(ctx, rt.copilot);
      await copilot.start();
    }
  } catch (err) {
    server?.close();
    throw err;
  }
  return {
    url: rt.web ? `http://localhost:${rt.web.port}/${rt.web.open ?? ""}` : undefined,
    stop: async () => {
      copilot?.stop();
      if (!server) return;
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
    },
  };
}
