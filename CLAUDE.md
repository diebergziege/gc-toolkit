# Genesys Cloud Toolkit: development notes

- Scope (maintainer decisions 2026-09-30 and 2026-10-01): gctk is a local UI that makes the user's AI
  setup and Genesys Cloud demos transparent and easy for non-technical users: Orgs, AI setup,
  Website, Demo ready, AXL, Monitoring. The UI runs no AI and depends on no coding assistant; do not
  add a page or route that starts an agent. The plugin ships no skills and no hooks, and its MCP
  server only opens the UI and reads the setup (`gc_ui`, `gc_ai_setup`, `gc_axl`); it gives the AI
  no tools to read or change an org. Removed on purpose: the Chat page, bot tests, AI agent briefs,
  journeys, agent scripts, preflight checks, policies, plans, approvals, the trust window, the audit
  log and the guard hooks. Tool descriptions must stand on their own and must not point to a skill.
- Credentials live in the OS keychain only (`src/core/credentials.ts`), bound to the profile's
  region and tier; profile files hold no secrets. Never log or return tokens or credentials.
- The UI (`src/ui/`) builds DOM from text nodes only. It listens on 127.0.0.1, needs the session
  token (URL fragment, keychain), refuses foreign Host headers, cross-origin and non-JSON writes.
- After source changes: `npm run check`, then commit `dist/gctk.js` with the change.
- The root `.mcp.json` is the Claude Code plugin's MCP config (Claude Code only loads plugin servers
  from a file with exactly that name). It uses `${CLAUDE_PLUGIN_ROOT}`, so do not approve it as a
  project server when working in this repo; test with `claude --plugin-dir .` instead.
- Two plugin formats share dist/ and src/: Claude (`.claude-plugin/`, `.mcp.json`) and Cursor
  (`.cursor-plugin/`, `mcp.json`). Keep versions in both manifests in sync.
- Tests use mocked fetch and a temporary `GCTK_HOME`; they never touch the keychain or a real org.
- Everything gctk stores is listed on the UI page "Your data" (`src/core/data-info.ts`): add a new file or
  folder in the gctk home there (and in the README table) when a feature starts writing one.
- Demo ready (`src/core/demo-ready.ts`, UI page "Demo ready"): one section per component for one
  agent. A section only reads the state and returns the next wave of requests; it reuses existing
  objects (matched by name) and never creates what already exists. The runner sends each wave as
  soon as the user pressed the button and records every request in `src/core/demo-log.ts`
  (`~/.config/gctk/demo-ready/`; applied Demo ready plans of versions before 0.23 are read too).
  Check each section's endpoints live in the maintainer's test org (named in `CLAUDE.local.md`). Everything a section
  creates or changes must be removable in Clean up: `demoInventory` reads it from the records (never
  from names, so reused objects are never deleted), and a change to an existing object carries its
  previous values in the record's `subject` (`demo-ready:before:{json}`). Name searches lag behind
  creates: check `createdInRun` before creating something again. The WFM schedule import
  (`…/schedules/import/uploadurl`, gzip JSON staged in the gctk cache) uploads to the returned
  presigned URL; its `contentLengthBytes` must equal the staged file's size. Refresh dates (section
  `refresh`) only moves what the page created (appointments via PATCH `dateStart`, learning via
  `…/assignments/{id}/reschedule`) by whole weeks and adds a schedule when the current week has none;
  its schedule imports count as section `schedule` in Clean up.
