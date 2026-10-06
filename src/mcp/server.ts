import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatAiSetup, scanAiSetup } from "../core/ai-setup.js";
import { axlStatus, formatAxlStatus } from "../core/axl.js";
import { formatError } from "../core/errors.js";
import { ensureSharedUi } from "../ui/daemon.js";
import { openBrowser, UI_PAGES } from "../ui/launcher.js";

declare const __GCTK_VERSION__: string;
const VERSION = typeof __GCTK_VERSION__ === "string" ? __GCTK_VERSION__ : "dev";

const INSTRUCTIONS = `Genesys Cloud Toolkit: a local web UI that makes the user's AI setup and Genesys Cloud demos
transparent. gc_ui opens it (orgs, AI setup, demo website, Demo ready, AXL workshops, monitoring);
gc_ai_setup tells which MCP servers and skills the user's editors load and which org each server
works on; gc_axl gives the AXL workshop settings. Secrets are never shown. Org credentials are entered
on the Orgs page of the UI, never in the chat.`;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function guarded(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    return { content: [{ type: "text", text: formatError(err) }], isError: true };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "gctk", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "gc_ui",
    {
      title: "Open the gctk UI",
      description:
        "Open the local gctk web UI in the user's browser: profiles (Orgs: add orgs and their OAuth credentials, which go straight into the OS keychain), ai-setup (the editors' MCP servers, skills and where their credentials are; fixes such as moving a plain-text secret into the keychain), demos (deploy a whole demo into an org with one button, start what it needs on this computer), site (a demo customer website with the org's Messenger), demo (Demo ready: agent home-screen data, refresh, clean up), axl (AI Agent eXperience Lab workshops) and monitoring (object counts against the org's limits). Use it when the user wants to connect an org, check or fix their AI setup, or prepare a demo. The UI's session link goes to the browser only; you never see it.",
      inputSchema: { page: z.enum(UI_PAGES).default("profiles") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ page }) =>
      guarded(async () => {
        const url = await ensureSharedUi();
        return (await openBrowser(`${url}&view=${page}`))
          ? `Opened the gctk UI (${page}) in the user's browser. It keeps running in the background, also after this session, and all sessions share it.`
          : "Could not open a browser on this machine. Ask the user to run `npx -y github:diebergziege/gc-toolkit ui` in a terminal.";
      }),
  );

  server.registerTool(
    "gc_axl",
    {
      title: "AXL workshop settings",
      description:
        "AXL (AI Agent eXperience Lab) workshops the user manages on the AXL page of the gctk UI. Pass folder = your Cursor workspace to get that workshop: the org the ava-harness MCP server builds in, the workshop folder (sessions in its axl-sessions/), whether Cursor started the harness for it, and its sessions with their artifacts. Without folder: the list of workshops. Call it at the start of an AXL session and tell the facilitator which org the lab builds in. Read-only.",
      inputSchema: { folder: z.string().max(1000).optional().describe("absolute path of the Cursor workspace the lab runs in") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ folder }) => guarded(async () => formatAxlStatus(axlStatus(), folder)),
  );

  server.registerTool(
    "gc_ai_setup",
    {
      title: "MCP servers and skills of the user's editors",
      description:
        "The MCP servers configured in the user's editors (Cursor, Claude Code, Claude Desktop, VS Code, Windsurf: user, project and plugin config files) and the skills they load. For each server: file, command, how it gets its Genesys credentials (plain text in the file, keychain, gctk profiles) and which gctk profile/org its OAuth client belongs to; problems such as plain-text secrets, the same secret in several files, missing commands and skills loaded twice. Secrets are always masked. Use it when the user asks which MCP server works on which org, where credentials are, or why a skill or server misbehaves. Read-only: fixes (moving a secret to the keychain, removing an entry) are pressed by the user on the AI setup page (gc_ui page ai-setup).",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => guarded(async () => formatAiSetup(scanAiSetup())),
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
