/**
 * Genesys Cloud list prices, AI Experience token rates and fair use allocations (USD), for the UI
 * page "Pricing": what each licence contains, how licences and add-ons combine, how tokens are
 * counted, and a calculator. Every figure names the page it comes from (`doc`); update `PRICING_AS_OF`
 * together with the figures. Contracts differ from list prices: the page says so.
 */

export const PRICING_AS_OF = "2026-11-02";

export const DOCS = {
  pricing: { title: "Genesys Cloud CX pricing (genesys.com)", url: "https://www.genesys.com/pricing" },
  digital: { title: "Genesys Cloud CX Digital pricing (genesys.com)", url: "https://www.genesys.com/pricing/digital" },
  hub: { title: "Genesys Cloud pricing hub", url: "https://help.genesys.cloud/articles/genesys-cloud-pricing-hub/" },
  tokens: { title: "Genesys Cloud tokens-based pricing model", url: "https://help.genesys.cloud/articles/genesys-cloud-tokens-model/" },
  aiBilling: { title: "AI token billing", url: "https://help.genesys.cloud/articles/ai-token-billing/" },
  aiScenarios: { title: "AI resource consumption billing scenarios", url: "https://help.genesys.cloud/articles/virtual-agent-and-agentic-virtual-agent-billing-scenarios/" },
  fairUse: { title: "Genesys Cloud fair use policy", url: "https://help.genesys.cloud/articles/genesys-cloud-fair-use-policy/" },
  freeAllocation: { title: "Genesys Cloud free allocation per organization", url: "https://help.genesys.cloud/articles/genesys-cloud-free-allocation-per-organization/" },
  staLicence: { title: "What license do I need to use speech and text analytics?", url: "https://help.genesys.cloud/faqs/what-license-do-i-need-to-use-speech-and-text-analytics/" },
  usageReports: { title: "Download your usage reports", url: "https://help.genesys.cloud/articles/download-usage-reports/" },
  named: { title: "Named licensing model billing overview", url: "https://help.genesys.cloud/articles/named-licensing-model-billing-overview/" },
  concurrent: { title: "Concurrent licensing model billing overview", url: "https://help.genesys.cloud/articles/concurrent-licensing-model-billing-overview/" },
  hourly: { title: "Hourly licensing model billing overview", url: "https://help.genesys.cloud/articles/hourly-licensing-model-billing-overview/" },
  hourlyPrices: { title: "Hourly Interacting prices (PDF, Genesys Resource Center)", url: "https://help.mypurecloud.com/wp-content/uploads/2026/01/Hourly-Interacting-pricing.pdf" },
  pricingFaq: { title: "Pricing FAQ (genesys.com)", url: "https://www.genesys.com/en-gb/pricing/frequently-asked-questions" },
  billingApi: { title: "Contract and Billing API: new public endpoints (announcement)", url: "https://help.genesys.cloud/announcements/genesys-cloud/contract-and-billing-api-new-public-endpoints/" },
  concurrentCatalogue: { title: "Concurrent list prices in a reseller catalogue (Lumen, not Genesys)", url: "https://assets.lumen.com/is/content/Lumen/genesys-cloud-sled-pricing-catalogue" },
} as const;
export type DocId = keyof typeof DOCS;

export type LicenceModel = "named" | "concurrent";
export type LicenceId = "cx1" | "cx2" | "cx2d" | "cx3" | "cx3d" | "cx4" | "communicate";

export interface Licence {
  id: LicenceId;
  name: string;
  /** USD per user and month, annual commitment. */
  named: number;
  /** null: no public price. */
  concurrent: number | null;
  /** Hourly Interacting: USD per hour on interactions, month-to-month; null: none. */
  hourly: number | null;
  for: string;
  includes: string[];
  /** Features this licence covers that cost tokens on lower licences. */
  aiIncluded: string[];
  voice: boolean;
  digital: boolean;
  docs: DocId[];
  note?: string;
}

const CORE = ["Voice channel", "Call routing", "Speech-enabled IVR", "Outbound campaigns", "Analytics and reporting", "Unified communications", "Interaction and screen recording"];
const OMNI = ["Digital channels (web messaging, email, SMS, WhatsApp …)", "Omnichannel routing", "Quality assurance and compliance", "Knowledge"];
const WEM = ["Workforce management (forecasting and scheduling)", "Employee performance (gamification, coaching)", "Speech and text analytics"];

export const LICENCES: Licence[] = [
  { id: "cx1", name: "Genesys Cloud CX 1", named: 75, concurrent: 110, hourly: 1.8, for: "Teams that only handle phone calls", includes: CORE, aiIncluded: [], voice: true, digital: false, docs: ["pricing", "concurrentCatalogue", "hourlyPrices"],
    note: "Digital channels only with the CX 1 Digital Add-on II; WEM with the CX 1 WEM Add-on II." },
  { id: "cx2", name: "Genesys Cloud CX 2", named: 115, concurrent: 170, hourly: 2.76, for: "Phone plus chat, email and messaging, with quality checks of conversations", includes: [...CORE, ...OMNI], aiIncluded: [], voice: true, digital: true, docs: ["pricing", "concurrentCatalogue", "hourlyPrices"],
    note: "WEM for some users with the CX 2 WEM Add-on I." },
  { id: "cx3", name: "Genesys Cloud CX 3", named: 155, concurrent: 230, hourly: 3.72, for: "Everything in CX 2, plus shift planning (workforce management) and automatic analysis of every conversation", includes: [...CORE, ...OMNI, ...WEM], aiIncluded: ["Speech and text analytics"], voice: true, digital: true, docs: ["pricing", "staLicence", "concurrentCatalogue", "hourlyPrices"] },
  { id: "cx4", name: "Genesys Cloud CX 4", named: 240, concurrent: 360, hourly: 5.76, for: "Everything in CX 3, plus AI help for every agent (Agent Copilot) and monthly AI tokens", includes: [...CORE, ...OMNI, ...WEM, "Agent Copilot", "Journey management", "30 AI Experience tokens per named agent (39 per concurrent)"], aiIncluded: ["Speech and text analytics", "Agent Copilot", "Journey management"], voice: true, digital: true, docs: ["pricing", "hub", "fairUse", "concurrentCatalogue", "hourlyPrices"] },
  { id: "cx2d", name: "Genesys Cloud CX 2 Digital", named: 95, concurrent: 140, hourly: 2.28, for: "Like CX 2, but without phone calls: chat, email and messaging only", includes: OMNI, aiIncluded: [], voice: false, digital: true, docs: ["digital", "concurrentCatalogue", "hourlyPrices"] },
  { id: "cx3d", name: "Genesys Cloud CX 3 Digital", named: 135, concurrent: 200, hourly: 3.24, for: "Like CX 3, but without phone calls", includes: [...OMNI, "Workforce management (forecasting and scheduling)", "Employee performance"], aiIncluded: [], voice: false, digital: true, docs: ["digital", "concurrentCatalogue", "hourlyPrices"] },
  { id: "communicate", name: "Genesys Cloud Communicate", named: 12, concurrent: null, hourly: null, for: "Phone and chat for employees outside the contact centre (office staff, experts agents can call)", includes: ["Business telephony", "Collaboration", "Directory"], aiIncluded: [], voice: true, digital: false, docs: ["hub"],
    note: "Month-to-month price in the pricing hub; CX 1–4 users have Communicate already." },
];

