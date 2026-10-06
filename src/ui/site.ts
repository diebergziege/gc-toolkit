import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../core/paths.js";
import { resolveRegion } from "../core/regions.js";
import { environmentFor } from "../core/regions.js";

/**
 * The demo website (UI page "Website"): a fake customer website for an industry, in the customer's
 * brand, with the org's Genesys Web Messenger on it. It is served on its own origin
 * (site.gctk.localhost), so the Messenger script never runs where the UI's session token lives.
 * Everything the user typed is escaped; the page has no secrets (a deployment id is public on any
 * real website).
 */

export const SITE_HOST = "site.gctk.localhost";
export const LANGS = ["en", "de"] as const;
export type Lang = (typeof LANGS)[number];

type Copy = {
  nav: string[];
  heroTitle: string;
  heroText: string;
  cta: string;
  cardTitle: string;
  cardLines: string[];
  topicsTitle: string;
  topics: Array<[icon: string, title: string, text: string]>;
  promoTitle: string;
  promoText: string;
  faq: Array<[q: string, a: string]>;
  hours: string;
};

export interface Industry {
  id: string;
  label: { en: string; de: string };
  brand: string;
  color: string;
  /** Shown in the hero card: a bank card, a policy, a parcel, a meter, a phone plan. */
  card: "card" | "policy" | "parcel" | "meter" | "plan";
  copy: Record<Lang, Copy>;
}

