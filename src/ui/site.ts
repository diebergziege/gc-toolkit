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
  productsTitle: string;
  /** Three products or tariffs; the one marked true is highlighted as the most popular. */
  products: Array<[name: string, price: string, unit: string, features: string[], popular?: boolean]>;
  stats: Array<[value: string, label: string]>;
  reviews: Array<[quote: string, name: string, city: string]>;
  /** News items: how many days ago, headline. The date is formatted when the page is served. */
  news: Array<[daysAgo: number, title: string]>;
};

export interface Industry {
  id: string;
  label: { en: string; de: string };
  brand: string;
  color: string;
  /** Shown in the hero card: a bank card, a policy, a parcel, a meter, a phone plan. */
  card: "card" | "policy" | "parcel" | "meter" | "plan";
  /** Legal form in the footer, added to the brand unless the brand already has one. */
  legal: string;
  copy: Record<Lang, Copy>;
}

export const INDUSTRIES: Industry[] = [
  {
    id: "bank",
    label: { en: "Banking", de: "Bank" },
    brand: "Harbor Bank",
    color: "#0b3d5c",
    card: "card",
    legal: "AG",
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
        productsTitle: "Accounts for every stage of life",
        products: [
          ["Everyday account", "€0", "per month", ["Free Visa debit card", "Instant transfers", "Apple Pay and Google Pay"]],
          ["Premium account", "€9.90", "per month", ["Metal credit card", "Travel insurance included", "Free cash withdrawals worldwide"], true],
          ["Savings plan", "from €25", "per month", ["ETFs and funds", "Change or pause any time", "No order fees"]],
        ],
        stats: [["1.2 million", "customers"], ["4.8 / 5", "app rating"], ["24/7", "card blocking"]],
        reviews: [
          ["I lost my card on holiday. In the chat it was blocked and a new one ordered within two minutes.", "Sarah K.", "Hamburg"],
          ["Our adviser explained the mortgage options in plain words. We felt in good hands.", "Tom and Lena B.", "Munich"],
          ["Finally a banking app that does what it says. Transfers arrive instantly.", "Mehmet Y.", "Cologne"],
        ],
        news: [[3, "Apple Pay and Google Pay now for every card"], [12, "Savings interest rises to 3.1 %"], [26, "How to spot phishing messages"]],
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
        productsTitle: "Konten für jede Lebenslage",
        products: [
          ["Girokonto", "0 €", "pro Monat", ["Kostenlose Visa Debitkarte", "Echtzeitüberweisungen", "Apple Pay und Google Pay"]],
          ["Premiumkonto", "9,90 €", "pro Monat", ["Kreditkarte aus Metall", "Reiseversicherung inklusive", "Weltweit kostenlos Bargeld"], true],
          ["Sparplan", "ab 25 €", "pro Monat", ["ETFs und Fonds", "Jederzeit ändern oder pausieren", "Keine Ordergebühren"]],
        ],
        stats: [["1,2 Mio.", "Kundinnen und Kunden"], ["4,8 / 5", "App-Bewertung"], ["24/7", "Kartensperre"]],
        reviews: [
          ["Karte im Urlaub verloren: Im Chat war sie in zwei Minuten gesperrt und eine neue bestellt.", "Sarah K.", "Hamburg"],
          ["Unser Berater hat uns die Baufinanzierung verständlich erklärt. Wir fühlten uns gut aufgehoben.", "Tom und Lena B.", "München"],
          ["Endlich eine Banking-App, die hält, was sie verspricht. Überweisungen sind sofort da.", "Mehmet Y.", "Köln"],
        ],
        news: [[3, "Apple Pay und Google Pay jetzt für alle Karten"], [12, "Sparzins steigt auf 3,1 %"], [26, "So erkennen Sie Phishing-Nachrichten"]],
      },
    },
  },
  {
    id: "insurance",
    label: { en: "Insurance", de: "Versicherung" },
    brand: "Summit Insurance",
    color: "#27306b",
    card: "policy",
    legal: "AG",
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
        productsTitle: "Cover that fits your life",
        products: [
          ["Car insurance", "from €19.90", "per month", ["Comprehensive cover", "Courtesy car included", "Free choice of garage"]],
          ["Home contents", "from €4.50", "per month", ["Theft, fire and water damage", "Bicycles included", "New-for-old value"], true],
          ["Personal liability", "from €3.90", "per month", ["Up to €50 million cover", "Whole family included", "Lost keys covered"]],
        ],
        stats: [["3 million", "insured customers"], ["48 h", "average claim payout"], ["24/7", "claims hotline"]],
        reviews: [
          ["After the storm a claims expert called me the same day. The money was there two days later.", "Julia M.", "Bremen"],
          ["Rear-ended on the motorway: the courtesy car was at my door the next morning.", "Andreas P.", "Stuttgart"],
          ["Switching was easy, and I now pay less for better cover.", "Fatma D.", "Frankfurt"],
        ],
        news: [[4, "Storm season: how to protect your home"], [15, "New: report a claim by video call"], [30, "Lower premiums for young drivers"]],
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
        productsTitle: "Schutz, der zu Ihnen passt",
        products: [
          ["Kfz-Versicherung", "ab 19,90 €", "pro Monat", ["Vollkasko", "Ersatzwagen inklusive", "Freie Werkstattwahl"]],
          ["Hausratversicherung", "ab 4,50 €", "pro Monat", ["Diebstahl, Feuer und Wasser", "Fahrräder mitversichert", "Neuwertersatz"], true],
          ["Privathaftpflicht", "ab 3,90 €", "pro Monat", ["Bis 50 Mio. € Deckung", "Ganze Familie versichert", "Schlüsselverlust inklusive"]],
        ],
        stats: [["3 Mio.", "versicherte Kunden"], ["48 h", "bis zur Auszahlung"], ["24/7", "Schadenhotline"]],
        reviews: [
          ["Nach dem Sturm hat mich noch am selben Tag ein Experte angerufen. Zwei Tage später war das Geld da.", "Julia M.", "Bremen"],
          ["Auffahrunfall auf der Autobahn: Der Ersatzwagen stand am nächsten Morgen vor der Tür.", "Andreas P.", "Stuttgart"],
          ["Der Wechsel war einfach, und ich zahle jetzt weniger für besseren Schutz.", "Fatma D.", "Frankfurt"],
        ],
        news: [[4, "Sturmsaison: So schützen Sie Ihr Zuhause"], [15, "Neu: Schaden per Videoanruf melden"], [30, "Günstigere Beiträge für junge Fahrer"]],
      },
    },
  },
  {
    id: "retail",
    label: { en: "Retail", de: "Handel" },
    brand: "Maple Store",
    color: "#7a2e3a",
    card: "parcel",
    legal: "GmbH",
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
        productsTitle: "Trending now",
        products: [
          ["Merino wool jumper", "€79.95", "six colours", ["Sizes XS to XXL", "Machine washable", "Free returns"]],
          ["Waterproof parka", "€149.00", "new season", ["Recycled materials", "Removable hood", "−15 % for Gold members"], true],
          ["Leather ankle boots", "€119.95", "bestseller", ["Genuine leather", "Cushioned sole", "Sizes 36 to 46"]],
        ],
        stats: [["2 million", "happy customers"], ["30 days", "free returns"], ["4.7 / 5", "on Trustpilot"]],
        reviews: [
          ["The style team in the chat found me the right size on the first try.", "Nina R.", "Düsseldorf"],
          ["Return started in the chat, label printed, money back four days later.", "Jonas F.", "Leipzig"],
          ["Ordered on Monday, wore it on Wednesday. Great quality.", "Clara S.", "Berlin"],
        ],
        news: [[2, "The autumn sale starts on Friday"], [9, "Our new store in Leipzig is open"], [21, "How to care for wool"]],
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
        productsTitle: "Gerade beliebt",
        products: [
          ["Merino-Pullover", "79,95 €", "sechs Farben", ["Größen XS bis XXL", "Waschmaschinenfest", "Kostenlose Rücksendung"]],
          ["Wasserdichter Parka", "149,00 €", "neue Saison", ["Recycelte Materialien", "Abnehmbare Kapuze", "−15 % für Gold-Mitglieder"], true],
          ["Leder-Stiefeletten", "119,95 €", "Bestseller", ["Echtleder", "Gepolsterte Sohle", "Größen 36 bis 46"]],
        ],
        stats: [["2 Mio.", "zufriedene Kunden"], ["30 Tage", "kostenlose Rücksendung"], ["4,7 / 5", "bei Trustpilot"]],
        reviews: [
          ["Die Stilberatung im Chat hat mir gleich beim ersten Mal die richtige Größe empfohlen.", "Nina R.", "Düsseldorf"],
          ["Rücksendung im Chat gestartet, Etikett gedruckt, vier Tage später war das Geld da.", "Jonas F.", "Leipzig"],
          ["Montag bestellt, Mittwoch getragen. Tolle Qualität.", "Clara S.", "Berlin"],
        ],
        news: [[2, "Der Herbst-Sale startet am Freitag"], [9, "Unser neuer Store in Leipzig ist eröffnet"], [21, "So pflegen Sie Wolle richtig"]],
      },
    },
  },
  {
    id: "utilities",
    label: { en: "Energy", de: "Energie" },
    brand: "Brightwatt Energy",
    color: "#0f5b3a",
    card: "meter",
    legal: "GmbH",
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
        productsTitle: "Our tariffs",
        products: [
          ["Green Flex", "31.9 ct/kWh", "+ €12.90 a month", ["100 % renewable", "Cancel monthly", "No minimum term"]],
          ["Green Fix 24", "29.9 ct/kWh", "+ €11.90 a month", ["Price guarantee for 24 months", "100 % renewable", "€100 switching bonus"], true],
          ["Heat pump tariff", "24.9 ct/kWh", "+ €9.90 a month", ["For heat pumps and storage heaters", "Separate meter", "Price guarantee for 12 months"]],
        ],
        stats: [["800,000", "households"], ["100 %", "renewable power"], ["5 min", "to switch"]],
        reviews: [
          ["Meter reading in the chat, done in thirty seconds. That is how it should be.", "Peter W.", "Hanover"],
          ["During the outage I got an answer at 11 at night and an update every hour.", "Sabine L.", "Dresden"],
          ["They planned our solar system with us; it now covers 70 % of our power.", "The Öztürk family", "Nuremberg"],
        ],
        news: [[5, "Price guarantee extended to 2028"], [14, "Smart meters are coming to your area"], [28, "Save energy this winter: eight tips"]],
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
        productsTitle: "Unsere Tarife",
        products: [
          ["Öko Flex", "31,9 ct/kWh", "+ 12,90 € im Monat", ["100 % erneuerbar", "Monatlich kündbar", "Keine Mindestlaufzeit"]],
          ["Öko Fix 24", "29,9 ct/kWh", "+ 11,90 € im Monat", ["24 Monate Preisgarantie", "100 % erneuerbar", "100 € Wechselbonus"], true],
          ["Wärmepumpentarif", "24,9 ct/kWh", "+ 9,90 € im Monat", ["Für Wärmepumpe und Speicherheizung", "Eigener Zähler", "12 Monate Preisgarantie"]],
        ],
        stats: [["800.000", "Haushalte"], ["100 %", "Ökostrom"], ["5 Min.", "zum Wechsel"]],
        reviews: [
          ["Zählerstand im Chat gemeldet, in dreißig Sekunden erledigt. So muss das sein.", "Peter W.", "Hannover"],
          ["Bei der Störung bekam ich um 23 Uhr eine Antwort und danach stündlich ein Update.", "Sabine L.", "Dresden"],
          ["Unsere Solaranlage wurde mit uns geplant; sie deckt jetzt 70 % unseres Stroms.", "Familie Öztürk", "Nürnberg"],
        ],
        news: [[5, "Preisgarantie bis 2028 verlängert"], [14, "Smart Meter kommen in Ihre Region"], [28, "Energie sparen im Winter: acht Tipps"]],
      },
    },
  },
  {
    id: "telco",
    label: { en: "Telecommunications", de: "Telekommunikation" },
    brand: "Wavelink",
    color: "#3b1f6e",
    card: "plan",
    legal: "GmbH",
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
        productsTitle: "Plans for every need",
        products: [
          ["Mobile M", "€19.99", "per month", ["20 GB 5G data", "EU roaming included", "Cancel monthly"]],
          ["Mobile XL", "€34.99", "per month", ["Unlimited 5G data", "Two eSIMs", "Streaming free for 6 months"], true],
          ["Fibre 500", "€44.99", "per month", ["500 Mbit/s", "Wi-Fi 7 router", "Free installation"]],
        ],
        stats: [["5 million", "customers"], ["99 %", "5G coverage"], ["24/7", "technical support"]],
        reviews: [
          ["My internet dropped on a Sunday. The chat found the fault and a technician came on Monday.", "Lukas H.", "Essen"],
          ["eSIM ordered in the chat, active five minutes later.", "Aylin K.", "Mannheim"],
          ["Fair prices and a support team that actually solves things.", "Robert G.", "Kiel"],
        ],
        news: [[1, "5G now in 300 more towns"], [10, "New: your eSIM in the app in two minutes"], [24, "Our network wins the 2026 network test"]],
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
        productsTitle: "Tarife für jeden Bedarf",
        products: [
          ["Mobil M", "19,99 €", "pro Monat", ["20 GB 5G-Daten", "EU-Roaming inklusive", "Monatlich kündbar"]],
          ["Mobil XL", "34,99 €", "pro Monat", ["Unbegrenzte 5G-Daten", "Zwei eSIMs", "6 Monate Streaming gratis"], true],
          ["Glasfaser 500", "44,99 €", "pro Monat", ["500 Mbit/s", "WLAN-7-Router", "Kostenlose Installation"]],
        ],
        stats: [["5 Mio.", "Kunden"], ["99 %", "5G-Abdeckung"], ["24/7", "technischer Support"]],
        reviews: [
          ["Am Sonntag fiel mein Internet aus. Der Chat fand den Fehler, am Montag kam der Techniker.", "Lukas H.", "Essen"],
          ["eSIM im Chat bestellt, fünf Minuten später aktiv.", "Aylin K.", "Mannheim"],
          ["Faire Preise und ein Support, der Probleme wirklich löst.", "Robert G.", "Kiel"],
        ],
        news: [[1, "5G jetzt in 300 weiteren Orten"], [10, "Neu: Ihre eSIM in zwei Minuten in der App"], [24, "Unser Netz gewinnt den Netztest 2026"]],
      },
    },
  },
];