export type AddOnId = "cx1Digital" | "wemCx1" | "wemCx2" | "journey" | "analytics" | "salesforce" | "servicenow" | "teams";
export interface AddOn {
  id: AddOnId;
  name: string;
  named: number;
  concurrent: number | null;
  hourly: number | null;
  /** Licences it may be added to (empty: any). */
  on: LicenceId[];
  what: string;
  docs: DocId[];
  oneTime?: { label: string; usd: number };
}

export const ADD_ONS: AddOn[] = [
  { id: "cx1Digital", name: "CX 1 Digital Add-on II", named: 55, concurrent: null, hourly: 1.32, on: ["cx1"], what: "Email, chat and all messaging channels for CX 1 users.", docs: ["hub"] },
  { id: "wemCx1", name: "CX 1 WEM Add-on II", named: 65, concurrent: 95, hourly: 1.56, on: ["cx1"], what: "CX 3-level WEM (forecasting, scheduling, quality, speech and text analytics) for some CX 1 users.", docs: ["hub", "staLicence"] },
  { id: "wemCx2", name: "CX 2 WEM Add-on I", named: 40, concurrent: 60, hourly: 0.96, on: ["cx2"], what: "CX 3-level WEM for some CX 2 users.", docs: ["hub", "staLicence"] },
  { id: "journey", name: "Journey Management", named: 30, concurrent: null, hourly: null, on: [], what: "Unify journey and interaction data, journey insights and orchestration. Included in CX 4.", docs: ["hub"] },
  { id: "analytics", name: "Genesys Cloud Analytics", named: 20, concurrent: 30, hourly: null, on: [], what: "Hosted analytics data warehouse with Tableau / Power BI accelerators (annual prepaid price).", docs: ["hub"], oneTime: { label: "Quickstart enablement (once)", usd: 40000 } },
  { id: "salesforce", name: "CX Cloud from Genesys and Salesforce", named: 25, concurrent: null, hourly: null, on: [], what: "Genesys Cloud inside Salesforce Service Cloud Voice.", docs: ["hub"] },
  { id: "servicenow", name: "Unified Experience from Genesys and ServiceNow", named: 25, concurrent: null, hourly: null, on: [], what: "Genesys Cloud inside ServiceNow customer service management.", docs: ["hub"] },
  { id: "teams", name: "Microsoft Teams integration", named: 5, concurrent: null, hourly: null, on: [], what: "Directory, presence and calls between Teams and Genesys Cloud.", docs: ["hub"] },
];

export const TOKEN_PRICE_USD = 1;
export const FREE_TOKENS = { named: 250, concurrent: 350 } as const;
export const CX4_TOKENS_PER_AGENT = { named: 30, concurrent: 39 } as const;

export type UsageId =
  | "voiceBotMinutes" | "digitalBotSessions" | "virtualAgentInteractions" | "agenticInteractions"
  | "copilotUsers" | "staUsers" | "aiScoring" | "aiTranslate" | "aiSummaries" | "messages" | "social"
  | "predictiveRouting" | "gcCopilotActions";

export interface TokenRate {
  id: UsageId;
  name: string;
  /** What the user counts per month. */
  unit: string;
  /** Tokens for one unit; per user features have a concurrent rate. */
  tokensPerUnit: { named: number; concurrent: number };
  rate: string;
  note?: string;
  /** Licences that may use it at all (empty: any CX licence). */
  needsDigital?: boolean;
  docs: DocId[];
}

const same = (n: number) => ({ named: n, concurrent: n });
export const TOKEN_RATES: TokenRate[] = [
  { id: "voiceBotMinutes", name: "Bots (voice)", unit: "bot minutes", tokensPerUnit: same(1 / 17), rate: "17 minutes per token", note: "Each call is rounded up to the next 15 seconds.", docs: ["tokens"] },
  { id: "digitalBotSessions", name: "Bots (digital)", unit: "bot sessions", tokensPerUnit: same(1 / 51), rate: "51 sessions per token", needsDigital: true, docs: ["tokens"] },
  { id: "virtualAgentInteractions", name: "Virtual Agent", unit: "interactions", tokensPerUnit: same(0.5), rate: "0.5 tokens per interaction", note: "Counted once per interaction, at its highest AI tier.", docs: ["tokens", "aiScenarios"] },
  { id: "agenticInteractions", name: "Agentic Virtual Agent (AVA)", unit: "interactions", tokensPerUnit: same(1.2), rate: "1.2 tokens per interaction", note: "Charged as soon as the interaction visits a flow with an AVA block, even if the block does not run.", docs: ["tokens", "aiScenarios"] },
  { id: "copilotUsers", name: "Agent Copilot", unit: "users (not on CX 4)", tokensPerUnit: { named: 40, concurrent: 60 }, rate: "40 tokens per named user, 60 per concurrent user", note: "Included in CX 4. With Agent Copilot on, Supervisor Copilot summaries cost no tokens.", docs: ["tokens"] },
  { id: "staUsers", name: "Speech and text analytics", unit: "users (CX 1 / CX 2 without WEM add-on)", tokensPerUnit: { named: 30, concurrent: 45 }, rate: "30 tokens per named user, 45 per concurrent user", note: "Included in CX 3, CX 4 and the WEM add-ons.", docs: ["tokens", "staLicence"] },
  { id: "aiScoring", name: "AI Scoring", unit: "evaluations", tokensPerUnit: same(1 / 20), rate: "20 evaluations per token", needsDigital: true, docs: ["tokens"] },
  { id: "aiTranslate", name: "AI Translate", unit: "translations", tokensPerUnit: same(0.5), rate: "2 translations per token", docs: ["tokens"] },
  { id: "aiSummaries", name: "AI Summary and Insights", unit: "summaries (without Agent Copilot)", tokensPerUnit: same(1 / 50), rate: "50 summaries or insights per token", note: "Free when Agent Copilot is on.", docs: ["tokens"] },
  { id: "messages", name: "Third-party messaging (WhatsApp, Messenger, Instagram, Apple, X)", unit: "messages in and out", tokensPerUnit: same(1 / 400), rate: "400 messages per token", note: "WhatsApp's own Meta fees are passed through on top.", needsDigital: true, docs: ["tokens", "hub"] },
  { id: "social", name: "Social listening and post responses", unit: "posts ingested or answered (per channel)", tokensPerUnit: same(1 / 400), rate: "400 posts per channel per token", needsDigital: true, docs: ["tokens"] },
  { id: "predictiveRouting", name: "Predictive routing", unit: "routed interactions", tokensPerUnit: same(1 / 17), rate: "17 routed interactions per token", docs: ["tokens"] },
  { id: "gcCopilotActions", name: "Genesys Cloud Copilot", unit: "AI actions", tokensPerUnit: same(1 / 20), rate: "20 AI actions per token; knowledge queries free", docs: ["tokens"] },
];