export const INDUSTRIES: Industry[] = [
  {
    id: "bank",
    label: { en: "Banking", de: "Bank" },
    brand: "Harbor Bank",
    color: "#0b3d5c",
    card: "card",
    copy: {
      en: {
        nav: ["Accounts", "Cards", "Loans", "Investing"],
        heroTitle: "Banking that fits into your day",
        heroText: "Open an account in ten minutes, pay with your phone and get help from real people whenever you need it.",
        cta: "Chat with us",
        cardTitle: "Everyday account",
        cardLines: ["No monthly fee", "Instant transfers", "Card controls in the app"],
        topicsTitle: "How can we help?",
        topics: [
          ["lock", "Block my card", "Card lost or stolen? Block it in seconds."],
          ["transfer", "Payments and transfers", "Limits, standing orders and SEPA transfers."],
          ["home", "Mortgages", "Find out what you can borrow for your new home."],
          ["chart", "Investing", "Funds and savings plans from 25 a month."],
          ["alert", "Unknown payment", "Dispute a payment you do not recognise."],
          ["user", "Personal details", "Change your address or phone number."],
        ],
        promoTitle: "New: instant loan decision",
        promoText: "Apply online and get a decision in minutes. Our advisers are there if you have questions.",
        faq: [
          ["What do I do if my card is lost?", "Block it right away in the app or in the chat. We send you a new card within three working days."],
          ["How long does a transfer take?", "Instant transfers arrive within seconds, standard transfers on the next working day."],
          ["Can I talk to an adviser?", "Yes. Start a chat or call us; we can also book a video appointment for you."],
        ],
        hours: "Monday to Friday 8:00–20:00, Saturday 9:00–14:00",
      },
      de: {
        nav: ["Konten", "Karten", "Kredite", "Anlegen"],
        heroTitle: "Banking, das in Ihren Alltag passt",
        heroText: "Konto in zehn Minuten eröffnen, mit dem Handy bezahlen und Hilfe von echten Menschen, wann immer Sie sie brauchen.",
        cta: "Chat starten",
        cardTitle: "Girokonto",
        cardLines: ["Ohne Kontoführungsgebühr", "Echtzeitüberweisungen", "Kartensteuerung in der App"],
        topicsTitle: "Wie können wir helfen?",
        topics: [
          ["lock", "Karte sperren", "Karte verloren oder gestohlen? In Sekunden sperren."],
          ["transfer", "Zahlungen und Überweisungen", "Limits, Daueraufträge und SEPA-Überweisungen."],
          ["home", "Baufinanzierung", "Finden Sie heraus, was Sie sich leisten können."],
          ["chart", "Geldanlage", "Fonds und Sparpläne ab 25 im Monat."],
          ["alert", "Unbekannte Abbuchung", "Eine Zahlung reklamieren, die Sie nicht kennen."],
          ["user", "Persönliche Daten", "Adresse oder Telefonnummer ändern."],
        ],
        promoTitle: "Neu: Kreditentscheidung in Minuten",
        promoText: "Online beantragen und sofort Bescheid bekommen. Bei Fragen sind unsere Berater für Sie da.",
        faq: [
          ["Was tun, wenn meine Karte weg ist?", "Sperren Sie sie sofort in der App oder im Chat. Die neue Karte kommt in drei Werktagen."],
          ["Wie lange dauert eine Überweisung?", "Echtzeitüberweisungen sind in Sekunden da, normale Überweisungen am nächsten Werktag."],
          ["Kann ich mit einem Berater sprechen?", "Ja. Starten Sie einen Chat oder rufen Sie an; gern auch per Video-Termin."],
        ],
        hours: "Montag bis Freitag 8:00–20:00, Samstag 9:00–14:00",
      },
    },
  },
  {
    id: "insurance",
    label: { en: "Insurance", de: "Versicherung" },
    brand: "Summit Insurance",
    color: "#27306b",
    card: "policy",
    copy: {
      en: {
        nav: ["Car", "Home", "Health", "Claims"],
        heroTitle: "When something happens, we are there",
        heroText: "Report a claim in minutes, follow it online and talk to a claims expert whenever you want.",
        cta: "Report a claim",
        cardTitle: "Car insurance",
        cardLines: ["Comprehensive cover", "Courtesy car included", "Claims handled in 48 hours"],
        topicsTitle: "What would you like to do?",
        topics: [
          ["alert", "Report a claim", "Accident, storm or water damage: tell us what happened."],
          ["search", "Claim status", "See how far your claim is."],
          ["car", "Car insurance", "Change your car or your no-claims class."],
          ["home", "Home and contents", "Moving? Take your cover with you."],
          ["doc", "Documents", "Your policy and certificates to download."],
          ["user", "Personal details", "Change your address or bank details."],
        ],
        promoTitle: "Claims in the app",
        promoText: "Take a photo, answer three questions, done. Most claims are settled within two days.",
        faq: [
          ["How do I report a claim?", "Online, in the chat or by phone. Have your policy number ready."],
          ["When do I get my money?", "Most claims are paid within two working days after we have all documents."],
          ["Can I change my cover?", "Yes, any time. Changes apply from the next day."],
        ],
        hours: "Claims 24/7 · Service Monday to Friday 8:00–18:00, Saturday 9:00–13:00",
      },
      de: {
        nav: ["Kfz", "Hausrat", "Gesundheit", "Schaden melden"],
        heroTitle: "Wenn etwas passiert, sind wir da",
        heroText: "Schaden in Minuten melden, online verfolgen und mit Schadenexperten sprechen, wann immer Sie wollen.",
        cta: "Schaden melden",
        cardTitle: "Kfz-Versicherung",
        cardLines: ["Vollkasko", "Ersatzwagen inklusive", "Schadenbearbeitung in 48 Stunden"],
        topicsTitle: "Was möchten Sie tun?",
        topics: [
          ["alert", "Schaden melden", "Unfall, Sturm oder Wasserschaden: erzählen Sie uns, was passiert ist."],
          ["search", "Stand meines Schadens", "Sehen Sie, wie weit Ihr Schaden ist."],
          ["car", "Kfz-Versicherung", "Fahrzeug oder Schadenfreiheitsklasse ändern."],
          ["home", "Hausrat und Wohngebäude", "Umzug? Ihr Schutz zieht mit."],
          ["doc", "Dokumente", "Police und Bescheinigungen zum Download."],
          ["user", "Persönliche Daten", "Adresse oder Bankverbindung ändern."],
        ],
        promoTitle: "Schaden per App",
        promoText: "Foto machen, drei Fragen beantworten, fertig. Die meisten Schäden sind in zwei Tagen reguliert.",
        faq: [
          ["Wie melde ich einen Schaden?", "Online, im Chat oder telefonisch. Halten Sie Ihre Versicherungsnummer bereit."],
          ["Wann bekomme ich mein Geld?", "Meist innerhalb von zwei Werktagen, sobald alle Unterlagen da sind."],
          ["Kann ich meinen Schutz ändern?", "Ja, jederzeit. Änderungen gelten ab dem nächsten Tag."],
        ],
        hours: "Schadenhotline 24/7 · Service Montag bis Freitag 8:00–18:00, Samstag 9:00–13:00",
      },
    },
  },
  {
    id: "retail",
    label: { en: "Retail", de: "Handel" },
    brand: "Maple Store",
    color: "#7a2e3a",
    card: "parcel",
    copy: {
      en: {
        nav: ["New in", "Women", "Men", "Home", "Sale"],
        heroTitle: "The autumn collection is here",
        heroText: "Free delivery from 50, free returns within 30 days and a team that loves to help you choose.",
        cta: "Ask our style team",
        cardTitle: "Your order #100-2291",
        cardLines: ["Shipped today", "Arrives Thursday", "Track your parcel"],
        topicsTitle: "Customer service",
        topics: [
          ["truck", "Where is my order?", "Track your parcel and change the delivery day."],
          ["return", "Returns", "Send something back free of charge within 30 days."],
          ["euro", "Refunds", "When your money is back on your account."],
          ["box", "Product availability", "Your size sold out? We tell you when it is back."],
          ["star", "Loyalty club", "Collect points and get early access to the sale."],
          ["chat", "Style advice", "Our team helps you find the right fit."],
        ],
        promoTitle: "Gold members save 15 %",
        promoText: "Join the loyalty club for free and get early access to every sale.",
        faq: [
          ["How long does delivery take?", "Two to three working days; express delivery arrives the next day."],
          ["How do I return an item?", "Start the return in the chat or in your account and print the free label."],
          ["When do I get my refund?", "Within five days after your parcel has arrived at our warehouse."],
        ],
        hours: "Every day 8:00–22:00",
      },
      de: {
        nav: ["Neuheiten", "Damen", "Herren", "Wohnen", "Sale"],
        heroTitle: "Die Herbstkollektion ist da",
        heroText: "Kostenloser Versand ab 50, kostenlose Rücksendung innerhalb von 30 Tagen und ein Team, das gern berät.",
        cta: "Stilberatung im Chat",
        cardTitle: "Ihre Bestellung #100-2291",
        cardLines: ["Heute versandt", "Ankunft Donnerstag", "Sendung verfolgen"],
        topicsTitle: "Kundenservice",
        topics: [
          ["truck", "Wo ist meine Bestellung?", "Paket verfolgen und Liefertag ändern."],
          ["return", "Rücksendung", "Innerhalb von 30 Tagen kostenlos zurückschicken."],
          ["euro", "Erstattung", "Wann Ihr Geld wieder auf dem Konto ist."],
          ["box", "Verfügbarkeit", "Ihre Größe ausverkauft? Wir sagen Bescheid."],
          ["star", "Kundenclub", "Punkte sammeln und früher in den Sale."],
          ["chat", "Stilberatung", "Unser Team hilft bei der richtigen Passform."],
        ],
        promoTitle: "Gold-Mitglieder sparen 15 %",
        promoText: "Kostenlos dem Kundenclub beitreten und früher in jeden Sale.",
        faq: [
          ["Wie lange dauert die Lieferung?", "Zwei bis drei Werktage; Express kommt am nächsten Tag."],
          ["Wie schicke ich etwas zurück?", "Rücksendung im Chat oder im Kundenkonto starten und das kostenlose Etikett drucken."],
          ["Wann bekomme ich mein Geld?", "Innerhalb von fünf Tagen, nachdem Ihr Paket bei uns angekommen ist."],
        ],
        hours: "Täglich 8:00–22:00",
      },
    },
  },
  {
    id: "utilities",
    label: { en: "Energy", de: "Energie" },
    brand: "Brightwatt Energy",
    color: "#0f5b3a",
    card: "meter",
    copy: {
      en: {
        nav: ["Electricity", "Gas", "Solar", "E-mobility"],
        heroTitle: "100 % green power, fair prices",
        heroText: "Switch in five minutes, submit your meter reading online and get help from people who know energy.",
        cta: "Chat with us",
        cardTitle: "Green Fix 24",
        cardLines: ["Price guarantee for 24 months", "100 % renewable", "Monthly cancellation after term"],
        topicsTitle: "Service for customers",
        topics: [
          ["meter", "Submit meter reading", "Your reading in 30 seconds, no login needed."],
          ["bolt", "Report an outage", "No power or gas? We help right away."],
          ["doc", "Understand my bill", "What each line on your bill means."],
          ["leaf", "Change tariff", "Switch to a greener or cheaper tariff."],
          ["home", "Moving home", "Take your contract with you or end it."],
          ["sun", "Solar and heat pumps", "Advice for your own power at home."],
        ],
        promoTitle: "Solar package from 99 a month",
        promoText: "Panels, storage and installation from one supplier. Our experts plan it with you.",
        faq: [
          ["How do I submit my meter reading?", "Online, in the chat or by phone: have your meter number ready."],
          ["What do I do in a power cut?", "Check your fuse box first; then report the outage in the chat or on our fault line."],
          ["Can I change my tariff?", "Yes, at the end of each month. The chat shows which tariffs fit you."],
        ],
        hours: "Faults 24/7 · Service Monday to Friday 7:00–20:00, Saturday 8:00–14:00",
      },
      de: {
        nav: ["Strom", "Gas", "Solar", "E-Mobilität"],
        heroTitle: "100 % Ökostrom, faire Preise",
        heroText: "In fünf Minuten wechseln, Zählerstand online melden und Hilfe von Menschen, die sich mit Energie auskennen.",
        cta: "Chat starten",
        cardTitle: "Öko Fix 24",
        cardLines: ["24 Monate Preisgarantie", "100 % erneuerbar", "Danach monatlich kündbar"],
        topicsTitle: "Service für Kunden",
        topics: [
          ["meter", "Zählerstand melden", "In 30 Sekunden, ohne Login."],
          ["bolt", "Störung melden", "Kein Strom oder Gas? Wir helfen sofort."],
          ["doc", "Rechnung verstehen", "Was jede Zeile Ihrer Rechnung bedeutet."],
          ["leaf", "Tarif wechseln", "Grüner oder günstiger: der passende Tarif."],
          ["home", "Umzug", "Vertrag mitnehmen oder beenden."],
          ["sun", "Solar und Wärmepumpe", "Beratung für Ihren eigenen Strom."],
        ],
        promoTitle: "Solarpaket ab 99 im Monat",
        promoText: "Module, Speicher und Montage aus einer Hand. Unsere Experten planen mit Ihnen.",
        faq: [
          ["Wie melde ich meinen Zählerstand?", "Online, im Chat oder telefonisch; halten Sie Ihre Zählernummer bereit."],
          ["Was tun bei Stromausfall?", "Prüfen Sie zuerst den Sicherungskasten, dann melden Sie die Störung im Chat oder an der Störungshotline."],
          ["Kann ich den Tarif wechseln?", "Ja, zum Monatsende. Im Chat sehen Sie, welche Tarife zu Ihnen passen."],
        ],
        hours: "Störungen 24/7 · Service Montag bis Freitag 7:00–20:00, Samstag 8:00–14:00",
      },
    },
  },
  {
    id: "telco",
    label: { en: "Telecommunications", de: "Telekommunikation" },
    brand: "Wavelink",
    color: "#3b1f6e",
    card: "plan",
    copy: {
      en: {
        nav: ["Mobile", "Internet", "TV", "Devices"],
        heroTitle: "Fibre and 5G for the whole family",
        heroText: "Fast internet, unlimited data and a support team that fixes problems on the first contact.",
        cta: "Chat with support",
        cardTitle: "Fibre 500 + Mobile XL",
        cardLines: ["500 Mbit/s", "Unlimited 5G data", "Roaming in the EU included"],
        topicsTitle: "Help and support",
        topics: [
          ["wifi", "Internet not working", "Check for outages and restart your router."],
          ["phone", "Mobile problems", "No signal, SIM or eSIM questions."],
          ["upgrade", "Upgrade my plan", "More data or a new phone."],
          ["globe", "Roaming", "Using your phone abroad."],
          ["doc", "My bill", "Explain charges and change payment."],
          ["tool", "Technician visit", "Book or move an appointment."],
        ],
        promoTitle: "New phone, same price",
        promoText: "Extend your contract now and pick one of this year's phones at no extra cost.",
        faq: [
          ["My internet is slow. What can I do?", "Restart the router and use a cable for a speed test. The chat can check your line right away."],
          ["Does my plan work abroad?", "Roaming in the EU is included; for other countries the chat shows the best add-on."],
          ["How do I get an eSIM?", "Order it in the chat or in the app; it is active within minutes."],
        ],
        hours: "Technical support 24/7 · Sales Monday to Saturday 8:00–22:00",
      },
      de: {
        nav: ["Mobilfunk", "Internet", "TV", "Geräte"],
        heroTitle: "Glasfaser und 5G für die ganze Familie",
        heroText: "Schnelles Internet, unbegrenzte Daten und ein Support, der Probleme beim ersten Kontakt löst.",
        cta: "Support-Chat",
        cardTitle: "Glasfaser 500 + Mobil XL",
        cardLines: ["500 Mbit/s", "Unbegrenztes 5G-Datenvolumen", "EU-Roaming inklusive"],
        topicsTitle: "Hilfe und Support",
        topics: [
          ["wifi", "Internet geht nicht", "Störungen prüfen und Router neu starten."],
          ["phone", "Mobilfunk-Probleme", "Kein Netz, Fragen zu SIM oder eSIM."],
          ["upgrade", "Tarif upgraden", "Mehr Daten oder ein neues Handy."],
          ["globe", "Roaming", "Ihr Handy im Ausland nutzen."],
          ["doc", "Meine Rechnung", "Posten erklären, Zahlung ändern."],
          ["tool", "Techniker-Termin", "Termin buchen oder verschieben."],
        ],
        promoTitle: "Neues Handy, gleicher Preis",
        promoText: "Jetzt verlängern und eines der neuen Handys ohne Aufpreis wählen.",
        faq: [
          ["Mein Internet ist langsam. Was tun?", "Router neu starten und per Kabel messen. Im Chat prüfen wir Ihre Leitung sofort."],
          ["Funktioniert mein Tarif im Ausland?", "EU-Roaming ist inklusive; für andere Länder zeigt der Chat die beste Option."],
          ["Wie bekomme ich eine eSIM?", "Im Chat oder in der App bestellen; sie ist in Minuten aktiv."],
        ],
        hours: "Technischer Support 24/7 · Verkauf Montag bis Samstag 8:00–22:00",
      },
    },
  },
];

