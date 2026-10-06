// Writes src/core/demo-permissions.ts: the permissions each part of a demo deploy needs, taken
// from the Genesys Cloud API spec (x-inin-requires-permissions) for the endpoints demos.ts and
// demo-local.ts call. Run after adding a type or an endpoint:
//   curl -sL -A gctk https://api.mypurecloud.de/api/v2/docs/swagger > /tmp/swagger.json
//   node scripts/demo-permissions.mjs /tmp/swagger.json
import fs from "node:fs";

const ENDPOINTS = {
  base: ["GET /api/v2/authorization/divisions", "GET /api/v2/users", "GET /api/v2/users/{}"],
  wrapupcode: ["GET /api/v2/routing/wrapupcodes", "POST /api/v2/routing/wrapupcodes", "DELETE /api/v2/routing/wrapupcodes/{}"],
  responselibrary: ["GET /api/v2/responsemanagement/libraries", "POST /api/v2/responsemanagement/libraries", "GET /api/v2/responsemanagement/responses", "POST /api/v2/responsemanagement/responses", "DELETE /api/v2/responsemanagement/responses/{}", "DELETE /api/v2/responsemanagement/libraries/{}"],
  queue: ["GET /api/v2/routing/queues", "POST /api/v2/routing/queues", "GET /api/v2/routing/queues/{}", "PUT /api/v2/routing/queues/{}", "POST /api/v2/routing/queues/{}/wrapupcodes", "POST /api/v2/routing/queues/{}/members", "DELETE /api/v2/routing/queues/{}"],
  intentcategory: ["GET /api/v2/intents/categories", "POST /api/v2/intents/categories", "DELETE /api/v2/intents/categories/{}"],
  customerintent: ["GET /api/v2/intents/customerintents", "POST /api/v2/intents/customerintents", "DELETE /api/v2/intents/customerintents/{}"],
  workbin: ["POST /api/v2/taskmanagement/workbins/query", "POST /api/v2/taskmanagement/workbins", "DELETE /api/v2/taskmanagement/workbins/{}"],
  workitemschema: ["GET /api/v2/taskmanagement/workitems/schemas", "POST /api/v2/taskmanagement/workitems/schemas", "GET /api/v2/taskmanagement/workitems/schemas/{}", "DELETE /api/v2/taskmanagement/workitems/schemas/{}"],
  worktype: ["POST /api/v2/taskmanagement/worktypes/query", "POST /api/v2/taskmanagement/worktypes", "POST /api/v2/taskmanagement/worktypes/{}/statuses", "PATCH /api/v2/taskmanagement/worktypes/{}/statuses/{}", "PATCH /api/v2/taskmanagement/worktypes/{}", "DELETE /api/v2/taskmanagement/worktypes/{}"],
  caseplan: ["GET /api/v2/casemanagement/caseplans", "POST /api/v2/casemanagement/caseplans", "GET /api/v2/casemanagement/caseplans/{}/versions/{}/stageplans", "GET /api/v2/casemanagement/caseplans/{}/versions/{}/stageplans/{}/stepplans", "PATCH /api/v2/casemanagement/caseplans/{}/stageplans/{}", "PATCH /api/v2/casemanagement/caseplans/{}/stageplans/{}/stepplans/{}", "POST /api/v2/casemanagement/caseplans/{}/publish", "DELETE /api/v2/casemanagement/caseplans/{}"],
  externalcontact: ["GET /api/v2/externalcontacts/contacts", "POST /api/v2/externalcontacts/contacts", "GET /api/v2/externalcontacts/contacts/{}", "PUT /api/v2/externalcontacts/contacts/{}", "DELETE /api/v2/externalcontacts/contacts/{}"],
  knowledgebase: ["GET /api/v2/knowledge/knowledgebases", "POST /api/v2/knowledge/knowledgebases", "POST /api/v2/knowledge/knowledgebases/{}/categories", "POST /api/v2/knowledge/knowledgebases/{}/documents", "POST /api/v2/knowledge/knowledgebases/{}/documents/{}/variations", "POST /api/v2/knowledge/knowledgebases/{}/documents/{}/versions", "DELETE /api/v2/knowledge/knowledgebases/{}"],
  agentchecklist: ["GET /api/v2/assistants/agentchecklists", "POST /api/v2/assistants/agentchecklists", "DELETE /api/v2/assistants/agentchecklists/{}"],
  nludomain: ["GET /api/v2/languageunderstanding/domains", "POST /api/v2/languageunderstanding/domains", "POST /api/v2/languageunderstanding/domains/{}/versions", "POST /api/v2/languageunderstanding/domains/{}/versions/{}/train", "GET /api/v2/languageunderstanding/domains/{}/versions/{}", "POST /api/v2/languageunderstanding/domains/{}/versions/{}/publish", "DELETE /api/v2/languageunderstanding/domains/{}"],
  script: ["GET /api/v2/scripts", "POST /api/v2/scripts", "GET /api/v2/scripts/{}/pages", "PUT /api/v2/scripts/{}/pages/{}", "POST /api/v2/scripts/{}/pages", "POST /api/v2/scripts/published", "DELETE /api/v2/scripts/{}"],
  assistant: ["GET /api/v2/assistants", "POST /api/v2/assistants", "PUT /api/v2/assistants/{}/copilot", "PUT /api/v2/assistants/{}/queues/{}", "DELETE /api/v2/assistants/{}"],
  statopic: ["GET /api/v2/speechandtextanalytics/topics", "POST /api/v2/speechandtextanalytics/topics", "POST /api/v2/speechandtextanalytics/topics/publishjobs", "DELETE /api/v2/speechandtextanalytics/topics/{}"],
  staprogram: ["GET /api/v2/speechandtextanalytics/programs", "POST /api/v2/speechandtextanalytics/programs", "PUT /api/v2/speechandtextanalytics/programs/{}/mappings", "POST /api/v2/speechandtextanalytics/programs/publishjobs", "DELETE /api/v2/speechandtextanalytics/programs/{}"],
  flow: ["GET /api/v2/flows", "POST /api/v2/flows/jobs", "GET /api/v2/flows/jobs/{}", "POST /api/v2/flows/export/jobs", "GET /api/v2/flows/export/jobs/{}", "DELETE /api/v2/flows/{}"],
  messengerconfig: ["GET /api/v2/webdeployments/configurations", "POST /api/v2/webdeployments/configurations", "POST /api/v2/webdeployments/configurations/{}/versions/draft/publish", "GET /api/v2/webdeployments/configurations/{}/versions", "DELETE /api/v2/webdeployments/configurations/{}"],
  messengerdeployment: ["GET /api/v2/webdeployments/deployments", "POST /api/v2/webdeployments/deployments", "GET /api/v2/webdeployments/deployments/{}", "DELETE /api/v2/webdeployments/deployments/{}"],
  whatsapp: ["GET /api/v2/conversations/messaging/integrations/whatsapp", "GET /api/v2/conversations/messaging/integrations/whatsapp/{}", "GET /api/v2/routing/message/recipients/{}", "PUT /api/v2/routing/message/recipients/{}"],
  "local:request:/api/v2/casemanagement/cases": ["POST /api/v2/casemanagement/cases"],
  "local:request:/api/v2/conversations/messages/agentless": ["POST /api/v2/conversations/messages/agentless"],
  "local:latestEmail": ["POST /api/v2/analytics/conversations/details/query"],
  "local:copilot": ["POST /api/v2/notifications/channels", "POST /api/v2/notifications/channels/{}/subscriptions", "PATCH /api/v2/conversations/{}/suggestions/{}"],
};