/** What each AI feature does, in plain words. */
export const TOKEN_WHAT: Record<UsageId, string> = {
  voiceBotMinutes: "A rule-based bot that answers phone calls (\"Please say your meter number\").",
  digitalBotSessions: "The same kind of bot in chat or messaging.",
  virtualAgentInteractions: "A bot that understands free text with AI and answers from knowledge.",
  agenticInteractions: "An AI agent that decides the steps itself and uses tools, e.g. looks up and changes a booking.",
  copilotUsers: "AI next to a human agent: suggested answers, knowledge, after-call summaries.",
  staUsers: "Transcribes calls and finds topics, sentiment and compliance issues.",
  aiScoring: "AI fills in quality evaluation forms for supervisors.",
  aiTranslate: "Translates a conversation between the customer's and the agent's language.",
  aiSummaries: "AI summaries and insights for supervisors and quality.",
  messages: "Messages on WhatsApp, Facebook Messenger, Instagram, Apple Messages and X.",
  social: "Reading and answering public social media posts.",
  predictiveRouting: "AI picks the agent most likely to resolve the contact instead of the longest idle one.",
  gcCopilotActions: "An AI assistant for admins and supervisors inside Genesys Cloud.",
};

export type FairUseId = "ivr" | "storage" | "api" | "byoc";
export interface FairUse {
  id: FairUseId;
  name: string;
  unit: string;
  overageUsd: number;
  what: string;
  /** Allocation per user and month (pooled over the org), by licence; missing = none. */
  named: Partial<Record<LicenceId, number>>;
  concurrent: Partial<Record<LicenceId, number>>;
  docs: DocId[];
}

export const FAIR_USE: FairUse[] = [
  { id: "ivr", name: "Basic routing / IVR", unit: "minutes", overageUsd: 0.01, what: "Minutes callers spend in phone menus and call flows (including bots) before they reach a queue. Waiting in the queue does not count.", docs: ["fairUse"],
    named: { communicate: 500, cx1: 1750, cx2: 2500, cx3: 3250, cx4: 4250 }, concurrent: { cx1: 2275, cx2: 3250, cx3: 4225, cx4: 5525 } },
  { id: "storage", name: "Data storage", unit: "GB", overageUsd: 0.25, what: "Recordings (calls, screens), attachments and other stored data. Shorter retention policies keep it down.", docs: ["fairUse"],
    named: { communicate: 5, cx1: 17.5, cx2: 25, cx2d: 8, cx3: 32.5, cx3d: 15, cx4: 42.5 }, concurrent: { cx1: 22.75, cx2: 32.5, cx2d: 10, cx3: 42.25, cx3d: 20, cx4: 55.25 } },
  { id: "api", name: "API requests", unit: "requests", overageUsd: 0.0001, what: "Calls that integrations, data actions and scripts make to Genesys Cloud's API.", docs: ["fairUse"],
    named: { communicate: 10000, cx1: 75000, cx2: 110000, cx2d: 110000, cx3: 140000, cx3d: 140000, cx4: 180000 }, concurrent: { cx1: 97500, cx2: 143000, cx2d: 143000, cx3: 182000, cx3d: 182000, cx4: 234000 } },
  { id: "byoc", name: "BYOC Cloud", unit: "minutes", overageUsd: 0.0012, what: "Call minutes over the customer's own phone carrier connected in the cloud (bring your own carrier).", docs: ["fairUse"],
    named: { communicate: 1000, cx1: 5000, cx2: 5000, cx3: 5000, cx4: 5000 }, concurrent: { cx1: 6500, cx2: 6500, cx3: 6500, cx4: 6500 } },
];

/** The big picture in plain words; the "Start here" tab. */
export const BASICS: Array<{ title: string; text: string }> = [
  { title: "1. Every user needs a licence, and the org picks one level", text: "A licence is a monthly subscription for one person. It decides which parts of Genesys Cloud that person may use. There are levels from CX 1 (phone only, cheapest) to CX 4 (everything, with AI help), and an org chooses one level for all its agents: you cannot mix CX 1 and CX 3 in one org. Think of it like a company phone plan: everyone gets the same plan, and the bigger the plan, the more is included." },
  { title: "2. The org chooses how users are counted", text: "Genesys can count everyone who logs in during the month (named), or only the most people logged in at the same moment (concurrent). Occasional users can be paid by the hour. The Licence models tab explains this with examples." },
  { title: "3. Add-ons upgrade some users", text: "Because everyone has the same licence, add-ons are how only some users get more: a feature package for just the users who need it, for example workforce management for one team on CX 2." },
  { title: "4. Everyday usage is included up to a limit", text: "Each licence comes with an allowance of things like IVR minutes, storage and API calls (called fair use). The allowances of all users are added up into one pool for the org. Only if the org uses more than the pool does it pay extra." },
  { title: "5. AI is paid with tokens", text: "Most AI features (bots, virtual agents, Agent Copilot, AI summaries …) are paid with AI Experience tokens, a kind of prepaid credit. One token costs 1 USD at list price. Every org gets some tokens free each month; using more costs extra. The AI tokens tab shows what each feature costs." },
  { title: "6. Some things are billed separately", text: "Phone calls and phone numbers, SMS, WhatsApp's own fees and some speech services have their own price lists. They are not part of licences or tokens." },
];

