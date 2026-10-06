# Genesys Cloud Toolkit (`gctk`)

A local web UI that makes your AI setup and your Genesys Cloud demos transparent and easy, also for
non-technical users. It runs on your computer, opens from Cursor or Claude Code, and needs no AI
itself.

- **Orgs**: connect a Genesys Cloud org (name, region, tier, OAuth client). The client secret goes
  straight into the OS keychain, never into a file or the chat. Pick the org you work on by default
- **Cursor setup**: the MCP servers Cursor loads in every folder (`~/.cursor/mcp.json` and Cursor
  plugins), which gctk org each Genesys server's OAuth client belongs to, and whether it can start.
  **Use another org** gives a server the credentials of one of your orgs, which stay in the
  keychain. Flags plain-text secrets, the same secret in several files and entries that cannot
  start; one click moves a plain-text secret into the keychain (the entry then starts through
  gctk), and back, or repairs an entry an update broke. A rotated secret is entered once for every
  server using it. Folders with their own `.cursor/mcp.json` are listed, each one click away from
  becoming a project. Secrets are never shown
- **Demos**: deploy a whole demo into another org with one button. The demos ship with gctk
  (`demos/`, first: **Vendor Battle**, Lumea Energie & Smart Home), so anyone with the plugin can
  deploy them. A package is `demo.yaml` (what belongs to it,
  parameters such as the phone that plays the customer, prerequisites, manual steps, what runs on
  this computer) and `snapshot.json`; **Take snapshot** (only for whoever maintains the demo; the source org is a
  setting on their computer, never part of the package) reads the objects from the source org, **Deploy** creates them in the chosen org in the
  right order (queues and wrap-up codes, intents, workbins, work item schemas, worktypes, case
  plans, contacts, knowledge bases, canned responses, checklists, NLU domains, agent scripts, the
  Copilot assistant, speech & text analytics, digital bot and inbound message flows), reusing what
  already has the name, and routes the WhatsApp number you pick to the demo's message flow. You pick how the customer writes: on a
  website of the demo company with Web Messenger (the deploy creates the Messenger configuration
  and deployment; works in every org) or via WhatsApp. **Remove**
  deletes exactly what it created and gives the number its previous flow back. What gctk cannot
  create (the WhatsApp integration itself, call routing, licences) is listed as a prerequisite and checked where possible. What runs on this
  computer starts and stops with a button: gctk itself serves the pages the agent scripts embed
  (with endpoints that create a case, send an SMS or find an email in the org) and answers Copilot's
  third-party action, with nothing to install
- **Website**: a fake website for the customer's industry (banking, insurance, retail, energy,
  telco; English or German) in their brand, colour and logo, with the org's Genesys Web Messenger on
  it, for the customer's side of the demo. Served on its own local origin
- **Demo ready**: pick an org and an agent, and fill the agent's home screen with demo data section
  by section: coaching, learning, speech and text analytics, evaluations, the scorecard and a
  published WFM schedule. Existing objects are reused, a second press creates nothing twice, and
  **Clean up** removes or restores exactly what the page did. **Refresh dates** moves the demo data
  forward when it has aged. Changes happen as soon as you press a button
- **Projects**: a folder for each demo you build with the AI in Cursor, each with its own org. gctk gives the folder the Genesys tools you pick (the AVA harness, and Genesys MCP servers copied from your own configs), started with that org's credentials from the keychain, and shows everything Cursor loads there. **AXL** workshops are projects with the lab guide: several workshops,
  each with its own org (sandbox or dev) and folder. gctk gives that folder its own AVA harness
  server, started with the org's credentials from the keychain, and lists the sessions with the
  artifacts they reached
- **Monitoring**: how many data actions, flows, data tables, queues, skills, roles, AI agents,
  Messenger deployments … an org has, next to the limits the org itself reports. Read-only

The plugin adds one MCP server with three tools, so the AI in your editor can open the UI and read
the setup: `gc_ui`, `gc_ai_setup` and `gc_axl`. It brings no skills and no hooks, and it gives the AI
no tools to read or change a Genesys Cloud org.

## Install

Requirements: Node.js 22 or newer (`node --version`) and Cursor or Claude Code. No clone, no build.

### Cursor

1. Open **Customize → Plugins** (Cursor Settings) and choose **From GitHub Repository**.
2. Enter `https://github.com/diebergziege/gc-toolkit` and install **Genesys Cloud Toolkit**.
3. Reload the window. Customize should now list the `gctk` MCP server.
4. **Updates:** update the plugin under Customize → Plugins. If no update is offered, remove it and
   add it again from the GitHub repository, then reload the window.

### Claude Code (terminal)

```bash
claude plugin marketplace add diebergziege/gc-toolkit
claude plugin install genesys-cloud-toolkit@genesys-cloud-toolkit
```

**Updates:** `/plugin` → Marketplaces → genesys-cloud-toolkit → Update, then restart Claude Code.

### Without an editor

```bash
npx -y github:diebergziege/gc-toolkit ui
```

