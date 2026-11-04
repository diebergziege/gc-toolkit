import { zip } from "../src/core/claude-skills.js";

/** Workbooks for the Enablement Radar tests (fictional partners). */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "&#xA;");
const col = (i: number) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : "") + String.fromCharCode(65 + (i % 26));

/** A workbook shaped like the Forms export: shared strings with the x: prefix, numbers for dates. */
export function xlsx(rows: Array<Array<string | number | null>>): Buffer {
  const strings: string[] = [];
  const sid = (s: string) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1);
  const sheetRows = rows.map((r, ri) => `<x:row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${col(ci)}${ri + 1}`;
    if (v === null) return `<x:c r="${ref}" s="10" t="s" />`;
    return typeof v === "number" ? `<x:c r="${ref}" s="2"><x:v>${v}</x:v></x:c>` : `<x:c r="${ref}" s="10" t="s"><x:v>${sid(v)}</x:v></x:c>`;
  }).join("")}</x:row>`).join("");
  const ns = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return zip([
    ["xl/workbook.xml", Buffer.from(`<?xml version="1.0"?><x:workbook ${ns}><x:sheets><x:sheet name="Sheet1" sheetId="1" r:id="rId1" /></x:sheets></x:workbook>`)],
    ["xl/_rels/workbook.xml.rels", Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="worksheet" Target="/xl/worksheets/data.xml" Id="rId1" /></Relationships>')],
    ["xl/sharedStrings.xml", Buffer.from(`<?xml version="1.0"?><x:sst ${ns}>${strings.map((s) => `<x:si><x:t xml:space="preserve">${esc(s)}</x:t></x:si>`).join("")}</x:sst>`)],
    ["xl/worksheets/data.xml", Buffer.from(`<?xml version="1.0"?><x:worksheet ${ns}><x:sheetData>${sheetRows}</x:sheetData></x:worksheet>`)],
  ]);
}

export const HEADER = [
  "ID", "Start time", "Completion time", "Email", "Name", "Partner Name", "Your Email address",
  "Do you currently have an active Genesys Cloud organization that you can use for customer demonstrations?",
  "Genesys Cloud Demo Org Name", "Genesys Cloud Region", "Select your current subscription option",
  "Is the Voice demo ready?\n\nDescription:\nTest number, inbound flow, routing to an agent, and recording should work reliably.\n",
  "Please describe what needs attention (Is the Voice demo ready?)",
  "Select TTS engine you are currently using",
  "Can the following Social Messaging be demonstrated with a meaningful use case in the demo org? (Select all that apply)",
  "Please describe how the selected channels can be demonstrated? If none, describe why you are not demonstrating them?2",
  "Is Journey Management ready to be demonstrated?\n\nDescription:\nThe demo should include a configured journey...",
  "Please describe what needs attention (Is Journey Management ready to be demonstrated?)",
  "Can a brand-new capability be demonstrated?",
];
export const ROWS = [
  [7, 46314.6, 46314.62, "anonymous", null, "Example Partner ", "anna@example.com", "Yes", "exampledemo", "Frankfurt", "GC3", "Needs Attention", "No SIP trunk & no number", "Genesys Native", "Facebook;Instagram;", null, "Ready", null, "Ready"],
  [8, 46315.1, 46315.5, "anonymous", null, "Other Partner", "ben@example.com", "No, need help!", null, null, null, null, null, null, "None;", "No accounts yet", null, null, null],
];