export interface LicenceModelInfo {
  id: "named" | "concurrent" | "hourlyInteracting" | "hourlyLoggedIn";
  name: string;
  counts: string;
  example: string;
  fits: string;
  watch: string;
  docs: DocId[];
}
/** How Genesys counts billable users; the "Licence models" tab. */
export const LICENCE_MODELS: LicenceModelInfo[] = [
  { id: "named", name: "Named", counts: "Every person who logs in at least once during the billing month counts as one user, no matter whether they work one hour or the whole month.",
    example: "A team of 100 agents who all log in during the month = 100 named users, even if only 60 ever work at the same time.",
    fits: "Office-hours teams where nearly everyone works at the same time, every day. It has the lowest price per user.",
    watch: "A temp who logs in once for training counts for the whole month. Users who no longer work there should lose their licence (or be deactivated) so they are not counted.",
    docs: ["named", "pricing"] },
  { id: "concurrent", name: "Concurrent", counts: "Genesys looks for the moment in the month when the most people were logged in at the same time, and you pay for that number. Peaks shorter than 30 minutes are ignored, so shift changes do not count twice.",
    example: "300 agents work in three shifts; at most 120 are logged in at once. You pay for 120 concurrent users, not 300.",
    fits: "Shift work and 24/7 operations, where many more people work in total than at any one time. A concurrent user costs about 1.5 times a named user, so it pays off when roughly more than 1.5 people share each seat.",
    watch: "It applies to the whole org: you cannot mix named and concurrent. One busy hour (a storm, an outage, a campaign) sets the price for the whole month.",
    docs: ["concurrent", "pricingFaq", "concurrentCatalogue"] },
  { id: "hourlyInteracting", name: "Hourly Interacting", counts: "Only the time a user actually spends on interactions (routing status Interacting or Communicating) is charged, per hour. Emails and messages are counted but not charged.",
    example: "Back-office staff who take overflow calls for 10 hours a month pay for those 10 hours instead of a full monthly licence.",
    fits: "Occasional or seasonal agents, alongside a named or concurrent plan for the core team. It is included for new customers and at renewal. Prices go from 1.80 USD an hour (CX 1) to 5.76 USD (CX 4). Below about 42 interaction hours a month it is cheaper than a named licence.",
    watch: "Users with supervisor or admin permissions cannot use it: they are billed as full monthly users. It is enabled per user with a role (Billing > User > hourlyInteracting). Hourly prices are month-to-month, without the discount an annual commitment gets.",
    docs: ["hourly", "hourlyPrices"] },
  { id: "hourlyLoggedIn", name: "Hourly Logged In (older model)", counts: "All the time a user is logged in is charged per hour, whether they are busy or not.",
    example: "An agent logged in 160 hours a month pays for 160 hours.",
    fits: "Only orgs that already have it; it is a legacy model.",
    watch: "It cannot be combined with named or concurrent, and it counts everyone, including supervisors and admins. Orgs on it cannot use Hourly Interacting.",
    docs: ["hourly"] },
];

export const GLOSSARY: Array<[string, string]> = [
  ["Licence", "A monthly subscription for one user that decides which features they may use (CX 1, CX 2, CX 3, CX 4, or a Digital licence)."],
  ["Add-on", "An extra package for some users on top of their licence, for example workforce management."],
  ["Named / concurrent", "How users are counted: everyone who logged in during the month, or the most logged in at the same time."],
  ["Commitment (prepay)", "The number of licences or tokens a contract buys in advance, usually at a better price. Using more than that is billed as overage."],
  ["Overage", "Use above what is included or committed, charged at a listed price."],
  ["Fair use", "Allowances that come with each licence (IVR minutes, storage, API requests …), pooled over the whole org."],
  ["AI Experience token", "Genesys' credit for AI features. Not the same as the tokens of a language model. 1 USD each at list price."],
  ["Free allocation", "Tokens every org gets each month without paying: 250, or 350 for concurrent orgs. Unused ones expire."],
  ["Interaction", "One customer contact through one channel, such as a call or a chat, from start until it ends, is transferred to an agent or times out."],
  ["Bot flow", "A scripted, rule-based bot that asks questions and follows set paths."],
  ["Virtual Agent", "A bot that understands free text using AI, with guides and knowledge."],
  ["Agentic Virtual Agent (AVA)", "An AI agent that works out the steps itself and can use tools (data actions) to complete a task."],
  ["Agent Copilot", "AI that helps human agents during the conversation: suggested answers, knowledge, summaries."],
  ["WEM", "Workforce engagement management: forecasting and scheduling, quality management, coaching, speech and text analytics."],
  ["Speech and text analytics", "Transcribes calls and analyses conversations for topics, sentiment and compliance."],
  ["IVR", "The phone menu (\"press 1 for …\") that answers calls before an agent does."],
  ["BYOC", "Bring your own carrier: the phone lines come from the customer's telecom provider instead of Genesys Cloud Voice."],
  ["Pass-through", "A third party's fee (for example Meta's for WhatsApp) that Genesys bills on without a markup."],
];