Orgs, credentials, AXL workshops and Demo ready's records are kept across updates; the UI restarts
with the new version by itself.

## Quick start

1. **Create an OAuth client** in Genesys Cloud (Admin → OAuth, grant type Client Credentials) with a
   role that covers what you use: the Demo ready sections you fill, Monitoring's object counts, and
   for AXL what the AVA harness builds.
2. **Ask the AI** in Cursor or Claude Code: *"Open the gctk UI."* It opens on the Orgs page. Enter
   name, region, tier and the client ID and secret there.
3. **Check Cursor:** open **Cursor setup** to see which MCP servers work on which org and move
   plain-text secrets into the keychain.
4. **Prepare the demo:** Website for the customer's side, Demo ready for the agent's home screen.

The UI runs in the background, shared by every AI session on this computer, and keeps running after
a session ends (it stops by itself after 12 idle hours, with **Stop UI** in the top bar, or
`gctk ui --stop`).

## Where gctk keeps your data

Everything stays on your computer. The UI page **Your data** shows each place with its size and an
Open button; this is the overview:

| Where | What |
|---|---|
| `~/.config/gctk/profiles/` | your orgs (name, region, tier; no secrets) |
| `~/.config/gctk/config.yaml` | the org you work on by default |
| `~/.config/gctk/mcp-launch.json`, `ai-setup.json`, `removed-skills/` | Cursor setup: servers started through gctk, added locations, skills an earlier gctk removed |
| `~/.config/gctk/demos/` | Demos: what each deploy created per org (and your parameter values), logs |
| `~/.config/gctk/demo-sources.json` | Demos, maintainers only: which org a demo's snapshot is read from, texts replaced in it |
| `~/.config/gctk/demo-ready/` | Demo ready: every change it made, for Clean up |
| `~/.config/gctk/axl.json`, `harness-starts.json` | Projects and AXL workshops: org, folder, tools; when Cursor last started them |
| `~/.config/gctk/bin/` | a copy of gctk that the editor entries gctk writes start (survives plugin updates) |
| `~/.config/gctk/cache/` | website logos, staged schedule uploads (safe to delete) |
| OS keychain, service `gctk` | org client IDs and secrets, AI setup secrets, the signing key, the UI token |

`GCTK_HOME` moves the whole folder somewhere else.

## Security notes

- **Credentials** live in the OS keychain (macOS Keychain, Secret Service on Linux), bound to the
  region and tier they were entered for. Profile files (`~/.config/gctk/profiles/*.yaml`) hold no
  secrets.
- **The UI** listens on 127.0.0.1 only and needs a session token that travels in the URL fragment;
  it refuses other Host headers (DNS rebinding), cross-origin writes and non-JSON writes. The demo
  website runs on its own origin, so the Messenger script never sees the token.
- **Demo ready and AXL write to the org directly.** Use them with sandbox, dev or demo orgs; AXL
  accepts sandbox and dev orgs only. Clean up removes what Demo ready created.
- **Cursor setup** shows secrets only masked. A secret moved into the keychain is started through
  `gctk mcp-launch`, whose launch record is signed with a key from the keychain; an edited record or
  config cannot reuse the secret for another command.

## MCP tools

| Tool | Purpose |
|---|---|
| `gc_ui` | open a page of the UI in the user's browser (the session link never reaches the AI) |
| `gc_ai_setup` | Cursor's MCP servers, which org each server uses, where its secret is (masked, read-only) |
| `gc_axl` | which org and Genesys tools a project folder or AXL workshop has (read-only) |

## CLI

| Command | Purpose |
|---|---|
| `gctk ui [page] [--no-open] [--stop] [--foreground]` | the local UI (background by default); pages: `profiles`, `ai-setup`, `demos`, `site`, `demo`, `axl`, `monitoring` |
| `gctk profile add/list/show/use/remove` | manage orgs from a terminal |
| `gctk login [profile]` / `logout` | store or delete an org's credentials in the keychain (`--from-env` for CI) |
| `gctk mcp` | run the MCP server (stdio) |

Global option: `-p, --profile <name>`.

## Architecture

| Path | Contents |
|---|---|
| `src/core/` | profiles, keychain, Genesys Cloud client, Demos, Demo ready, monitoring, AXL, AI setup |
| `src/ui/` | local web UI (server + single-page app, no external assets, no AI) and the demo website |
| `src/mcp/server.ts` | the three MCP tools |
| `src/cli/` | `gctk` command |
| `.claude-plugin/`, `.mcp.json` | Claude Code plugin: manifest, MCP server |
| `.cursor-plugin/`, `mcp.json` | Cursor plugin: manifest, MCP server |
| `dist/gctk.js` | bundled CLI + server + UI; **committed**, because plugin installs do not run `npm install` |

## Development

```bash
npm install
npm run check        # typecheck + tests + build
npm run dev -- ui --foreground        # run the UI from source
```

Always run `npm run build` and commit `dist/gctk.js` together with source changes. Test the Claude
Code plugin locally with `claude --plugin-dir .`.

## License

MIT