- Demos (`src/core/demos.ts`, UI page "Demos"): packages ship only in `demos/<id>/` (found next to
  `dist/` like the old examples; `GCTK_DEMOS_DIR` overrides). Users cannot add their own demos
  (maintainer decision 2026-10-01). Demos must be complete on their own:
  colleagues have only the plugin, never the source repository, so pages, texts and endpoints live
  in the package. `demo.yaml` names the objects; `takeSnapshot` (offered only where this computer has a
  snapshot source: `demo-sources.json` in the gctk home, set with the hidden `gctk demo-source <demo>
  <profile> --replace value=with`; the package never names the source org, a person or a division)
  reads them (and what they need) from the source org into `snapshot.json`, each
  source id replaced by `@{type:name}` (sub-objects
  `@{type:name#key}`; agent script page ids stay, the client chooses them). `deployDemo` walks the
  types in `TYPES` order, reuses objects with the same name, resolves the tokens to the target's
  ids and `@{param:…}` / `@{presenter.name}` to the values entered at deploy, records per org in `~/.config/gctk/demos/<id>/<profile>.json`, and deletes an object again
  when its create failed halfway; `removeDemo` deletes only what it created, newest first. Each type's
  create calls were checked against the API spec and run live (source org → test org,
  2026-10-01): knowledge bases need `contentSearchEnabled` at create (Copilot answer generation),
  step plans take `workitemSettings.worktypeId`, assistant queues need `id` in the body, flows go
  through Architect jobs (YAML, the division line replaced). Commands run detached in their own
  process group with `@{org.*}` and deployed tokens in their environment; `envOtherOrg` applies
  outside the snapshot source org (e.g. skip a preflight that knows the source's ids).
  Snapshots carry nobody's data: `parameters[].contact` puts the parameter into the contact's
  phone/WhatsApp/email fields and `replace` swaps source texts (a person's name) at snapshot time.
  The manifest's `local` part runs inside the UI process (`src/core/demo-local.ts`, command id
  `local`): a web server on 127.0.0.1 for the agent script pages (`@{…}` filled in served text
  files; endpoints `session`, `request` (org call with templated body/reply), `latestEmail`), and
  Copilot third-party answers (notification channel on the queues, PATCH of each open suggestion).
  It stops with the UI.
  `create` lists objects the package adds that the source org lacks (Vendor Battle: messenger
  configuration and deployment for its Lumea website); a new snapshot leaves them alone. `channels`
  is the customer channel the presenter picks at deploy (`web`, `whatsapp`); `create[].channel` and
  `messageRouting.channel` tie objects and routing to one. Web deployments accept only public
  domains in `allowedDomains`, so the localhost website needs `allowAllDomains`. Flows the demo
  created are re-imported on deploy only when the snapshot or the org's flow changed
  (`refreshed` hashes in the record: Architect rewrites some YAML on import).
  The Demos page lists the OAuth permissions a demo needs (`demoPermissions`), from
  `src/core/demo-permissions.ts`, generated by `scripts/demo-permissions.mjs` from the API spec: add
  a new type's endpoints there and regenerate. Script create/edit/delete are not in the public spec
  (`UNDOCUMENTED` in the script).
  A package may carry `story.yaml` (scenes: steps by who, triggers, notes); the page shows it as
  "Demo story" together with a trigger reference that `loadStory` builds from the snapshot (Copilot
  rules, NLU intents and phrases, checklist items, analytics topics), so the reference never drifts.
  Message routing (manifest `messageRouting.flow`): the deploy PUTs the chosen WhatsApp
  integration's recipient (`/api/v2/routing/message/recipients/{id}`) to the demo's message flow and
  records the flow it had before (kept across redeploys); Remove restores it before deleting flows.
- The demo website (`src/ui/site.ts`, UI page "Website") is served only on its own host
  `site.gctk.localhost` (page and logos, never the API), so the Genesys Messenger script never runs
  on the UI's origin. Every query value is escaped; logos are raster only (no SVG) and served
  sandboxed. The user only enters the deployment ID (and the region); the page reads nothing from
  the org and writes nothing to it.
- AI setup (`src/core/ai-setup.ts`, UI page "AI setup", MCP tool `gc_ai_setup`, hidden CLI
  `gctk mcp-launch`, decision 2026-10-01): reads the editors' MCP config files and skills; secrets
  leave the module only masked (page and tool). Fixes change the user's config files and exist only
  as UI routes (a click), never as MCP tools; plugin files and JSON with comments are never
  rewritten. "Move to keychain" stores the file's own secret (not a gctk profile's) and rewrites the
  entry to `gctk mcp-launch <id>`; the launch record (resolved command, arguments, variables, PATH,
  cwd, secret names) is signed with the key in `src/core/approval.ts`, and the child gets only the
  record's environment plus a short pass-through list (locale, proxies), never the config's `env`,
  so an edited config or record cannot reuse the secret. Keychain item, record and file change all
  succeed or are undone together. "Change credentials" (`setCredentials`) writes a new client ID,
  region or secret, typed in or taken from a gctk profile (its secret is read on the server, never sent
  to the browser); for a keychain-started server it re-signs the record and splits off a keychain item
  that other servers share, so only that server changes.
  Removing a skill (`removeSkill`) only takes the user's own or a project's skill, never a plugin's
  or a built-in one, and moves it (a link stays a link, its target is untouched) into
  `~/.config/gctk/removed-skills/`, from where `restoreSkill` puts it back.
- AXL workshops (`src/core/axl.ts`, UI page "AXL", MCP tool `gc_axl`, hidden CLI `gctk axl-harness`):
  the lab runs in the Cursor app (skill axl-lab-facilitator, AVA harness). The user keeps a list of
  workshops in the UI, each with its own org and folder. Saving a workshop's org or folder (or "Set
  up folder") writes the harness server into that folder's own `.cursor/mcp.json` (never the global
  one, never a secret); it runs `gctk axl-harness --workshop <id> --org <profile>` (only a workshop
  gctk knows, with exactly that org, is accepted), which starts `ava-mcp serve` with the profile's
  keychain credentials and habitat, and records the start in `harness-starts.json`. Maintainer
  decision 2026-09-29: gctk may hand these credentials to the harness, for sandbox and dev profiles
  only, checked again at every start. The habitat table is copied from ava-mcp 1.5.4 `config.py`.
