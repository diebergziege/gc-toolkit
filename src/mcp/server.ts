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
transparent. gc_ui opens it (orgs, AI setup, projects and AXL workshops, demo website, Demo ready,
monitoring); gc_ai_setup tells which MCP servers Cursor loads and which org each server works on; gc_axl tells which org and Genesys tools a project folder or AXL workshop has. Secrets are never shown. Org credentials are entered
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
        "Open the local gctk web UI in the user's browser: profiles (Orgs: add orgs and their OAuth credentials, which go straight into the OS keychain), ai-setup (Cursor setup: the MCP servers Cursor loads, the org each works on, where its credentials are; fixes such as moving a plain-text secret into the keychain), demos (deploy a whole demo into an org with one button, start what it needs on this computer), site (a demo customer website with the org's Messenger), demo (Demo ready: agent home-screen data, refresh, clean up), axl (Projects: demo folders with their own org and Genesys tools, and AXL workshops) and monitoring (object counts against the org's limits). Use it when the user wants to connect an org, check or fix their AI setup, or prepare a demo. The UI's session link goes to the browser only; you never see it.",
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
      title: "Project and AXL workshop settings",
      description:
        "Project folders and AXL (AI Agent eXperience Lab) workshops the user manages on the Projects page of the gctk UI. Pass folder = your Cursor workspace to get that folder's project: the Genesys Cloud org its tools work on and which Genesys tools gctk starts there; for an AXL workshop also the folder's sessions (axl-sessions/), whether Cursor started the ava-harness, and the sessions' artifacts. Without folder: the list. Call it before you build in a folder and tell the user which org you are about to change. Read-only.",
      inputSchema: { folder: z.string().max(1000).optional().describe("absolute path of the Cursor workspace the lab runs in") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ folder }) => guarded(async () => formatAxlStatus(axlStatus(), folder)),
  );

  server.registerTool(
    "gc_ai_setup",
    {
      title: "Cursor's MCP servers",
      description:
        "The MCP servers Cursor loads: ~/.cursor/mcp.json (every folder), Cursor plugins, and the .cursor/mcp.json of the folders Cursor knows. For each server: file, command, how it gets its Genesys credentials (plain text in the file, keychain, gctk orgs, a gctk project) and which gctk org its OAuth client belongs to; problems such as plain-text secrets, the same secret in several files and missing commands. Secrets are always masked. Use it when the user asks which MCP server works on which org, where credentials are, or why a server does not start. Read-only: fixes (moving a secret to the keychain, another org, removing an entry) are pressed by the user on the Cursor setup page (gc_ui page ai-setup); a folder's own org and tools are set on the Projects page (gc_ui page axl).",
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