export interface Rule { title: string; text: string; example?: string; docs: DocId[] }
/** How licences, allowances and tokens behave; the "How it works" tab. */
export const RULES: Rule[] = [
  { title: "One licence tier for the whole org, add-ons for some users", text: "An org picks one contact-centre licence for all its agents: CX 1, CX 2, CX 3, CX 4, or one of the Digital ones. Genesys does not allow, say, 10 agents on CX 1 and 20 on CX 2. To give only some agents more, buy an add-on for them (Digital or WEM). Employees outside the contact centre can have the cheaper Communicate licence, and occasional agents can be hourly on the same tier.",
    example: "150 agents on CX 2; the 40 who are scheduled with workforce management also get the CX 2 WEM add-on, which costs less than moving all 150 to CX 3.", docs: ["pricingFaq", "hub"] },
  { title: "The bigger licence includes the smaller ones", text: "CX 2 has everything CX 1 has plus digital channels and quality management; CX 3 adds workforce management and analytics; CX 4 adds Agent Copilot, journey management and monthly tokens. A user is billed at the highest licence they had during the month.",
    example: "An agent moved from CX 2 to CX 3 on the 20th is billed as CX 3 for that month.", docs: ["pricing", "named"] },
  { title: "Allowances are pooled", text: "Each user brings their fair use allowance to a shared pool for the whole org. Busy and quiet users balance each other out; only the org's total above the pool costs extra. Unused allowance does not carry over to the next month.",
    example: "20 CX 3 users bring 20 × 3,250 = 65,000 IVR minutes. The org uses 70,000: 5,000 minutes above the pool × 0.01 USD = 50 USD.", docs: ["fairUse"] },
  { title: "Tokens are credits, not AI words", text: "An AI Experience token has nothing to do with the tokens of a language model. Genesys measures each AI feature in a natural unit (bot minutes, conversations, users) and converts it to tokens at a fixed published rate.",
    example: "17 minutes of voice bot = 1 token. 2 Virtual Agent conversations = 1 token. 1 Agent Copilot user for a month = 40 tokens.", docs: ["tokens", "aiBilling"] },
  { title: "Free tokens every month, use them or lose them", text: "Each org gets 250 free tokens a month (350 if it counts users concurrently). CX 4 adds 30 more per named agent (39 per concurrent). Tokens are counted per month and unused ones expire. Tokens bought in advance cost less than the 1 USD list price.",
    example: "An org with 50 CX 4 agents has 250 + 50 × 30 = 1,750 tokens before it pays anything for AI.", docs: ["freeAllocation", "hub"] },
  { title: "One conversation is charged once, at its most expensive AI", text: "If a conversation passes through a bot, then a Virtual Agent, then an AVA, Genesys does not add these up. It charges only the most expensive one used in that conversation.",
    example: "Bot + Virtual Agent = 0.5 tokens. Bot + AVA = 1.2 tokens. Bot only = billed by its minutes or sessions.", docs: ["aiScenarios"] },
  { title: "An AVA flow costs as soon as the call enters it", text: "Genesys charges the 1.2 tokens when a conversation enters a flow that contains an AVA block, even if that block is never reached. A big flow that only sometimes uses the AVA therefore charges every call at the AVA price.",
    example: "Put the AVA in its own bot flow and call it from the inbound flow only when needed.", docs: ["aiScenarios"] },
  { title: "Some AI is priced per user, like a licence", text: "Agent Copilot and speech and text analytics cost a fixed number of tokens per user each month, however much they are used. CX 4 already includes Copilot; CX 3 and the WEM add-ons include speech and text analytics.",
    example: "100 CX 3 agents with Copilot = 100 × 40 = 4,000 tokens every month.", docs: ["tokens", "staLicence"] },
  { title: "Calls, SMS and WhatsApp fees come on top", text: "Telephony from Genesys Cloud Voice, SMS, Meta's WhatsApp fees, text-to-speech and third-party bot or speech services (BYOT) have their own price lists. Messaging channels like WhatsApp also cost tokens for the messages themselves (400 per token).",
    example: "A WhatsApp conversation costs tokens for its messages plus Meta's fee, passed on without markup.", docs: ["hub"] },
  { title: "Where to see the real numbers", text: "In Genesys Cloud: Admin → Account → Subscription → Billing & Usage, plus downloadable usage reports per user and resource. The Live billing tab shows the same numbers, explained. A public billing API is announced but not available yet.",
    example: "Usage shows up about two days late; the invoice is what counts.", docs: ["usageReports", "billingApi"] },
];

export interface Insight { title: string; text: string }
/** Combination arithmetic from the list prices above (named, USD per user and month). */
export function insights(): Insight[] {
  const p = (id: LicenceId) => LICENCES.find((l) => l.id === id)!.named;
  const a = (id: AddOnId) => ADD_ONS.find((x) => x.id === id)!.named;
  const copilot = 40 * TOKEN_PRICE_USD;
  return [
    { title: "Workforce management for everyone? Then take CX 3", text: `CX 2 (${p("cx2")}) + the WEM add-on (${a("wemCx2")}) = ${p("cx2") + a("wemCx2")} USD, exactly the price of CX 3 (${p("cx3")}). So the add-on only saves money when just part of the team needs shift planning; for the whole team, CX 3 is simpler at the same price.` },
    { title: "Need chat on CX 1? CX 2 is cheaper", text: `CX 1 (${p("cx1")}) + the Digital add-on (${a("cx1Digital")}) = ${p("cx1") + a("cx1Digital")} USD. CX 2 costs ${p("cx2")} and includes digital channels plus quality management. Moving to CX 2 is cheaper and gives more.` },
    { title: "Copilot for all agents: CX 4 can be cheaper than CX 3", text: `CX 3 (${p("cx3")}) + Agent Copilot (40 tokens = ${copilot}) + Journey Management (${a("journey")}) = ${p("cx3") + copilot + a("journey")} USD per agent. CX 4 costs ${p("cx4")} and includes all three, plus 30 tokens per agent every month (worth ${30 * TOKEN_PRICE_USD} USD). If the customer wants Copilot and journeys anyway, CX 4 wins.` },
    { title: "An AI agent costs more per conversation than a Virtual Agent", text: "An Agentic Virtual Agent (AVA) conversation costs 1.2 tokens, a Virtual Agent conversation 0.5: 2.4 times as much. At 10,000 conversations a month that is 12,000 against 5,000 tokens. Use the AVA where it really does the work (changing bookings, multi-step tasks)." },
    { title: "Occasional agents: hourly up to about 42 hours a month", text: `Hourly Interacting costs ${LICENCES.filter((l) => l.hourly).map((l) => `${l.hourly} (${l.name.replace("Genesys Cloud ", "")})`).slice(0, 4).join(", ")} USD per hour on interactions. For every CX licence that equals the named price at about ${Math.round((p("cx1") / LICENCES[0]!.hourly!) * 10) / 10} hours a month: below that, hourly is cheaper; above it, a named licence is.` },
    { title: "Voice bots are cheap", text: "17 minutes of voicebot cost 1 token (1 USD at list). A typical 3-minute bot call costs about 0.18 tokens, around 18 cents, far less than an agent's time." },
  ];
}