const UI_TEXT: Record<Lang, { call: string; login: string; faq: string; contact: string; chatAnytime: string; notConnected: string; footer: string; legal: string[] }> = {
  en: {
    call: "Call us",
    login: "Log in",
    faq: "Frequently asked questions",
    contact: "Contact",
    chatAnytime: "Chat with us: we usually answer within a minute.",
    notConnected: "Chat is not connected: enter your Messenger deployment ID on the Website page of the gctk UI.",
    footer: "Demo website generated by gctk for a Genesys Cloud demo. Not a real company.",
    legal: ["Imprint", "Privacy", "Terms", "Accessibility"],
  },
  de: {
    call: "Rufen Sie uns an",
    login: "Anmelden",
    faq: "Häufige Fragen",
    contact: "Kontakt",
    chatAnytime: "Schreiben Sie uns: Wir antworten meist innerhalb einer Minute.",
    notConnected: "Chat nicht verbunden: Geben Sie auf der Website-Seite der gctk-Oberfläche Ihre Messenger-Deployment-ID ein.",
    footer: "Demo-Website, erzeugt von gctk für eine Genesys-Cloud-Demo. Kein echtes Unternehmen.",
    legal: ["Impressum", "Datenschutz", "AGB", "Barrierefreiheit"],
  },
};

