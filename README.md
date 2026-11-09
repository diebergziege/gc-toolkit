# Genesys Cloud Toolkit (`gctk`)

A local web UI that makes your AI setup and your Genesys Cloud demos transparent and easy, also for
non-technical users. It runs on your computer, opens from Cursor, Claude Code, the Claude app or
its own app icon, and needs no AI itself. You do not need Cursor: see
[Without Cursor](#without-cursor-install-gctk-on-your-computer).

## Download

gctk installs itself, Node.js included: nothing to install first, no admin rights.

**gctk** (every page):

[![Install on Mac](https://img.shields.io/badge/Install-Mac-ff4f1f?style=for-the-badge)](#mac)
[![Download for Windows](https://img.shields.io/badge/Download-Windows-ff4f1f?style=for-the-badge)](https://github.com/diebergziege/gc-toolkit/releases/latest/download/gctk-windows.zip)

**gctk Partner** (only the [Partner page](#for-partner-managers-gctk-partner), for partner managers):

[![Install gctk Partner on Mac](https://img.shields.io/badge/gctk_Partner-Mac-2a60c8?style=for-the-badge)](#mac)
[![Download gctk Partner for Windows](https://img.shields.io/badge/gctk_Partner-Windows-2a60c8?style=for-the-badge)](https://github.com/diebergziege/gc-toolkit/releases/latest/download/gctk-partner-windows.zip)

### Mac

1. Open **Terminal**: press **⌘ Space**, type `Terminal` and press **Return**.
2. Copy the line for what you want (the copy button is at the right end of the box), paste it into
   Terminal with **⌘ V** and press **Return**.

   **gctk:**

   ```sh
   curl -fsSL https://github.com/diebergziege/gc-toolkit/releases/latest/download/install.sh | sh
   ```

   **gctk Partner:**

   ```sh
   curl -fsSL https://github.com/diebergziege/gc-toolkit/releases/latest/download/install.sh | sh -s -- --partner
   ```

3. Terminal shows the progress for a minute or two, then gctk opens in your browser. Close
   Terminal. From now on, open **gctk** (or **gctk Partner**) from Launchpad or Spotlight.

<details>
<summary>Rather download a file to double-click?</summary>

Download [gctk for Mac](https://github.com/diebergziege/gc-toolkit/releases/latest/download/gctk-mac.zip)
or [gctk Partner for Mac](https://github.com/diebergziege/gc-toolkit/releases/latest/download/gctk-partner-mac.zip)
and double-click **Install gctk** (or **Install gctk Partner**) in Downloads. The Mac then says
*Apple could not verify … is free of malware*, because the installer is not signed by a registered
Apple developer. Click **Done**, open **System Settings → Privacy & Security**, scroll down to the
message about the installer, click **Open Anyway**, enter your password, then **Open**. The pasted
line above does the same without this warning.

</details>

### Windows

1. Click the Windows button and open the downloaded zip.
2. Double-click **Install gctk** (or **Install gctk Partner**) in it.
3. If Windows says *Windows protected your PC*, click **More info → Run anyway**.
4. A window shows the progress for a minute or two, then gctk opens in your browser. Press a key to
   close the window. From now on, open **gctk** (or **gctk Partner**) from the Start menu or the
   Desktop.

On Windows, gctk cannot keep org credentials yet (it has no Windows keychain), so the pages that
work on an org need a Mac for now; gctk Partner needs no org and works fully.

### What the installer does

It puts its own Node.js into `~/.config/gctk/node/` (whatever Node.js the computer has stays
untouched), then installs gctk as [Without Cursor](#without-cursor-install-gctk-on-your-computer)
describes. Updates come with one click in gctk's top bar; running the installer again repairs
everything. It needs internet access to nodejs.org and github.com.

## What gctk does

- **Orgs**: connect a Genesys Cloud org (name, region, tier, OAuth client). The client secret goes
  straight into the OS keychain, never into a file or the chat. Each org shows the start of its
  OAuth client ID (never the secret); **OAuth clients not in gctk yet** lists the MCP servers that bring
  their own OAuth client, each one click away from becoming an org or being linked to one. Deleting an org lists what would
  stop working. Pick the org you work on by default
- **AI Coding Tools**: one page for Cursor and the Claude app. It starts with what needs your
  attention, then shows which org each MCP server works on (by app or by org) and the MCP servers available
  for projects, where **Add MCP server** adds your own (for example Architect: how it starts, which
  variables take the org's client ID, secret and region, which org tiers it may work on; never a secret),
  optionally also into Cursor and the Claude app on an org you choose; every file and entry is under **More**. The Claude app shows only where it is installed. For Cursor: the MCP servers it loads in every folder (`~/.cursor/mcp.json` and Cursor
  plugins), which gctk org each Genesys server's OAuth client belongs to, and whether it can start.
  The **Orgs** page is the one place for OAuth credentials: a server is linked to an org and takes
  client ID, secret and region from there at every start, so a rotated secret is entered once.
  **Versions** shows when a newer AVA harness (ava-mcp) or gctk is out and updates it with one click
  (ava-mcp with uv, together with the AVA skills in Cursor; gctk by deleting the copy npx keeps, so
  Cursor downloads the newest at its next start).
  When a newer gctk is out, the top bar says so on every page (**Update gctk to …**) and explains how
  to get it for the way you installed it (a click for Cursor without the plugin).
  A plain-text secret in a config file becomes an org (or is linked to the org with the same OAuth
  client) with one click; **Use another org** switches a server to another of your orgs. Flags
  entries that cannot start, or only start on this computer, and repairs them. Folders with their own `.cursor/mcp.json` are listed, each one click away from
  becoming a project. Secrets are never shown
- For the **Claude app**: the same for the MCP servers it loads in every chat and Cowork session
  (`claude_desktop_config.json`): org, status and the same fixes. The app has no folders of its own,
  so its AVA harness works on one org you choose like Cursor's (**Change org**; credentials from
  the keychain at every start, no secret in the file). Skills for Cowork are uploaded in the Claude app itself (Settings → Capabilities): **Skills
  for Cowork** zips the AVA skills and the lab facilitator for that, and shows which ones changed
  since your last zips (for example after an AVA harness update)
- **Demos**: deploy a whole demo into another org with one button. The demos ship with gctk
  (`demos/`, first: **Lumea Energie & Smart Home**), so anyone with the plugin can
  deploy them. A package is `demo.yaml` (what belongs to it,
  parameters such as the phone that plays the customer, prerequisites, manual steps, what runs on
  this computer) and `snapshot.json`; **Take snapshot** (only for whoever maintains the demo; the source org is a
  setting on their computer, never part of the package) reads the objects from the source org, **Deploy** creates them in the chosen org in the
  right order, once per org: the org itself records the deployment, so every colleague's gctk sees it,
  joins it as a presenter (each with their own customer: a name unique in the org, their demo phone and mailbox) or updates it instead of deploying it again (queues and wrap-up codes, intents, workbins, work item schemas, worktypes, case
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
  telco) in English or German, with the customer's brand, colour and logo, the org's Genesys Web
  Messenger, and what a real site has: products with prices, customer reviews, news, a cookie banner,
  an EN/DE switch and a full footer. A live preview shows your choices. Served on its own local origin
- **Demo ready**: pick an org and an agent, and fill the agent's home screen with demo data section
  by section: coaching, learning, speech and text analytics, evaluations, the scorecard and a
  published WFM schedule. Existing objects are reused, a second press creates nothing twice, and
  **Clean up** removes or restores exactly what the page did. **Refresh dates** moves the demo data
  forward when it has aged. Changes happen as soon as you press a button
- **Projects**: a folder for each demo you build with the AI in Cursor, each with its own org. gctk gives the folder the MCP servers you pick: the AVA harness, which comes with gctk, and copies of the Genesys MCP servers you already have in Cursor or the Claude app, started with that org's credentials from the keychain, and shows everything Cursor loads there. **AXL** workshops are projects with the lab guide: several workshops,
  each with its own org (sandbox or dev) and folder. gctk gives that folder its own AVA harness
  server, started with the org's credentials from the keychain, checks the two skills a workshop
  needs (axl-lab-facilitator and axl-capsule) and installs them from their zip files, and lists the sessions with the
  artifacts they reached
- **Partner**: the **Enablement Radar**. Upload the Excel export of the Genesys Partner Demo Org
  Readiness Checklist (Microsoft Forms) and compare all partners at a glance, see which topics most
  partners need help with, or pick a partner and read every answer with its notes, grouped by
  channels, AI, agent and supervisor, and platform. **Dev orgs: CX3 → CX4**: upload the report of all
  partner DEV/LAB orgs (CSV or Excel) and see which partners already run on CX4 (GC4 Dev/Lab: part
  numbers GC-170-DEV-LABBUC, -LABBUP, -LABBUV) and who is still on CX3, partner by partner, org by
  org and by region. The files stay on this computer. Also on its own as
  [gctk Partner](#for-partner-managers-gctk-partner)
- **Pricing**: Genesys Cloud licences, add-ons, fair use and AI Experience tokens explained, with a
  link to Genesys' own page for every figure; use cases that combine them; a monthly cost calculator
  at list price; and **Live billing**, an org's real licences, token use per AI feature and fair use
  from Billing & Usage, broken down. Read-only; Live billing needs Billing > Subscription > View
- **Monitoring**: how many data actions, flows, data tables, queues, skills, roles, AI agents,
  Messenger deployments … an org has, next to the limits the org itself reports. Read-only

The plugin adds one MCP server with three tools, so the AI in your editor can open the UI and read
the setup: `gc_ui`, `gc_ai_setup` and `gc_axl`. It brings no skills and no hooks, and it gives the AI
no tools to read or change a Genesys Cloud org.

## For partner managers: gctk Partner

gctk Partner is gctk with only the Partner page: the Enablement Radar, without orgs, demos or AI
tools. It needs no Genesys Cloud org and no OAuth client. Install it with the
[gctk Partner download](#download); it shows up as **gctk Partner** in Launchpad (Mac) or the
Start menu (Windows).

1. Export the survey: in Microsoft Forms, open the Genesys Partner Demo Org Readiness Checklist →
   **Responses → Open results in Excel**, and save the file.
2. Open **gctk Partner** and drop the Excel file on the page (or **Choose Excel file…**).
3. Compare all partners, see which topics most need help, or pick one partner to read their answers.

The tab **Dev orgs: CX3 → CX4** works the same way with the report of all partner dev orgs (the
CSV or Excel export with Account Name, Part Number and Org ID): it shows who has upgraded to CX4
(GC4 Dev/Lab), who partly, and who is still on CX3. Upload a newer report to see the latest state.

The files stay on your computer (`~/.config/gctk/partner-radar.json`, `partner-dev-orgs.json`)
until you remove them. Installing the full gctk later (the other download, or
`gctk install --edition full`) turns gctk Partner into gctk; the survey stays.

## Install

The [downloads](#download) above are the easiest way. The ways below are for Cursor, Claude Code,
or a terminal.

You need **Node.js 22 or newer** for them. If `node --version` in a terminal says nothing or an older
version, install the LTS version from [nodejs.org](https://nodejs.org) (the normal installer for Mac
or Windows; it brings `npx` along). Nothing else: no git, no clone, no build.

Pick the way that fits you:

| You use | Install |
|---|---|
| Cursor | [one click](#cursor-one-click) or [the plugin](#cursor-as-a-plugin) |
| Claude Code | [the plugin](#claude-code-terminal) |
| No Cursor (the Claude app, or nothing) | [the download](#download), or [one command, then an app to click](#without-cursor-install-gctk-on-your-computer) |

### Cursor: one click

[![Add gctk to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=gctk&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImh0dHBzOi8vZ2l0aHViLmNvbS9kaWViZXJnemllZ2UvZ2MtdG9vbGtpdC9hcmNoaXZlL3JlZnMvaGVhZHMvbWFpbi50YXIuZ3oiLCJtY3AiXX0=)

1. Click the button, let your browser open Cursor, and confirm **Install**.
2. In Cursor, ask the AI: *"Open the gctk UI."*

It adds this entry to `~/.cursor/mcp.json`; you can also paste it there yourself:

```json
"gctk": {
  "command": "npx",
  "args": ["-y", "https://github.com/diebergziege/gc-toolkit/archive/refs/heads/main.tar.gz", "mcp"]
}
```

Cursor starts the newest gctk each time (a start takes a second or two; the first one needs
internet access to github.com). If Cursor says it cannot find `npx` although Node.js is installed,
restart Cursor, or use the full path from `which npx` as `command`.

### Cursor: as a plugin

If your Cursor admin allows plugins from GitHub: **Customize → Plugins** (Cursor Settings) → **From
GitHub Repository** → `https://github.com/diebergziege/gc-toolkit` → install **Genesys Cloud
Toolkit**, then reload the window. Updates come under Customize → Plugins. (Teams that block
third-party plugins use the button above.)

### Claude Code (terminal)

```bash
claude plugin marketplace add diebergziege/gc-toolkit
claude plugin install genesys-cloud-toolkit@genesys-cloud-toolkit
```

**Updates:** `/plugin` → Marketplaces → genesys-cloud-toolkit → Update, then restart Claude Code.

### Without Cursor: install gctk on your computer

For everyone without Cursor, for example with the Claude app or no AI tool at all.

**1. Node.js (once).** gctk runs on Node.js 22 or newer, which brings the `npx` command along. Open
a terminal (Mac: **Terminal**, in Applications → Utilities; Windows: **Command Prompt**, search for
`cmd` in the Start menu) and type `node --version`. If it says "command not found" (Mac), "is not
recognized" (Windows) or a version below `v22`, install the **LTS** version from
[nodejs.org](https://nodejs.org/en/download): the normal installer, click through it, then close the
terminal and open a new one. The installer asks for your computer's password; on a managed company
laptop without admin rights, get Node.js from your company's software portal (Self Service, Company
Portal) or ask IT. Nothing else: no git, no account, only internet access to github.com.

**2. gctk (once).** In that terminal, run:

```bash
npx -y "https://github.com/diebergziege/gc-toolkit/archive/refs/heads/main.tar.gz?install" install
```

(Copy it as it is: the `?install` in the link makes npx download the newest gctk even when it has
an older one from Cursor.)

It opens the gctk UI and sets up the rest:

| | Mac | Windows | Linux |
|---|---|---|---|
| gctk to click | **gctk** in your Applications folder (Spotlight, Launchpad; drag it to the Dock) | **gctk** in the Start menu and on the Desktop | **gctk** in the applications menu |
| `gctk` command | `~/.local/bin/gctk` | `%LOCALAPPDATA%\gctk\bin\gctk.cmd` | `~/.local/bin/gctk` |
| Claude app | gctk added to it, if it is installed: quit and reopen the app, then ask *"Open the gctk UI."* | same | (no Claude app) |

gctk itself lives in `~/.config/gctk/app/`. Clicking **gctk** starts the UI in the background and
opens it in your browser; nothing else needs a terminal after this.

- **Windows:** in PowerShell, `npx` may be blocked ("running scripts is disabled on this system").
  Use the Command Prompt (`cmd`), or type `npx.cmd` instead of `npx`.
- **Updates:** when a newer gctk is out, the top bar says **Update gctk to …**; one click downloads
  it, replaces the installed one and reloads the page. In a terminal: `gctk update`.
- **Remove:** `gctk uninstall` removes the app, the command, the PATH line and the Claude app entry.
  Your orgs and settings stay in `~/.config/gctk` (delete that folder to remove them too); the org
  credentials are in the keychain under `gctk`.
- Install with `--no-claude-app` to leave the Claude app alone. Running `install` again repairs
  everything (for example after a new Node.js version).
- `--edition partner` installs [gctk Partner](#for-partner-managers-gctk-partner) instead (the app
  **gctk Partner**, only the Partner page, nothing in the Claude app); `--edition full` switches back.

Only want to try it once, without installing anything? Run the same link with `ui` instead of
`install`.

Orgs, credentials, AXL workshops and Demo ready's records are kept across updates; the UI restarts
with the new version by itself.

## Quick start

1. **Create an OAuth client** in Genesys Cloud (Admin → OAuth, grant type Client Credentials) with a
   role that covers what you use: the Demo ready sections you fill, Monitoring's object counts, and
   for AXL what the AVA harness builds.
2. **Open gctk:** ask the AI in Cursor, Claude Code or the Claude app *"Open the gctk UI."*, or
   click the **gctk** app. It opens on the Orgs page. Enter name, region, tier and the client ID and
   secret there.
3. **Check Cursor:** open **AI Coding Tools** to see which MCP servers work on which org and move
   plain-text secrets into the keychain.
4. **Prepare the demo:** Website for the customer's side, Demo ready for the agent's home screen.

The UI runs in the background at `http://gctk.localhost:4285/`, shared by every AI session on this
computer. It keeps that address (when another program has the port, the next free one, which it then
keeps; **Your data** or `gctk ui --port <n>` change it), so you can bookmark it: the browser that once
opened the UI may open it again. It keeps running after
a session ends (it stops by itself after 12 idle hours, with **Stop UI** in the top bar, or
`gctk ui --stop`).

## Where gctk keeps your data

Everything stays on your computer. The UI page **Your data** shows each place with its size and an
Open button; this is the overview:

| Where | What |
|---|---|
| `~/.config/gctk/profiles/` | your orgs (name, region, tier; no secrets) |
| `~/.config/gctk/config.yaml` | the org you work on by default, the UI's port |
| `~/.config/gctk/mcp-launch.json`, `ai-setup.json`, `removed-skills/` | AI Coding Tools: servers started through gctk, added locations, skills an earlier gctk removed |
| `~/.config/gctk/demos/` | Demos: this computer's copy of each org's deployment (the org keeps the original in its data table "gctk demos"), logs |
| `~/.config/gctk/demo-sources.json` | Demos, maintainers only: which org a demo's snapshot is read from, texts replaced in it |
| `~/.config/gctk/demo-ready/` | Demo ready: every change it made, for Clean up |
| `~/.config/gctk/axl.json`, `harness-starts.json` | Projects and AXL workshops: org, folder, tools; when Cursor last started them |
| `~/.config/gctk/partner-radar.json` | Partner: the survey you uploaded last (partner names, contacts' email addresses, answers) |
| `~/.config/gctk/partner-dev-orgs.json` | Partner: the dev org report you uploaded last (partner names, org IDs, part numbers, regions, dates) |
| `~/.config/gctk/claude-app-skills/` | Claude app: the skill zips you upload in the app, and which version of each was zipped |
| `~/.config/gctk/app/`, `install.json` | gctk as `gctk install` put it here, and what it added outside this folder (command, app, Claude app entry) |
| `~/.config/gctk/node/` | the Node.js the [download](#download) brought along, which runs gctk |
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
- **AI Coding Tools** shows secrets only masked. A secret moved into the keychain is started through
  `gctk mcp-launch`, whose launch record is signed with a key from the keychain; an edited record or
  config cannot reuse the secret for another command.

## MCP tools

| Tool | Purpose |
|---|---|
| `gc_ui` | open a page of the UI in the user's browser (the session link never reaches the AI) |
| `gc_ai_setup` | the MCP servers of Cursor and the Claude app, which org each server uses, where its secret is (masked, read-only) |
| `gc_axl` | which org and MCP servers a project folder or AXL workshop has (read-only) |

## CLI

| Command | Purpose |
|---|---|
| `gctk ui [page] [--port <n>] [--no-open] [--stop] [--foreground]` | the local UI (background by default); pages: `profiles`, `ai-setup` (AI Coding Tools; `claude-app` opens it too), `demos`, `site`, `demo`, `axl`, `partner`, `pricing`, `monitoring`, `data` |
| `gctk install [--edition full\|partner] [--no-claude-app] [--no-open]` | install gctk for use without Cursor: a `gctk` command, an app to click, gctk in the Claude app (`partner`: gctk Partner) |
| `gctk update` / `gctk uninstall` | update that install from GitHub / remove what it added (orgs and settings stay) |
| `gctk profile add/list/show/use/remove` | manage orgs from a terminal |
| `gctk login [profile]` / `logout` | store or delete an org's credentials in the keychain (`--from-env` for CI) |
| `gctk mcp` | run the MCP server (stdio) |

Global option: `-p, --profile <name>`.

## Architecture

| Path | Contents |
|---|---|
| `src/core/` | profiles, keychain, Genesys Cloud client, Demos, Demo ready, pricing and live billing, monitoring, AXL, AI setup |
| `src/ui/` | local web UI (server + single-page app, no external assets, no AI) and the demo website |
| `src/mcp/server.ts` | the three MCP tools |
| `src/cli/` | `gctk` command |
| `.claude-plugin/`, `.mcp.json` | Claude Code plugin: manifest, MCP server |
| `.cursor-plugin/`, `mcp.json` | Cursor plugin: manifest, MCP server |
| `dist/gctk.js` | bundled CLI + server + UI; **committed**, because plugin installs do not run `npm install` |
| `installer/`, `scripts/installers.mjs` | the downloads: install scripts that bring Node.js; the workflow `installers.yml` publishes them as the GitHub release |

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