export interface EstimateInput {
  model: LicenceModel;
  /** People per licence: everyone who logs in during the month. */
  seats: Partial<Record<LicenceId, number>>;
  /** Concurrent only: the share of those people logged in at the same time at the busiest moment (1 … 100). */
  peakPercent: number;
  /** Hourly Interacting: interaction hours a month per licence (users on top of the named or concurrent ones). */
  hourly: Partial<Record<LicenceId, number>>;
  addOns: Partial<Record<AddOnId, number>>;
  usage: Partial<Record<UsageId, number>>;
  fairUse: Partial<Record<FairUseId, number>>;
  /** USD per token above the free allocation (list 1; upfront contracts are lower). */
  tokenPrice: number;
}

export interface UseCase {
  id: string;
  title: string;
  customer: string;
  combination: string[];
  tokens: string;
  input: EstimateInput;
}

const preset = (p: Partial<EstimateInput>): EstimateInput => ({ model: "named", seats: {}, peakPercent: 100, hourly: {}, addOns: {}, usage: {}, fairUse: {}, tokenPrice: TOKEN_PRICE_USD, ...p });
export const USE_CASES: UseCase[] = [
  { id: "voice-bot", title: "Voice contact centre with a voicebot", customer: "Utility, 50 agents, 20,000 calls a month; a voicebot answers meter readings (6,000 calls, 3 minutes each).",
    combination: ["CX 1 for all agents: voice only, no digital channels needed.", "Bots (voice) in tokens: 18,000 minutes ÷ 17 ≈ 1,059 tokens, minus the 250 free."],
    tokens: "Cheap per call; the bill grows with bot minutes, so short, focused bot flows matter.",
    input: preset({ seats: { cx1: 50 }, usage: { voiceBotMinutes: 18000 } }) },
  { id: "omni-va", title: "Omnichannel service with a Virtual Agent on WhatsApp", customer: "Insurer, 80 agents; a Virtual Agent handles 15,000 claims-status chats; 60,000 WhatsApp messages a month.",
    combination: ["CX 2: voice and digital with quality assurance.", "Virtual Agent: 15,000 × 0.5 = 7,500 tokens.", "WhatsApp messages: 60,000 ÷ 400 = 150 tokens, plus Meta's own fees."],
    tokens: "The Virtual Agent dominates; messaging tokens are small.",
    input: preset({ seats: { cx2: 80 }, usage: { virtualAgentInteractions: 15000, messages: 60000 } }) },
  { id: "partial-wem", title: "WEM only for the team that is scheduled", customer: "Retailer, 150 agents on CX 2; 40 store-support agents need forecasting and scheduling.",
    combination: ["150 × CX 2, 40 of them with WEM Add-on I (CX 2 + add-on = the CX 3 price for those 40).", "Moving everyone to CX 3 would cost (150 − 40) × 40 = 4,400 USD more a month."],
    tokens: "No AI tokens needed; the 250 free tokens stay unused (they do not carry over).",
    input: preset({ seats: { cx2: 150 }, addOns: { wemCx2: 40 } }) },
  { id: "copilot-floor", title: "Agent Copilot for the whole floor: CX 3 + tokens or CX 4?", customer: "Bank, 100 agents on CX 3 who all get Agent Copilot.",
    combination: ["CX 3 + Copilot: 100 × 40 = 4,000 tokens a month.", "Compare with the preset 'CX 4' below: Copilot, Journey Management and 30 tokens per agent included."],
    tokens: "Per-user features cost the same every month, independent of volume.",
    input: preset({ seats: { cx3: 100 }, usage: { copilotUsers: 100 } }) },
  { id: "copilot-cx4", title: "The same floor on CX 4", customer: "Bank, 100 agents on CX 4.",
    combination: ["CX 4 includes Agent Copilot and Journey Management.", "100 × 30 = 3,000 extra tokens a month for other AI, on top of the 250 free."],
    tokens: "Use the included tokens for AI Scoring, summaries or bots.",
    input: preset({ seats: { cx4: 100 }, usage: { aiScoring: 20000 } }) },
  { id: "ava-first", title: "AI-first service with an Agentic Virtual Agent", customer: "Telco, 60 agents on CX 3; an AVA handles 20,000 interactions a month and hands over to agents.",
    combination: ["CX 3 for the agents.", "AVA: 20,000 × 1.2 = 24,000 tokens; bot steps in the same interaction are not charged again.", "Predictive routing for the hand-overs: 8,000 ÷ 17 ≈ 471 tokens."],
    tokens: "The largest line by far: prepaid tokens at a discount are worth negotiating.",
    input: preset({ seats: { cx3: 60 }, usage: { agenticInteractions: 20000, predictiveRouting: 8000 } }) },
  { id: "digital-only", title: "Digital-only team with bots and translation", customer: "E-commerce, 40 agents answering only chat and messaging, in many languages.",
    combination: ["CX 2 Digital: no voice, cheaper than CX 2.", "Digital bot: 30,000 sessions ÷ 51 ≈ 589 tokens.", "AI Translate: 2,000 translations ÷ 2 = 1,000 tokens; messaging 100,000 ÷ 400 = 250."],
    tokens: "Translation is the expensive AI per unit (0.5 tokens each).",
    input: preset({ seats: { cx2d: 40 }, usage: { digitalBotSessions: 30000, aiTranslate: 2000, messages: 100000 } }) },
];

export interface Line { group: "licences" | "addOns" | "tokens" | "fairUse"; label: string; qty: number; unit: string; unitPrice: number; monthly: number; note?: string }
export interface TokenRow { id: UsageId; label: string; amount: number; unit: string; tokens: number }
export interface Estimate {
  lines: Line[];
  tokens: { rows: TokenRow[]; total: number; free: number; cx4: number; allocation: number; billable: number; price: number; cost: number; unused: number };
  fairUse: Array<{ id: FairUseId; label: string; unit: string; allocation: number; used: number; overage: number; cost: number }>;
  oneTime: Array<{ label: string; usd: number }>;
  /** Agents billed: people (named) or the peak of them logged in at once (concurrent). */
  agents: number;
  /** Agents entered (people), whatever the model; perAgent divides by them. */
  people: number;
  monthly: number;
  perAgent: number | null;
  warnings: string[];
}

const MAX = 1e9;
const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(n, MAX) : 0;
};
function pickNums<K extends string>(src: unknown, ids: readonly K[]): Partial<Record<K, number>> {
  const o = src && typeof src === "object" ? (src as Record<string, unknown>) : {};
  const out: Partial<Record<K, number>> = {};
  for (const id of ids) if (num(o[id])) out[id] = num(o[id]);
  return out;
}