type UiText = {
  call: string;
  login: string;
  faq: string;
  contact: string;
  chatAnytime: string;
  notConnected: string;
  footer: string;
  legal: string[];
  segments: string[];
  about: string[];
  search: string;
  popular: string;
  more: string;
  reviewsTitle: string;
  newsTitle: string;
  readMore: string;
  online: string;
  greeting: string;
  footerCols: string[];
  service: string[];
  address: string;
  rights: string;
  cookieTitle: string;
  cookieText: string;
  cookieOk: string;
  cookieNo: string;
  locale: string;
};

const UI_TEXT: Record<Lang, UiText> = {
  en: {
    call: "Call us",
    login: "Log in",
    faq: "Frequently asked questions",
    contact: "Contact",
    chatAnytime: "Chat with us: we usually answer within a minute.",
    notConnected: "Chat is not connected: enter your Messenger deployment ID on the Website page of the gctk UI.",
    footer: "Demo website generated by gctk for a Genesys Cloud demo. Not a real company.",
    legal: ["Imprint", "Privacy", "Terms", "Accessibility", "Cookie settings"],
    segments: ["Personal", "Business"],
    about: ["About us", "Careers", "Press"],
    search: "Search",
    popular: "Most popular",
    more: "Learn more",
    reviewsTitle: "What our customers say",
    newsTitle: "News",
    readMore: "Read more",
    online: "Online now",
    greeting: "Hi! How can we help you today?",
    footerCols: ["Products", "Service", "Company"],
    service: ["Help centre", "Contact", "Find a branch", "Report a problem"],
    address: "Friedrichstrasse 120 · 10117 Berlin · Germany",
    rights: "All rights reserved.",
    cookieTitle: "We value your privacy",
    cookieText: "We use cookies to run this website and, with your consent, to improve it.",
    cookieOk: "Accept all",
    cookieNo: "Necessary only",
    locale: "en-GB",
  },
  de: {
    call: "Rufen Sie uns an",
    login: "Anmelden",
    faq: "Häufige Fragen",
    contact: "Kontakt",
    chatAnytime: "Schreiben Sie uns: Wir antworten meist innerhalb einer Minute.",
    notConnected: "Chat nicht verbunden: Geben Sie auf der Website-Seite der gctk-Oberfläche Ihre Messenger-Deployment-ID ein.",
    footer: "Demo-Website, erzeugt von gctk für eine Genesys-Cloud-Demo. Kein echtes Unternehmen.",
    legal: ["Impressum", "Datenschutz", "AGB", "Barrierefreiheit", "Cookie-Einstellungen"],
    segments: ["Privatkunden", "Geschäftskunden"],
    about: ["Über uns", "Karriere", "Presse"],
    search: "Suche",
    popular: "Beliebt",
    more: "Mehr erfahren",
    reviewsTitle: "Das sagen unsere Kunden",
    newsTitle: "Aktuelles",
    readMore: "Weiterlesen",
    online: "Jetzt online",
    greeting: "Hallo! Wie können wir Ihnen heute helfen?",
    footerCols: ["Produkte", "Service", "Unternehmen"],
    service: ["Hilfe-Center", "Kontakt", "Filiale finden", "Problem melden"],
    address: "Friedrichstraße 120 · 10117 Berlin",
    rights: "Alle Rechte vorbehalten.",
    cookieTitle: "Ihre Privatsphäre ist uns wichtig",
    cookieText: "Wir verwenden Cookies, um diese Website zu betreiben und – mit Ihrer Einwilligung – zu verbessern.",
    cookieOk: "Alle akzeptieren",
    cookieNo: "Nur notwendige",
    locale: "de-DE",
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

const LEGAL_FORM_RE = /\b(GmbH|AG|SE|KG|Ltd|plc|Inc|LLC)\.?$/i;

/** The whole page. Every value from the query string goes through esc() or js(). */
export function siteHtml(o: SiteOptions, nonce: string): string {
  const c = o.industry.copy[o.lang];
  const t = UI_TEXT[o.lang];
  const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ICONS.chat}</svg>`;
  const logo = o.logo ? `<img class="logo-img" src="/site/logo/${esc(o.logo)}" alt="${esc(o.brand)}">` : `<span class="mono">${esc(initials(o.brand))}</span>`;
  const tel = o.phone.replace(/[^\d+]/g, "");
  const company = LEGAL_FORM_RE.test(o.brand) ? o.brand : `${o.brand} ${o.industry.legal}`;
  const favicon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${o.color}"/><text x="16" y="21" font-family="sans-serif" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">${esc(initials(o.brand))}</text></svg>`)}`;
  const date = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString(t.locale, { day: "numeric", month: "long", year: "numeric" });
  const rated = c.stats.find(([v]) => v.includes("/ 5"));
  const stars = `<span class="stars" aria-label="5/5">★★★★★</span>`;
  const links = (items: string[]) => `<ul>${items.map((l) => `<li><a href="#">${esc(l)}</a></li>`).join("")}</ul>`;
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
<link rel="icon" href="${esc(favicon)}">
<style>
:root { --brand: ${o.color}; --brand-soft: color-mix(in srgb, var(--brand) 9%, white); --brand-dark: color-mix(in srgb, var(--brand) 78%, black); --text: #1c2230; --muted: #5d6677; --line: #e6e8ee; --bg2: #f6f7fa; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: #fff; }
a { color: inherit; text-decoration: none; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 24px; }
svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.notice { background: #fff4de; color: #7a4f00; font-size: 13px; text-align: center; padding: 6px 12px; }
.utility { background: var(--bg2); border-bottom: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.utility .wrap { display: flex; align-items: center; gap: 18px; height: 36px; }
.utility .seg a { padding: 9px 0; margin-right: 16px; }
.utility .seg a.on { color: var(--text); font-weight: 650; box-shadow: inset 0 -2px var(--brand); }
.utility a:hover { color: var(--text); }
.lang { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; background: #fff; }
.lang a { padding: 2px 10px; font-weight: 650; }
.lang a.on { background: var(--text); color: #fff; }
header { border-bottom: 1px solid var(--line); background: rgba(255,255,255,.92); backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 5; }
.top { display: flex; align-items: center; gap: 28px; height: 72px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 20px; letter-spacing: -.01em; }
.mono { display: inline-grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: var(--brand); color: #fff; font-size: 16px; }
.logo-img { height: 40px; max-width: 160px; object-fit: contain; }
nav { display: flex; gap: 22px; color: var(--muted); font-weight: 500; }
nav a:hover { color: var(--brand); }
.spacer { flex: 1; }
.icon-btn { display: inline-grid; place-items: center; width: 40px; height: 40px; border-radius: 999px; border: 1px solid var(--line); background: #fff; color: var(--muted); cursor: pointer; }
.icon-btn svg { width: 18px; height: 18px; }
.btn { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 12px 22px; font: inherit; font-weight: 650; cursor: pointer; white-space: nowrap; }
.btn svg { flex: none; width: 20px; height: 20px; }
.btn-primary { background: var(--brand); color: #fff; }
.btn-primary:hover { background: var(--brand-dark); }
.btn-ghost { background: transparent; color: var(--brand); border: 2px solid var(--brand); padding: 10px 20px; }
.btn-small { padding: 8px 16px; font-size: 14px; }
.hero { background: radial-gradient(1200px 500px at 85% 0%, color-mix(in srgb, var(--brand) 16%, white), transparent 60%), linear-gradient(180deg, var(--brand-soft), #fff); overflow: hidden; }
.hero .wrap { display: grid; grid-template-columns: 1.15fr 1fr; gap: 56px; align-items: center; padding-top: 72px; padding-bottom: 88px; }
.badge { display: inline-flex; align-items: center; gap: 8px; background: #fff; border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px 5px 6px; font-size: 13px; color: var(--muted); margin-bottom: 18px; box-shadow: 0 4px 14px -8px rgba(0,0,0,.2); }
.badge b { background: var(--brand); color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.hero h1 { font-size: clamp(34px, 5vw, 56px); line-height: 1.06; margin: 0 0 18px; letter-spacing: -.025em; }
.hero p { font-size: 19px; color: var(--muted); margin: 0 0 28px; max-width: 540px; }
.hero .actions { display: flex; gap: 12px; flex-wrap: wrap; }
.trust { display: flex; gap: 22px; margin-top: 28px; color: var(--muted); font-size: 14px; flex-wrap: wrap; }
.trust span::before { content: "✓"; color: var(--brand); font-weight: 800; margin-right: 6px; }
.visual { position: relative; padding: 24px 0 96px; }
.hero-card { position: relative; background: linear-gradient(140deg, var(--brand), var(--brand-dark)); color: #fff; border-radius: 22px; padding: 28px; box-shadow: 0 30px 60px -25px color-mix(in srgb, var(--brand) 70%, black); transform: rotate(-2deg); }
.hc-top { display: flex; justify-content: space-between; align-items: baseline; font-size: 18px; }
.hc-top span { opacity: .75; font-size: 14px; }
.hero-card ul { list-style: none; padding: 0; margin: 18px 0 0; display: grid; gap: 8px; }
.hero-card li::before { content: "✓"; margin-right: 10px; opacity: .8; }
.chip { width: 46px; height: 34px; border-radius: 7px; background: linear-gradient(135deg, #f6d27a, #c9a13e); margin-top: 26px; }
.num { font-family: ui-monospace, Menlo, monospace; letter-spacing: .12em; font-size: 20px; margin-top: 16px; }
.bar { height: 10px; border-radius: 5px; background: rgba(255,255,255,.25); margin-top: 22px; overflow: hidden; }
.bar i { display: block; height: 100%; background: #fff; border-radius: 5px; }
.bubble { position: absolute; left: -28px; bottom: 0; display: flex; gap: 12px; align-items: flex-start; max-width: 300px; background: #fff; border-radius: 18px 18px 18px 4px; padding: 14px 16px; box-shadow: 0 18px 40px -16px rgba(16,20,29,.35); border: 1px solid var(--line); text-align: left; font: inherit; color: inherit; cursor: pointer; }
.bubble .av { flex: none; position: relative; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--brand); color: #fff; }
.bubble .av svg { width: 18px; height: 18px; }
.bubble .av::after { content: ""; position: absolute; right: -1px; bottom: -1px; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; border: 2px solid #fff; }
.bubble b { display: block; font-size: 14px; }
.bubble small { color: #16a34a; font-size: 12px; }
.bubble span { display: block; font-size: 14px; margin-top: 4px; }
.rating { position: absolute; right: -8px; top: -12px; z-index: 1; background: #fff; border-radius: 14px; padding: 10px 14px; box-shadow: 0 14px 30px -14px rgba(16,20,29,.35); border: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.rating strong { display: block; font-size: 20px; color: var(--text); }
.stars { color: #f5a623; letter-spacing: 2px; }
.stats { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: #fff; }
.stats .wrap { display: grid; grid-template-columns: repeat(3, 1fr); }
.stat { padding: 26px 24px; text-align: center; }
.stat + .stat { border-left: 1px solid var(--line); }
.stat strong { display: block; font-size: 30px; color: var(--brand); letter-spacing: -.02em; }
.stat span { color: var(--muted); font-size: 14px; }
section { padding: 72px 0; }
section.alt { background: var(--bg2); }
h2 { font-size: 32px; margin: 0 0 28px; letter-spacing: -.015em; }
.topics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
.topic { display: flex; gap: 16px; align-items: flex-start; text-align: left; background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 22px; font: inherit; color: inherit; cursor: pointer; transition: border-color .15s, box-shadow .15s, transform .15s; }
.topic:hover { border-color: var(--brand); box-shadow: 0 10px 30px -18px var(--brand); transform: translateY(-2px); }
.topic svg { flex: none; width: 44px; height: 44px; padding: 10px; border-radius: 12px; background: var(--brand-soft); stroke: var(--brand); }
.topic strong { display: block; font-size: 17px; margin-bottom: 4px; }
.topic span { color: var(--muted); font-size: 15px; }
.products { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; align-items: stretch; }
.product { position: relative; display: flex; flex-direction: column; gap: 14px; background: #fff; border: 1px solid var(--line); border-radius: 20px; padding: 28px; }
.product.top-pick { border: 2px solid var(--brand); box-shadow: 0 24px 50px -28px var(--brand); }
.product .tag { position: absolute; top: -13px; left: 24px; background: var(--brand); color: #fff; font-size: 12px; font-weight: 700; border-radius: 999px; padding: 3px 12px; }
.product h3 { margin: 0; font-size: 19px; }
.price strong { font-size: 32px; letter-spacing: -.02em; }
.price span { color: var(--muted); font-size: 14px; margin-left: 6px; }
.product ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; color: var(--muted); font-size: 15px; flex: 1; }
.product li::before { content: "✓"; color: var(--brand); font-weight: 800; margin-right: 10px; }
.product .btn { justify-content: center; }
.promo { background: linear-gradient(120deg, var(--brand), var(--brand-dark)); color: #fff; border-radius: 24px; padding: 40px 44px; display: flex; gap: 24px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.promo h3 { font-size: 26px; margin: 0 0 6px; }
.promo p { margin: 0; opacity: .9; max-width: 640px; }
.promo .btn { background: #fff; color: var(--brand); }
.reviews { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.review { background: #fff; border: 1px solid var(--line); border-radius: 18px; padding: 24px; display: flex; flex-direction: column; gap: 14px; }
.review q { quotes: "“" "”"; font-size: 16px; flex: 1; }
.who { display: flex; gap: 10px; align-items: center; font-size: 14px; }
.who i { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--brand-soft); color: var(--brand); font-style: normal; font-weight: 700; }
.who span { color: var(--muted); display: block; font-size: 13px; }
.news { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.post { border-radius: 18px; overflow: hidden; border: 1px solid var(--line); background: #fff; }
.post .img { height: 140px; display: grid; place-items: center; background: linear-gradient(135deg, color-mix(in srgb, var(--brand) 85%, white), var(--brand-dark)); color: #fff; }
.post:nth-child(2) .img { background: linear-gradient(135deg, #2b3445, color-mix(in srgb, var(--brand) 60%, #2b3445)); }
.post:nth-child(3) .img { background: linear-gradient(135deg, color-mix(in srgb, var(--brand) 25%, white), color-mix(in srgb, var(--brand) 55%, white)); color: var(--brand-dark); }
.post .img svg { width: 48px; height: 48px; opacity: .9; }
.post div.txt { padding: 18px 20px 22px; }
.post time { color: var(--muted); font-size: 13px; }
.post h3 { margin: 6px 0 10px; font-size: 17px; line-height: 1.35; }
.post a.more { color: var(--brand); font-weight: 650; font-size: 14px; }
.split { display: grid; grid-template-columns: 1.4fr 1fr; gap: 40px; }
details { border-bottom: 1px solid var(--line); padding: 16px 0; }
summary { cursor: pointer; font-weight: 650; font-size: 17px; }
details p { color: var(--muted); margin: 10px 0 0; }
.contact { background: var(--brand-soft); border-radius: 20px; padding: 28px; display: grid; gap: 12px; align-content: start; }
.contact .big { font-size: 24px; font-weight: 800; color: var(--brand); }
.contact .muted { color: var(--muted); font-size: 15px; }
footer { background: #10141d; color: #9aa3b2; font-size: 14px; padding: 56px 0 28px; }
.fgrid { display: grid; grid-template-columns: 1.4fr repeat(3, 1fr); gap: 32px; }
footer h4 { color: #fff; font-size: 14px; margin: 0 0 12px; }
footer ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
footer a:hover { color: #fff; }
footer .brand { color: #fff; margin-bottom: 12px; }
.fbottom { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; border-top: 1px solid #262c38; margin-top: 40px; padding-top: 20px; font-size: 13px; }
.fbottom .legal { display: flex; gap: 16px; flex-wrap: wrap; }
.demo-note { color: #6b7385; }
.cookie { position: fixed; left: 20px; bottom: 20px; z-index: 20; max-width: 380px; background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 18px 20px; box-shadow: 0 24px 50px -20px rgba(16,20,29,.4); font-size: 14px; }
.cookie strong { display: block; margin-bottom: 4px; }
.cookie p { margin: 0 0 14px; color: var(--muted); }
.cookie .row { display: flex; gap: 8px; }
.cookie[hidden] { display: none; }
@media (max-width: 900px) { nav, .top .btn-ghost, .utility .about { display: none; } .hero .wrap, .split { grid-template-columns: 1fr; } .topics, .products, .reviews, .news, .stats .wrap { grid-template-columns: 1fr; } .stat + .stat { border-left: 0; } .fgrid { grid-template-columns: 1fr 1fr; } .hero-card { transform: none; } .bubble { left: 0; } }
</style>
${messenger}
</head>
<body>
${o.messenger ? "" : `<div class="notice">${esc(t.notConnected)}</div>`}
<div class="utility"><div class="wrap">
  <span class="seg">${t.segments.map((s, i) => `<a href="#"${i === 0 ? ' class="on"' : ""}>${esc(s)}</a>`).join("")}</span>
  <span class="spacer"></span>
  <span class="about">${t.about.map((a) => `<a href="#">${esc(a)}</a>`).join(" &nbsp;·&nbsp; ")}</span>
  <span class="lang" role="group" aria-label="Language">${LANGS.map((l) => `<a href="#" data-lang="${l}"${l === o.lang ? ' class="on" aria-current="true"' : ""}>${l.toUpperCase()}</a>`).join("")}</span>
</div></div>
<header><div class="wrap top">
  <a class="brand" href="#">${logo}<span>${esc(o.brand)}</span></a>
  <nav>${c.nav.map((n) => `<a href="#">${esc(n)}</a>`).join("")}</nav>
  <span class="spacer"></span>
  <button class="icon-btn" type="button" aria-label="${esc(t.search)}">${icon("search")}</button>
  <a class="btn btn-ghost btn-small" href="tel:${esc(tel)}">${esc(o.phone)}</a>
  <button class="btn btn-primary btn-small" type="button">${icon("user")}${esc(t.login)}</button>
</div></header>
<main>
  <div class="hero"><div class="wrap">
    <div>
      <div class="badge"><b>${esc(c.stats[0]![0])}</b>${esc(c.stats[0]![1])}</div>
      <h1>${esc(c.heroTitle)}</h1>
      <p>${esc(c.heroText)}</p>
      <div class="actions"><button class="btn btn-primary" type="button" data-chat>${icon("chat")}${esc(c.cta)}</button><a class="btn btn-ghost" href="tel:${esc(tel)}">${esc(t.call)}</a></div>
      <div class="trust">${c.stats.slice(1).map(([v, l]) => `<span>${esc(v)} ${esc(l)}</span>`).join("")}</div>
    </div>
    <div class="visual">
      ${heroCard(o, c)}
      ${rated ? `<div class="rating">${stars}<strong>${esc(rated[0])}</strong>${esc(rated[1])}</div>` : ""}
      <button class="bubble" type="button" data-chat><span class="av">${icon("chat")}</span><div><b>${esc(o.brand)}</b><small>● ${esc(t.online)}</small><span>${esc(t.greeting)}</span></div></button>
    </div>
  </div></div>
  <div class="stats"><div class="wrap">${c.stats.map(([v, l]) => `<div class="stat"><strong>${esc(v)}</strong><span>${esc(l)}</span></div>`).join("")}</div></div>
  <section><div class="wrap">
    <h2>${esc(c.topicsTitle)}</h2>
    <div class="topics">${c.topics.map(([ic, title, text]) => `<button class="topic" type="button" data-chat>${icon(ic)}<div><strong>${esc(title)}</strong><span>${esc(text)}</span></div></button>`).join("")}</div>
  </div></section>
  <section class="alt"><div class="wrap">
    <h2>${esc(c.productsTitle)}</h2>
    <div class="products">${c.products
      .map(
        ([name, price, unit, features, popular]) =>
          `<div class="product${popular ? " top-pick" : ""}">${popular ? `<span class="tag">${esc(t.popular)}</span>` : ""}<h3>${esc(name)}</h3><div class="price"><strong>${esc(price)}</strong><span>${esc(unit)}</span></div><ul>${features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul><button class="btn ${popular ? "btn-primary" : "btn-ghost"}" type="button" data-chat>${esc(t.more)}</button></div>`,
      )
      .join("")}</div>
  </div></section>
  <section><div class="wrap"><div class="promo"><div><h3>${esc(c.promoTitle)}</h3><p>${esc(c.promoText)}</p></div><button class="btn" type="button" data-chat>${esc(c.cta)}</button></div></div></section>
  <section class="alt"><div class="wrap">
    <h2>${esc(t.reviewsTitle)}</h2>
    <div class="reviews">${c.reviews.map(([q, name, city]) => `<figure class="review" style="margin:0">${stars}<q>${esc(q)}</q><div class="who"><i>${esc(initials(name))}</i><div><b>${esc(name)}</b><span>${esc(city)}</span></div></div></figure>`).join("")}</div>
  </div></section>
  <section><div class="wrap">
    <h2>${esc(t.newsTitle)}</h2>
    <div class="news">${c.news.map(([days, title], i) => `<article class="post"><div class="img">${icon(c.topics[i]?.[0] ?? "star")}</div><div class="txt"><time>${esc(date(days))}</time><h3>${esc(title)}</h3><a class="more" href="#">${esc(t.readMore)} →</a></div></article>`).join("")}</div>
  </div></section>
  <section class="alt"><div class="wrap split">
    <div><h2>${esc(t.faq)}</h2>${c.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>
    <div class="contact"><h2 style="margin:0">${esc(t.contact)}</h2><a class="big" href="tel:${esc(tel)}">${esc(o.phone)}</a><div class="muted">${esc(c.hours)}</div><div class="muted">${esc(t.chatAnytime)}</div><button class="btn btn-primary" type="button" data-chat>${icon("chat")}${esc(c.cta)}</button></div>
  </div></section>
</main>
<footer><div class="wrap">
  <div class="fgrid">
    <div><a class="brand" href="#">${logo}<span>${esc(o.brand)}</span></a><div>${esc(company)}</div><div>${esc(t.address)}</div><div><a href="tel:${esc(tel)}">${esc(o.phone)}</a></div></div>
    <div><h4>${esc(t.footerCols[0]!)}</h4>${links(c.products.map((p) => p[0]))}</div>
    <div><h4>${esc(t.footerCols[1]!)}</h4>${links(t.service)}</div>
    <div><h4>${esc(t.footerCols[2]!)}</h4>${links(t.about)}</div>
  </div>
  <div class="fbottom"><span>© ${new Date().getFullYear()} ${esc(company)}. ${esc(t.rights)}</span><span class="legal">${t.legal.map((l, i) => `<a href="#"${i === t.legal.length - 1 ? " data-cookies" : ""}>${esc(l)}</a>`).join("")}</span><span class="spacer"></span><span class="demo-note">${esc(t.footer)}</span></div>
</div></footer>
<div class="cookie" id="cookie" hidden role="dialog" aria-label="${esc(t.cookieTitle)}"><strong>${esc(t.cookieTitle)}</strong><p>${esc(t.cookieText)}</p><div class="row"><button class="btn btn-primary btn-small" type="button" data-consent>${esc(t.cookieOk)}</button><button class="btn btn-ghost btn-small" type="button" data-consent>${esc(t.cookieNo)}</button></div></div>
<script nonce="${nonce}">
document.querySelectorAll("a[href='#']").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); }); });
document.querySelectorAll("[data-chat]").forEach(function (b) {
  b.addEventListener("click", function () {
    if (window.Genesys) window.Genesys("command", "Messenger.open");
    else alert(${js(t.notConnected)});
  });
});
document.querySelectorAll("[data-lang]").forEach(function (a) {
  a.addEventListener("click", function () {
    var u = new URL(location.href);
    u.searchParams.set("lang", a.getAttribute("data-lang"));
    location.href = u.toString();
  });
});
var cookie = document.getElementById("cookie");
try { if (!localStorage.getItem("site-cookies")) cookie.hidden = false; } catch (e) { cookie.hidden = false; }
document.querySelectorAll("[data-consent]").forEach(function (b) {
  b.addEventListener("click", function () { cookie.hidden = true; try { localStorage.setItem("site-cookies", "1"); } catch (e) {} });
});
document.querySelector("[data-cookies]").addEventListener("click", function () { cookie.hidden = false; });
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