// Endpoints that work but are missing from the public spec, with the role permission they need.
const UNDOCUMENTED = {
  "POST /api/v2/scripts": ["scripter:script:add"],
  "PUT /api/v2/scripts/{}/pages/{}": ["scripter:script:edit"],
  "POST /api/v2/scripts/{}/pages": ["scripter:script:edit"],
  "DELETE /api/v2/scripts/{}": ["scripter:script:delete"],
};

const spec = JSON.parse(fs.readFileSync(process.argv[2] ?? "/tmp/swagger.json", "utf8"));
const byShape = new Map(Object.entries(spec.paths).map(([p, ops]) => [p.replace(/\{[^}]+\}/g, "{}"), ops]));
const out = {};
const missing = [];
for (const [part, list] of Object.entries(ENDPOINTS)) {
  const perms = new Set();
  for (const e of list) {
    const [method, p] = e.split(" ");
    const op = byShape.get(p)?.[method.toLowerCase()];
    if (!op && !UNDOCUMENTED[e]) missing.push(e);
    const req = op?.["x-inin-requires-permissions"] ?? { type: "ALL", permissions: UNDOCUMENTED[e] ?? [] };
    // "ANY" means one of them is enough: kept together as "a | b".
    if (req.type === "ANY" && req.permissions.length > 1) perms.add([...req.permissions].sort().join(" | "));
    else for (const x of req.permissions ?? []) perms.add(x);
  }
  // An alternative is moot when one of its permissions is required anyway.
  out[part] = [...perms].filter((x) => !x.includes(" | ") || !x.split(" | ").some((y) => perms.has(y))).sort();
}
if (missing.length) {
  console.error(`Not in the API spec:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
const body = Object.entries(out).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
fs.writeFileSync(
  "src/core/demo-permissions.ts",
  `// Generated by scripts/demo-permissions.mjs from the Genesys Cloud API spec (${new Date().toISOString().slice(0, 10)}). Do not edit.
/** Permissions per part of a demo deploy: "base", a type of demos.ts, "flow" (Architect flows), "whatsapp", and "local:…" (what runs during the demo). "a | b": one of them is enough. */
export const DEMO_PERMISSIONS: Record<string, string[]> = {
${body}
};
`,
);
console.log(`wrote src/core/demo-permissions.ts (${Object.keys(out).length} parts)`);