/** Input from the page (any JSON): unknown keys dropped, numbers clamped to 0 … 1e9. */
export function parseEstimateInput(body: unknown): EstimateInput {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const price = b.tokenPrice === undefined ? TOKEN_PRICE_USD : num(b.tokenPrice);
  return {
    model: b.model === "concurrent" ? "concurrent" : "named",
    seats: pickNums(b.seats, LICENCES.map((l) => l.id)),
    peakPercent: b.peakPercent === undefined ? 100 : Math.max(1, Math.min(100, Math.round(num(b.peakPercent)) || 1)),
    hourly: pickNums(b.hourly, LICENCES.filter((l) => l.hourly !== null).map((l) => l.id)),
    addOns: pickNums(b.addOns, ADD_ONS.map((a) => a.id)),
    usage: pickNums(b.usage, TOKEN_RATES.map((r) => r.id)),
    fairUse: pickNums(b.fairUse, FAIR_USE.map((f) => f.id)),
    tokenPrice: Math.min(price, 10),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Monthly list-price estimate for a licence mix and its AI usage. */
export function estimate(input: EstimateInput): Estimate {
  const m = input.model;
  const share = m === "concurrent" ? Math.max(1, Math.min(100, input.peakPercent ?? 100)) / 100 : 1;
  const atPeak = (people: number) => (share === 1 ? Math.floor(people) : Math.ceil(Math.floor(people) * share - 1e-9));
  const person = (id: LicenceId) => Math.floor(input.seats[id] ?? 0);
  const seat = (id: LicenceId) => atPeak(person(id));
  const warnings: string[] = [];
  const lines: Line[] = [];

  for (const l of LICENCES) {
    const qty = seat(l.id);
    if (!qty) continue;
    const price = m === "concurrent" ? l.concurrent ?? l.named : l.named;
    lines.push({ group: "licences", label: l.name, qty, unit: m === "concurrent" ? "concurrent users" : "named users", unitPrice: price, monthly: qty * price,
      note: m === "concurrent" && l.concurrent === null ? "No public concurrent price: named price used."
        : m === "concurrent" && share < 1 ? `${qty} of ${person(l.id)} people at the busiest moment.` : undefined });
  }
  for (const l of LICENCES) {
    const hours = input.hourly?.[l.id] ?? 0;
    if (!hours || l.hourly === null) continue;
    lines.push({ group: "licences", label: `${l.name} Hourly Interacting`, qty: hours, unit: "interaction hours", unitPrice: l.hourly, monthly: round2(hours * l.hourly), note: "Month-to-month price." });
  }
  const oneTime: Estimate["oneTime"] = [];
  for (const a of ADD_ONS) {
    const qty = atPeak(input.addOns[a.id] ?? 0);
    if (!qty) continue;
    const price = m === "concurrent" ? a.concurrent ?? a.named : a.named;
    lines.push({ group: "addOns", label: a.name, qty, unit: "users", unitPrice: price, monthly: qty * price,
      note: m === "concurrent" && a.concurrent === null ? "No public concurrent price: named price used." : undefined });
    if (a.on.length) {
      const base = a.on.reduce((s, id) => s + seat(id), 0);
      if (qty > base) warnings.push(`${a.name} is for ${a.on.map((id) => LICENCES.find((l) => l.id === id)!.name).join(" / ")} users, but only ${base} are in the mix.`);
    }
    if (a.id === "journey" && seat("cx4")) warnings.push("CX 4 includes Journey Management already: the add-on is only for users on other licences.");
    if (a.oneTime) oneTime.push({ label: `${a.name}: ${a.oneTime.label}`, usd: a.oneTime.usd });
  }

  const agents = LICENCES.filter((l) => l.id !== "communicate").reduce((s, l) => s + seat(l.id), 0);
  const tiers = [...new Set([...TIERS.filter((l) => person(l.id)), ...TIERS.filter((l) => input.hourly?.[l.id])].map((l) => l.name.replace("Genesys Cloud ", "")))];
  if (tiers.length > 1) warnings.push(`Genesys does not allow mixing licence tiers in one org (here: ${tiers.join(", ")}). Choose one tier for all agents and use add-ons for the ones who need more.`);
  const people = LICENCES.filter((l) => l.id !== "communicate").reduce((s, l) => s + person(l.id), 0);
  const digitalSeats = LICENCES.filter((l) => l.digital).reduce((s, l) => s + seat(l.id), 0) + Math.min(atPeak(input.addOns.cx1Digital ?? 0), seat("cx1"));
  const perUserIds: UsageId[] = ["copilotUsers", "staUsers"];
  const usage = (id: UsageId) => (perUserIds.includes(id) ? atPeak(input.usage[id] ?? 0) : input.usage[id] ?? 0);
  const rows: TokenRow[] = [];
  for (const r of TOKEN_RATES) {
    const amount = usage(r.id);
    if (!amount) continue;
    rows.push({ id: r.id, label: r.name, amount, unit: r.unit, tokens: amount * r.tokensPerUnit[m] });
    if (r.needsDigital && !digitalSeats) warnings.push(`${r.name} needs digital channels: add a licence with digital (CX 2 or higher, a Digital licence, or the CX 1 Digital add-on).`);
  }
  const cx4 = seat("cx4");
  const nonCx4 = agents - cx4;
  if (usage("copilotUsers") > nonCx4) warnings.push(`Agent Copilot users (${usage("copilotUsers")}) exceed the users not on CX 4 (${nonCx4}); CX 4 users have Copilot included.`);
  const staFree = seat("cx3") + seat("cx4") + atPeak(input.addOns.wemCx1 ?? 0) + atPeak(input.addOns.wemCx2 ?? 0);
  if (usage("staUsers") > Math.max(0, agents - staFree)) warnings.push(`Speech and text analytics users (${usage("staUsers")}) exceed the users without it included (${Math.max(0, agents - staFree)}: CX 3, CX 4 and WEM add-ons include it).`);
  if ((input.usage.copilotUsers ?? 0) > 0 && (input.usage.aiSummaries ?? 0) > 0) warnings.push("With Agent Copilot on, Supervisor Copilot summaries cost no tokens: count only summaries outside Copilot.");

  const raw = rows.reduce((s, r) => s + r.tokens, 0);
  const total = raw > 0 ? Math.ceil(raw - 1e-9) : 0;
  const free = agents || seat("communicate") || Object.values(input.hourly ?? {}).some(Boolean) ? FREE_TOKENS[m] : 0;
  const cx4Tokens = cx4 * CX4_TOKENS_PER_AGENT[m];
  const allocation = free + cx4Tokens;
  const billable = Math.max(0, total - allocation);
  const price = input.tokenPrice;
  const cost = round2(billable * price);
  if (billable) lines.push({ group: "tokens", label: "AI Experience tokens above the allocation", qty: billable, unit: "tokens", unitPrice: price, monthly: cost });

  const fairUse: Estimate["fairUse"] = [];
  for (const f of FAIR_USE) {
    const allocationF = LICENCES.reduce((s, l) => s + seat(l.id) * (f[m][l.id] ?? 0), 0);
    const used = input.fairUse[f.id] ?? 0;
    const overage = Math.max(0, used - allocationF);
    const costF = round2(overage * f.overageUsd);
    fairUse.push({ id: f.id, label: f.name, unit: f.unit, allocation: allocationF, used, overage, cost: costF });
    if (costF) lines.push({ group: "fairUse", label: `${f.name} above fair use`, qty: overage, unit: f.unit, unitPrice: f.overageUsd, monthly: costF });
  }

  const monthly = round2(lines.reduce((s, l) => s + l.monthly, 0));
  return {
    lines,
    tokens: { rows, total, free, cx4: cx4Tokens, allocation, billable, price, cost, unused: Math.max(0, allocation - total) },
    fairUse,
    oneTime,
    agents,
    people,
    monthly,
    perAgent: people ? round2(monthly / people) : null,
    warnings,
  };
}

/** The contact-centre tiers an org chooses one of (Communicate is for other employees). */
export const TIERS = LICENCES.filter((l) => l.id !== "communicate");

export interface TierOption {
  id: LicenceId;
  name: string;
  named: number;
  concurrent: number;
  /** What this tier cannot do that the entered use needs; null: fits. */
  missing: string | null;
}

/** The same people, hours, add-ons and AI use on every tier, so a beginner sees what the tier choice costs. */
export function tierOptions(input: EstimateInput): TierOption[] {
  const people = TIERS.reduce((s, l) => s + Math.floor(input.seats[l.id] ?? 0), 0);
  const hours = TIERS.reduce((s, l) => s + (input.hourly?.[l.id] ?? 0), 0);
  if (!people && !hours) return [];
  const needsDigital = TOKEN_RATES.some((r) => r.needsDigital && (input.usage[r.id] ?? 0) > 0);
  const needsVoice = (input.usage.voiceBotMinutes ?? 0) > 0 || (input.fairUse.ivr ?? 0) > 0;
  return TIERS.map((t) => {
    const addOns = Object.fromEntries(Object.entries(input.addOns).filter(([id]) => {
      const a = ADD_ONS.find((x) => x.id === id)!;
      return !a.on.length || a.on.includes(t.id);
    })) as EstimateInput["addOns"];
    const moved: EstimateInput = { ...input, seats: { [t.id]: people, communicate: input.seats.communicate ?? 0 }, hourly: hours ? { [t.id]: hours } : {}, addOns };
    const missing = needsDigital && !t.digital && !(addOns.cx1Digital ?? 0) ? "no chat, email or messaging (needs the CX 1 Digital add-on)"
      : needsVoice && !t.voice ? "no phone calls" : null;
    return { id: t.id, name: t.name, named: estimate({ ...moved, model: "named" }).monthly, concurrent: estimate({ ...moved, model: "concurrent" }).monthly, missing };
  });
}

export interface Comparison {
  named: Estimate;
  concurrent: Estimate;
  peakPercent: number;
  /** The cheaper model; named when both cost the same. */
  recommended: LicenceModel;
  /** Monthly difference between the two. */
  saving: number;
  /** Highest busiest-moment share at which concurrent still costs less than named (0: never). */
  breakEvenPercent: number;
  /** Why, in plain words. */
  reasons: string[];
  tiers: TierOption[];
}

/** Prices the same people both ways, so a beginner need not know which model fits. */
export function compareModels(input: EstimateInput): Comparison {
  const named = estimate({ ...input, model: "named" });
  const concurrent = estimate({ ...input, model: "concurrent" });
  const peakPercent = Math.max(1, Math.min(100, input.peakPercent ?? 100));
  let breakEvenPercent = 0;
  for (let p = 100; p >= 1; p--) {
    if (estimate({ ...input, model: "concurrent", peakPercent: p }).monthly < named.monthly) { breakEvenPercent = p; break; }
  }
  const recommended: LicenceModel = concurrent.monthly < named.monthly ? "concurrent" : "named";
  const saving = round2(Math.abs(named.monthly - concurrent.monthly));
  const reasons: string[] = [];
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (named.people) {
    reasons.push(`Named: you pay for all ${fmt(named.people)} people who log in during the month, at the lower price.`);
    reasons.push(`Concurrent: you pay only for the ${fmt(concurrent.agents)} working at the same time at the busiest moment (${peakPercent} %), but each costs about 1.5 times as much.`);
    reasons.push(breakEvenPercent
      ? `So concurrent is cheaper while at most ${breakEvenPercent} % of the people work at the same time. You entered ${peakPercent} %, so ${recommended} is cheaper${saving ? ` by ${fmt(saving)} USD a month` : ""}.`
      : "Here concurrent is never cheaper, even with few people at the same time.");
    reasons.push("Either model applies to the whole org: all users are named, or all are concurrent. Hourly agents can be added to both.");
  }
  return { named, concurrent, peakPercent, recommended, saving, breakEvenPercent, reasons, tiers: tierOptions(input) };
}

/** Everything the page shows; served as one JSON. */
export function pricingCatalog() {
  return {
    asOf: PRICING_AS_OF,
    currency: "USD",
    docs: DOCS,
    licences: LICENCES,
    addOns: ADD_ONS,
    tokenPrice: TOKEN_PRICE_USD,
    freeTokens: FREE_TOKENS,
    cx4Tokens: CX4_TOKENS_PER_AGENT,
    tokenRates: TOKEN_RATES.map((r) => ({ ...r, what: TOKEN_WHAT[r.id] })),
    fairUse: FAIR_USE,
    basics: BASICS,
    licenceModels: LICENCE_MODELS,
    glossary: GLOSSARY,
    rules: RULES,
    insights: insights(),
    useCases: USE_CASES,
  };
}