/** Stroke icons (24×24). */
const ICONS: Record<string, string> = {
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  transfer: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  car: '<path d="M3 16v-4l2-5h14l2 5v4z"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
  truck: '<path d="M2 6h12v10H2zM14 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  return: '<path d="M9 14l-5-5 5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  euro: '<path d="M18 6a7 7 0 1 0 0 12"/><path d="M4 10h9M4 14h9"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  star: '<path d="M12 3l3 6 6 1-4.5 4.5L18 21l-6-3-6 3 1.5-6.5L3 10l6-1z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  meter: '<circle cx="12" cy="13" r="8"/><path d="M12 13l4-4M8 5l1 2"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  leaf: '<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15"/><path d="M5 19l7-7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0"/><path d="M12 20h.01"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  upgrade: '<path d="M12 20V6M6 12l6-6 6 6M5 3h14"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  tool: '<path d="M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 1-2-2z"/>',
};

export interface SiteOptions {
  industry: Industry;
  lang: Lang;
  brand: string;
  color: string;
  phone: string;
  /** File name of an uploaded logo (see saveLogo). */
  logo?: string;
  /** Genesys Web Messenger: deployment id, environment and the org's domain. */
  messenger?: { deploymentId: string; environment: string; domain: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const LOGO_RE = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** JSON inside a <script>: no way to close the tag. */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export { environmentFor };

/** Parses the website's query string; anything invalid falls back to the industry's defaults. */
export function parseSiteQuery(q: URLSearchParams): SiteOptions {
  const industry = INDUSTRIES.find((i) => i.id === q.get("industry")) ?? INDUSTRIES[0]!;
  const lang = (LANGS as readonly string[]).includes(q.get("lang") ?? "") ? (q.get("lang") as Lang) : "en";
  const brand = (q.get("brand") ?? "").trim().slice(0, 60) || industry.brand;
  const color = HEX_RE.test(q.get("color") ?? "") ? q.get("color")! : industry.color;
  const phone = (q.get("phone") ?? "").replace(/[^\d +()/-]/g, "").trim().slice(0, 30) || "+49 30 1234 5678";
  const logo = LOGO_RE.test(q.get("logo") ?? "") ? q.get("logo")! : undefined;
  let messenger: SiteOptions["messenger"];
  const dep = (q.get("deployment") ?? "").trim();
  if (UUID_RE.test(dep)) {
    try {
      const domain = resolveRegion(q.get("domain") ?? "");
      const env = q.get("env") ?? "";
      messenger = { deploymentId: dep, environment: /^[a-z0-9-]{2,30}$/.test(env) ? env : environmentFor(domain), domain };
    } catch {
      messenger = undefined;
    }
  }
  return { industry, lang, brand, color, phone, ...(logo ? { logo } : {}), ...(messenger ? { messenger } : {}) };
}

/** Content-Security-Policy of the website: scripts only with the nonce and from the org's Genesys apps host. */
export function siteCsp(o: SiteOptions, nonce: string): string {
  const d = o.messenger?.domain;
  const g = d ? ` https://apps.${d} https://*.${d}` : "";
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'${g}`,
    `style-src 'self' 'unsafe-inline'${g}`,
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    d ? `connect-src 'self' https://*.${d} wss://*.${d} https:` : "connect-src 'none'",
    d ? "frame-src https:" : "frame-src 'none'",
    d ? "media-src 'self' blob: https:" : "media-src 'none'",
    "worker-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function initials(brand: string): string {
  const words = brand.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "D";
}

function heroCard(o: SiteOptions, c: Copy): string {
  const lines = c.cardLines.map((l) => `<li>${esc(l)}</li>`).join("");
  const extra: Record<Industry["card"], string> = {
    card: `<div class="chip"></div><div class="num">•••• •••• •••• 4471</div>`,
    policy: `<div class="num">POL-4471-2290</div>`,
    parcel: `<div class="bar"><i style="width:66%"></i></div>`,
    meter: `<div class="num">0 4 7 1 1 . 3 kWh</div>`,
    plan: `<div class="bar"><i style="width:38%"></i></div>`,
  };
  return `<div class="hero-card"><div class="hc-top"><strong>${esc(c.cardTitle)}</strong><span>${esc(o.brand)}</span></div>${extra[o.industry.card]}<ul>${lines}</ul></div>`;
}

/** The whole page. Every value from the query string goes through esc() or js(). */
export function siteHtml(o: SiteOptions, nonce: string): string {
  const c = o.industry.copy[o.lang];
  const t = UI_TEXT[o.lang];
  const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ICONS.chat}</svg>`;
  const logo = o.logo ? `<img class="logo-img" src="/site/logo/${esc(o.logo)}" alt="${esc(o.brand)}">` : `<span class="mono">${esc(initials(o.brand))}</span>`;
  const tel = o.phone.replace(/[^\d+]/g, "");
  const messenger = o.messenger
    ? `<script nonce="${nonce}">
(function (g, e, n, es, ys) {
  g["_genesysJs"] = e;
  g[e] = g[e] || function () { (g[e].q = g[e].q || []).push(arguments); };
  g[e].t = 1 * new Date();
  g[e].c = es;
  ys = document.createElement("script"); ys.async = 1; ys.src = n; ys.charset = "utf-8"; document.head.appendChild(ys);
})(window, "Genesys", ${js(`https://apps.${o.messenger.domain}/genesys-bootstrap/genesys.min.js`)}, { environment: ${js(o.messenger.environment)}, deploymentId: ${js(o.messenger.deploymentId)} });
</script>`
    : "";
  return `<!doctype html>
<html lang="${o.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.brand)}</title>
<style>
:root { --brand: ${o.color}; --brand-soft: color-mix(in srgb, var(--brand) 10%, white); --brand-dark: color-mix(in srgb, var(--brand) 80%, black); --text: #1c2230; --muted: #5d6677; --line: #e6e8ee; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: #fff; }
a { color: inherit; text-decoration: none; }
.wrap { max-width: 1160px; margin: 0 auto; padding: 0 24px; }
.notice { background: #fff4de; color: #7a4f00; font-size: 13px; text-align: center; padding: 6px 12px; }
header { border-bottom: 1px solid var(--line); background: #fff; position: sticky; top: 0; z-index: 5; }
.top { display: flex; align-items: center; gap: 28px; height: 72px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 20px; letter-spacing: -.01em; }
.mono { display: inline-grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: var(--brand); color: #fff; font-size: 16px; }
.logo-img { height: 40px; max-width: 160px; object-fit: contain; }
nav { display: flex; gap: 22px; color: var(--muted); font-weight: 500; }
nav a:hover { color: var(--brand); }
.spacer { flex: 1; }
.btn { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 12px 22px; font: inherit; font-weight: 650; cursor: pointer; }
.btn svg { flex: none; width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.btn-primary { background: var(--brand); color: #fff; }
.btn-primary:hover { background: var(--brand-dark); }
.btn-ghost { background: transparent; color: var(--brand); border: 2px solid var(--brand); padding: 10px 20px; }
.btn-small { padding: 8px 16px; font-size: 14px; }
.hero { background: linear-gradient(135deg, var(--brand-soft), #fff 70%); }
.hero .wrap { display: grid; grid-template-columns: 1.2fr 1fr; gap: 48px; align-items: center; padding-top: 64px; padding-bottom: 72px; }
.hero h1 { font-size: clamp(34px, 5vw, 54px); line-height: 1.08; margin: 0 0 18px; letter-spacing: -.02em; }
.hero p { font-size: 19px; color: var(--muted); margin: 0 0 28px; max-width: 540px; }
.hero .actions { display: flex; gap: 12px; flex-wrap: wrap; }
.hero-card { background: linear-gradient(140deg, var(--brand), var(--brand-dark)); color: #fff; border-radius: 22px; padding: 28px; box-shadow: 0 30px 60px -25px color-mix(in srgb, var(--brand) 70%, black); transform: rotate(-2deg); }
.hc-top { display: flex; justify-content: space-between; align-items: baseline; font-size: 18px; }
.hc-top span { opacity: .75; font-size: 14px; }
.hero-card ul { list-style: none; padding: 0; margin: 18px 0 0; display: grid; gap: 8px; }
.hero-card li::before { content: "✓"; margin-right: 10px; opacity: .8; }
.chip { width: 46px; height: 34px; border-radius: 7px; background: linear-gradient(135deg, #f6d27a, #c9a13e); margin-top: 26px; }
.num { font-family: ui-monospace, Menlo, monospace; letter-spacing: .12em; font-size: 20px; margin-top: 16px; }
.bar { height: 10px; border-radius: 5px; background: rgba(255,255,255,.25); margin-top: 22px; overflow: hidden; }
.bar i { display: block; height: 100%; background: #fff; border-radius: 5px; }
section { padding: 64px 0; }
h2 { font-size: 30px; margin: 0 0 28px; letter-spacing: -.01em; }
.topics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
.topic { display: flex; gap: 16px; align-items: flex-start; text-align: left; background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 22px; font: inherit; color: inherit; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.topic:hover { border-color: var(--brand); box-shadow: 0 10px 30px -18px var(--brand); }
.topic svg { flex: none; width: 44px; height: 44px; padding: 10px; border-radius: 12px; background: var(--brand-soft); stroke: var(--brand); fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.topic strong { display: block; font-size: 17px; margin-bottom: 4px; }
.topic span { color: var(--muted); font-size: 15px; }
.promo { background: var(--brand); color: #fff; border-radius: 24px; padding: 40px; display: flex; gap: 24px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.promo h3 { font-size: 26px; margin: 0 0 6px; }
.promo p { margin: 0; opacity: .9; max-width: 640px; }
.promo .btn { background: #fff; color: var(--brand); }
.split { display: grid; grid-template-columns: 1.4fr 1fr; gap: 40px; }
details { border-bottom: 1px solid var(--line); padding: 16px 0; }
summary { cursor: pointer; font-weight: 650; font-size: 17px; }
details p { color: var(--muted); margin: 10px 0 0; }
.contact { background: var(--brand-soft); border-radius: 20px; padding: 28px; display: grid; gap: 12px; align-content: start; }
.contact .big { font-size: 24px; font-weight: 800; color: var(--brand); }
.contact .muted { color: var(--muted); font-size: 15px; }
footer { background: #10141d; color: #b8bfcc; font-size: 14px; padding: 36px 0; margin-top: 32px; }
footer .wrap { display: flex; gap: 24px; flex-wrap: wrap; align-items: center; }
footer .legal { display: flex; gap: 18px; }
.btn { white-space: nowrap; }
@media (max-width: 860px) { nav, .top .btn-ghost { display: none; } .hero .wrap, .split { grid-template-columns: 1fr; } .topics { grid-template-columns: 1fr; } .hero-card { transform: none; } }
</style>
${messenger}
</head>
<body>
${o.messenger ? "" : `<div class="notice">${esc(t.notConnected)}</div>`}
<header><div class="wrap top">
  <a class="brand" href="#">${logo}<span>${esc(o.brand)}</span></a>
  <nav>${c.nav.map((n) => `<a href="#">${esc(n)}</a>`).join("")}</nav>
  <span class="spacer"></span>
  <a class="btn btn-ghost btn-small" href="tel:${esc(tel)}">${esc(o.phone)}</a>
  <button class="btn btn-primary btn-small" type="button">${esc(t.login)}</button>
</div></header>
<main>
  <div class="hero"><div class="wrap">
    <div>
      <h1>${esc(c.heroTitle)}</h1>
      <p>${esc(c.heroText)}</p>
      <div class="actions"><button class="btn btn-primary" type="button" data-chat>${icon("chat")}${esc(c.cta)}</button><a class="btn btn-ghost" href="tel:${esc(tel)}">${esc(t.call)}</a></div>
    </div>
    ${heroCard(o, c)}
  </div></div>
  <section><div class="wrap">
    <h2>${esc(c.topicsTitle)}</h2>
    <div class="topics">${c.topics.map(([ic, title, text]) => `<button class="topic" type="button" data-chat>${icon(ic)}<div><strong>${esc(title)}</strong><span>${esc(text)}</span></div></button>`).join("")}</div>
  </div></section>
  <div class="wrap"><div class="promo"><div><h3>${esc(c.promoTitle)}</h3><p>${esc(c.promoText)}</p></div><button class="btn" type="button" data-chat>${esc(c.cta)}</button></div></div>
  <section><div class="wrap split">
    <div><h2>${esc(t.faq)}</h2>${c.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>
    <div class="contact"><h2 style="margin:0">${esc(t.contact)}</h2><a class="big" href="tel:${esc(tel)}">${esc(o.phone)}</a><div class="muted">${esc(c.hours)}</div><div class="muted">${esc(t.chatAnytime)}</div><button class="btn btn-primary" type="button" data-chat>${icon("chat")}${esc(c.cta)}</button></div>
  </div></section>
</main>
<footer><div class="wrap"><strong style="color:#fff">${esc(o.brand)}</strong><span class="legal">${t.legal.map((l) => `<a href="#">${esc(l)}</a>`).join("")}</span><span class="spacer"></span><span>${esc(t.footer)}</span></div></footer>
<script nonce="${nonce}">
document.querySelectorAll("a[href='#']").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); }); });
document.querySelectorAll("[data-chat]").forEach(function (b) {
  b.addEventListener("click", function () {
    if (window.Genesys) window.Genesys("command", "Messenger.open");
    else alert(${js(t.notConnected)});
  });
});
</script>
</body>
</html>`;
}

// ------------------------------------------------------------------ logos

const logoDir = () => path.join(paths.cacheDir(), "site-logos");
const LOGO_TYPES: Array<{ ext: string; type: string; magic: (b: Buffer) => boolean }> = [
  { ext: "png", type: "image/png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", type: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", type: "image/gif", magic: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { ext: "webp", type: "image/webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Stores an uploaded logo (a data: URL) by content; only raster images (SVG can carry scripts). */
export function saveLogo(dataUrl: string): string {
  const m = /^data:[\w/+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("The logo must be an image file.");
  const buf = Buffer.from(m[1]!, "base64");
  if (buf.length > MAX_LOGO_BYTES) throw new Error("The logo is larger than 2 MB.");
  const kind = LOGO_TYPES.find((t) => t.magic(buf));
  if (!kind) throw new Error("Use a PNG, JPEG, GIF or WebP logo (SVG is not accepted).");
  const name = `${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${kind.ext}`;
  fs.mkdirSync(logoDir(), { recursive: true });
  const file = path.join(logoDir(), name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf, { mode: 0o600 });
  return name;
}

export function readLogo(name: string): { body: Buffer; type: string } | undefined {
  if (!LOGO_RE.test(name)) return undefined;
  const file = path.join(logoDir(), name);
  if (!fs.existsSync(file)) return undefined;
  const ext = name.split(".").pop()!;
  return { body: fs.readFileSync(file), type: LOGO_TYPES.find((t) => t.ext === ext)!.type };
}
