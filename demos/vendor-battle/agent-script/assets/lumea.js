/* Lumea – gemeinsame Daten, Zustand und Helfer für beide Script-Seiten.
   Persona und Falldaten: Stammdatenblatt "Familie Berger", Vendor Battle CSS 2026.
   Alle Daten sind fiktive Demo-Daten. */

/* =================== 1. Helfer =================== */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const QS = new URLSearchParams(location.search);

/* Im Agent Script laufen die Seiten in einem fremden iframe. Blockt der Browser dort
   den Speicher (Drittanbieter-Daten), kommt der Zustand von Seite 1 nie auf Seite 2 an.
   Das darf keine Aktion blockieren – deshalb wird es gemessen statt angenommen. */
const STORAGE_OK = (() => {
  if (QS.get('nostore') === '1') return false;      // zum Testen des gesperrten Falls
  try { localStorage.setItem('__probe', '1'); localStorage.removeItem('__probe'); return true; }
  catch (e) { return false; }
})();

const eur = (n, d = 2) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' €';
const eur0 = n => Math.round(n).toLocaleString('de-DE') + ' €';
const num  = (n, d = 0) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

const DAY = 86400000;
const day = n => new Date(Date.now() + n * DAY);
const dDate = d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dShort = d => d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: '2-digit' });

function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), 2200);
}

function copy(text, label) {
  const done = () => toast((label || 'Text') + ' kopiert');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Kopieren nicht möglich'); }
    ta.remove();
  }
}

/* =================== 2. Falldaten =================== */
const KWH        = 4750;      // abgerechneter Verbrauch
const KWH_PLAN   = 4200;      // Prognose laut Vertrag
const PRICE      = 0.368;     // ct/kWh -> €/kWh
const BASE_M     = 12.90;     // Grundpreis / Monat
const ABSCHLAG   = 138;       // monatlicher Abschlag
const WORK_COST  = KWH * PRICE;              // 1.748,00 €
const BASE_COST  = BASE_M * 12;              //   154,80 €
const BILL_TOTAL = WORK_COST + BASE_COST;    // 1.902,80 €
const PAID       = ABSCHLAG * 12;            // 1.656,00 €
const OPEN       = BILL_TOTAL - PAID;        //   246,80 €

const CONTRACT_END   = day(42);   // läuft in 6 Wochen aus
const NOTICE_DEADLINE = day(14);  // Kündigungsfrist 4 Wochen -> Handlungsfenster 14 Tage
const COMPLAINT_DATE  = day(-21); // Beschwerde vor 3 Wochen, unbeantwortet

const LUMEA = {
  kundennummer: 'LE-4827193',
  name: 'Markus & Sandra Berger',
  inhaber: 'Markus Berger',
  haushalt: '44 / 41 Jahre · 2 Kinder',
  wohnen: 'Eigenheim, Bj. 2009, 140 m², ländlicher Stadtrand',
  kundeSeit: 'März 2017',
  jahre: 9,
  anrede: 'Deutsch · Sie',
  kanalPref: 'Telefon (WhatsApp testweise)',
  appLogin: 'vor 11 Monaten',
  optin: 'E-Mail: ja · Telefon: nein',
  segment: 'Bestandskunde · mittlerer Wert · PV-Potenzial · gefährdet',
  tarif: 'LumeaPrivat Klassik',
  verbrauchPlan: KWH_PLAN,
  verbrauchIst: KWH,
  preis: PRICE,
  grundpreis: BASE_M,
  abschlag: ABSCHLAG,
  zahlweise: 'SEPA-Lastschrift',
  zahlhistorie: 'pünktlich, keine Mahnungen',
  gas: 'nicht bei Lumea (Wettbewerber)',
  pv: 'keine Anlage · Dach süd-ausgerichtet · hohes Potenzial',
  nps: 6,
  plz: '32547',
  ort: 'Bad Oeynhausen',
  segmentKurz: 'Privatkunde · Strom',
  caseAgeDays: 21,
  offen: OPEN,
  contractEnd: CONTRACT_END,
  noticeDeadline: NOTICE_DEADLINE,
  complaintDate: COMPLAINT_DATE,
  contacts12m: 6
};

/* Die Beschwerde-Mail im Wortlaut.
 *
 * Sie haengt an der E-Mail-Zeile der Kontakthistorie und klappt dort auf. Der Grund ist
 * derselbe wie beim Copy-Knopf daneben: Eine Historienzeile BEHAUPTET, dass es die Mail
 * gibt - hier steht sie. Auf der Buehne ist das der Unterschied zwischen "das System sagt,
 * er hat geschrieben" und "hier ist, was er geschrieben hat".
 *
 * Der Text nimmt dem Agenten nichts vorweg, was er nicht ohnehin gleich sagt: Er nennt die
 * 246,80 Euro, die 138 Euro Abschlag und die Wechselandrohung - alle drei stehen schon auf
 * dem Schirm bzw. kommen in Szene 4 und 5. Er liefert nur den Beleg dafuer, dass der Kunde
 * es SELBST schon geschrieben hatte und niemand reagiert hat.
 */
const MAIL_BESCHWERDE = {
  von: 'markus.berger@muster.de',
  an: 'service@lumea-energie.de',
  betreff: 'Widerspruch Jahresabrechnung ' + String(new Date().getFullYear() - 1) +
           ' – Kundennummer LE-4827193',
  text: [
    'Sehr geehrte Damen und Herren,',
    'ich habe heute meine Jahresabrechnung für ' + String(new Date().getFullYear() - 1) +
      ' erhalten und soll 246,80 Euro nachzahlen. Das kann nicht stimmen, und ich bin damit ' +
      'nicht einverstanden.',
    'Wir verbrauchen nicht mehr Strom als in den Vorjahren – wir sind dieselben zwei ' +
      'Erwachsenen mit zwei Kindern im selben Haus. Mein Abschlag liegt seit Jahren ' +
      'unverändert bei 138 Euro, und niemand von Ihnen hat mich je darauf hingewiesen, dass ' +
      'der zu niedrig sein könnte. Jetzt kommt die Rechnung auf einmal, und ich soll zahlen.',
    'Ich bitte um Prüfung der Abrechnung und um eine nachvollziehbare Erklärung, wie dieser ' +
      'Betrag zustande kommt. Und ich erwarte eine Antwort – nicht in vier Wochen.',
    'Ich bin seit neun Jahren Kunde bei Ihnen und habe immer pünktlich gezahlt. Wenn sich ' +
      'das nicht zügig klären lässt, werde ich mich nach einem anderen Anbieter umsehen.',
    'Mit freundlichen Grüßen\nMarkus Berger',
  ],
};

/* Kontakt- und Erlebnishistorie (12 Monate) */
const HISTORY = [
  { d: day(-330), ch: 'Telefon',  cls: '',    t: 'Frage zur Preisanpassung',
    x: 'Erläuterung Arbeitspreis, Kunde akzeptiert. AHT 6:12.', s: 0 },
  { d: day(-300), ch: 'Telefon',  cls: '',    t: 'Zählerstand nachgemeldet',
    x: 'Selbstablesung erfasst, keine Rückfrage.', s: 0 },
  { d: day(-240), ch: 'Telefon',  cls: 'pos', t: 'Anfrage dynamischer Tarif LumeaFlex',
    x: 'Interesse geäußert, kein Abschluss – Smart Meter fehlte. Kein Follow-up erfolgt.', s: 1 },
  { d: day(-210), ch: 'WhatsApp', cls: '',    t: 'Rechnungskopie angefordert',
    x: 'Im Self-Service gelöst, Zufriedenheit hoch.', s: 1 },
  { d: day(-180), ch: 'Survey',   cls: '',    t: 'NPS-Befragung: 6/10',
    x: '„Preis in Ordnung, Erreichbarkeit ausbaufähig."', s: 0 },
  { d: day(-150), ch: 'Telefon',  cls: '',    t: 'Frage zur Abschlagshöhe',
    x: 'Abschlag bei 138 € belassen – im Rückblick zu niedrig kalkuliert.', s: 0 },
  { d: day(-25),  ch: 'Brief',    cls: '',    t: 'Jahresabrechnung versendet',
    x: 'Nachzahlung ' + eur(OPEN) + ' – kein proaktiver Hinweis vorab.', s: -1 },
  { d: day(-21),  ch: 'E-Mail',   cls: 'neg', t: 'Beschwerde Jahresabrechnung – unbeantwortet',
    x: 'Im Sammelpostfach Abrechnung eingegangen. 21 Tage ohne Antwort, keine Zuständigkeit, ' +
       'kein Vorgang – niemand hat je davon erfahren.', s: -2, mail: MAIL_BESCHWERDE }
  // HIER STAND DAS LAUFENDE WHATSAPP-GESPRAECH. Raus am 23.09.2026: Der aktuelle Kontakt
  // gehoert nicht in die Historie - er laeuft gerade, der Agent hat ihn vor sich. Eine
  // Zeile "heute, Bot-Kontakt" in der Vergangenheitsliste liest sich, als waere die Demo
  // schon einmal gelaufen. Die Historie endet jetzt bei der unbeantworteten E-Mail, und
  // genau das ist die Zeile, auf die Szene 3 zeigt.
  // Folge: acht Eintraege statt neun. Kachel und Registerkarten-Abzeichen rechnen aus
  // HISTORY.length, die Bühnensätze sagen "acht Kontakte".
];

/* Identitätsauflösung – warum dieser WhatsApp-Kontakt dieser Kunde ist.
   Der Bot hat über die Mobilnummer auf den External Contact im Lumea CRM aufgelöst;
   der Gesprächsinhalt selbst steht im Copilot-Panel, nicht hier. */
const IDENTITY = [
  ['WhatsApp',        '@{param:customerPhone.masked}',  'verifiziert', 'green'],
  ['Mobil',           '@{param:customerPhone.masked}',  'hinterlegt',  'grey'],
  ['E-Mail',          'markus.berger@••••••.de', 'Beschwerdekanal', 'amber'],
  ['Kontaktdatensatz','4f5ccd23…61f59',      'Kundenplattform', 'blue'],
  ['Vertragskonto',   'VK-2291-4827193',     'Abrechnungssystem', 'blue']
];

/* Drei Abrechnungsjahre – zeigt, dass der Abschlag nie nachgezogen wurde */
const YEARS = [
  { y: '2023', kwh: 4180, back: 37.04 },
  { y: '2024', kwh: 4310, back: 84.88 },
  { y: '2025', kwh: KWH, back: OPEN, now: true }
];

/* =================== 3. Gemeinsamer Zustand (beide Seiten) =================== */
const STATE_KEY = 'lumea.vendorbattle.v1';
const DEFAULT_STATE = {
  // Abrechnung (Seite 1)
  abschlagFixed: false,
  abschlagNeu: null,       // der vom Agenten eingetragene Betrag
  committed: false,        // Korrektur erfasst -> gibt Seite 2 frei
  committedAt: null,
  // Angebot (Seite 2)
  angebotCase: null,       // Referenz des Angebots-Case, z. B. ANG-4
  angebotCaseId: null,
  angebotCaseAt: null,
  angebotFehler: null,
  smsGesendet: false,      // Bestätigung auf den hinterlegten Kanal
  smsAn: null,
  smsAt: null,
  smsFehler: null,
  // Vorgangsbearbeitung (Seite 3)
  wiBuchung: null,
  wiDokument: null,
  wiPvLead: null,
  wiBestaetigung: null,
  session: null            // Kennung des Serverlaufs, siehe unten
};

const Store = {
  /* Der Zustand lebt immer im Speicher des Fensters. Der localStorage ist nur die
     Brücke zur anderen Script-Seite – ist er im Agent-Script-iframe gesperrt, darf
     das keinen Knopf lahmlegen. Genau das ist vorher passiert: ein geworfener
     Zugriff im Abgleich-Intervall hat den Rest des Skripts mitgerissen. */
  _mem: null,

  _raw() {
    if (!STORAGE_OK) return null;
    try { return localStorage.getItem(STATE_KEY); } catch (e) { return null; }
  },

  read() {
    const raw = this._raw();
    if (raw) {
      try { return { ...DEFAULT_STATE, ...JSON.parse(raw) }; } catch (e) { /* kaputt: ignorieren */ }
    }
    return this._mem ? { ...this._mem } : { ...DEFAULT_STATE };
  },

  write(s) {
    this._mem = { ...s };
    if (STORAGE_OK) {
      try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) {}
    }
    this._last = JSON.stringify(s);
    S = s;
    (this._subs || []).forEach(fn => fn(s));
  },

  patch(p) { const s = { ...this.read(), ...p }; this.write(s); return s; },

  reset() {
    this._mem = null;
    if (STORAGE_OK) { try { localStorage.removeItem(STATE_KEY); } catch (e) {} }
    this._last = null; S = this.read();
    (this._subs || []).forEach(fn => fn(S));
  },

  /* Änderungen der jeweils anderen Script-Seite übernehmen. Ohne Speicher gibt es
     nichts abzugleichen – dann läuft kein Intervall. */
  onChange(fn) {
    (this._subs = this._subs || []).push(fn);
    if (!STORAGE_OK || this._poll) return;
    this._last = this._raw();
    this._poll = setInterval(() => {
      const cur = this._raw();
      if (cur !== this._last) {
        this._last = cur; S = this.read();
        (this._subs || []).forEach(f => f(S));
      }
    }, 700);
  }
};
let S = Store.read();
if (QS.get('reset') === '1') Store.reset();

/* Jeder Serverstart ist eine neue Sitzung: Kennung holen und den Zustand verwerfen,
   wenn er von einem frueheren Lauf stammt. So genuegt ein Neustart (Stop und Start in der gctk UI),
   um die Demo in den Ausgangszustand zu bringen - ohne Browserdaten zu loeschen. */
fetch('/api/session', { cache: 'no-store' })
  .then(r => r.json())
  .then(({ session }) => {
    if (!session || S.session === session) return;
    Store.reset();
    Store.patch({ session });
  })
  .catch(() => { /* ohne Server laeuft die Seite weiter, nur ohne Ruecksetzen */ });

/* Hier stand bis zum 19.09.2026 ein Wertmodell: Churn-Score, CLV, erwartete
   Restlaufzeit, NPS, Kohorten-Hochrechnung. Es ist ersatzlos entfallen.

   Der Grund ist die eigene Regel der Demo - "was Genesys nativ kann, zeigen wir nativ;
   ein Nachbau daneben sagt der Jury, dass die Plattform es nicht kann". Ein CLV-Rechner
   in einer selbstgebauten Maske ist ein Nachbau, und er war der komplexeste Teil der
   ganzen Demo: eine Formel, die erklaert werden muss, auf einer Buehne mit zwoelf
   Minuten. Seit der Auswertungsblock ueber Folien laeuft, hat er dort sein Zuhause -
   dort steht die Zahl neben ihrer Herleitung und kostet keine Bildschirmflaeche.

   Was blieb: die Deckungsbeitraege des Angebots stehen jetzt als schlichte Produktdaten
   in ANGEBOT (nba.html). Das ist eine Angabe aus dem Katalog, kein Modell. */

/* =================== 5. Rahmen: Kopfleiste, Datensatz, Seitenreiter ===========
   Bewusst wie eine Fachanwendung aufgebaut: oben das System, darunter der
   Datensatz, darunter die Registerkarten. Die Falldaten stecken in LUMEA –
   die Maske selbst kennt keinen Einzelfall. */

const PAGES = [
  { id: 1, file: 'cockpit.html', label: 'Kundenakte' },
  { id: 2, file: 'nba.html',     label: 'Beratung & Angebot' },
];

function renderChrome(active) {
  const agent = QS.get('agent') || 'Agent';
  const queue = QS.get('queue') || 'Lumea Kundenservice';
  const conv  = QS.get('conversation') || QS.get('interaction') || '';
  const q = location.search || '';

  const bar = document.createElement('header');
  bar.className = 'appbar';
  bar.innerHTML = `
    <img class="logo" src="assets/lumea_logo.png?v=5" alt="Lumea Energie & Smart Home">
    <div class="app">ServiceCockpit<span>Kundenbetreuung Privatkunden</span></div>
    <div class="sp"></div>
    <div class="meta">
      <div><div class="k">Bearbeiter</div><div class="v">${agent}</div></div>
      <div><div class="k">Warteschlange</div><div class="v">${queue}</div></div>
      ${conv ? `<div><div class="k">Interaktion</div><div class="v">${conv.slice(0, 8)}</div></div>` : ''}
    </div>`;
  document.body.prepend(bar);

  const rec = document.createElement('div');
  rec.className = 'record';
  rec.innerHTML = `
    <div class="who">
      <h1>${LUMEA.name}</h1>
      <div class="sub">Kundennummer <b>${LUMEA.kundennummer}</b> ·
        Kunde seit ${LUMEA.kundeSeit} · ${LUMEA.wohnen.split(',')[0]} · ${LUMEA.plz} ${LUMEA.ort}</div>
    </div>
    <div class="chips" id="recChips"></div>
    <div class="sp"></div>`;
  bar.after(rec);

  const nav = document.createElement('nav');
  nav.className = 'tabs';
  nav.innerHTML = PAGES.map(p =>
    `<button aria-selected="${p.id === active}" onclick="location.href='${p.file}${q}'">${p.label}</button>`
  ).join('') + `<div class="sp" style="flex:1"></div>`;
  rec.after(nav);

  /* Hier lief eine Gespraechsdauer im Sekundentakt. Entfallen am 22.09.2026:
     Eine mitlaufende Uhr in der Kopfleiste zieht auf einem geteilten Bildschirm
     staendig den Blick - und auf der Buehne sagt sie nichts aus, weil das Tempo
     der Demo nicht das Tempo eines echten Gespraechs ist. */

  // Die Kopfzeile traegt nur noch das Segment.
  //
  // Bis zum 18.09.2026 standen hier zusaetzlich "Abwanderungsrisiko 78 %" und "Vorgang
  // offen · 21 Tage". Beide sind raus: Auf dem kleinen Buehnenschirm konkurriert eine
  // Prozentzahl in der Kopfleiste mit dem, worauf der Agent gerade zeigt - und eine Zahl,
  // die nicht erklaert wird, laesst das Publikum raten.
  //
  // Einen Tag spaeter ist der Score ganz entfallen: Die Demo rechnet keinen mehr, der
  // Wertbeitrag steht auf Folien. Dass der Kunde gefaehrdet ist, steht als Segment im
  // Klartext in der Kundenakte; dass der Vorgang offen und ueberfaellig ist, zeigt
  // Szene 3 am Vorgang selbst.
  const chips = () => {
    const el = $('#recChips'); if (!el) return;
    el.innerHTML = `<span class="chip">${LUMEA.segmentKurz}</span>`;
  };
  chips(); Store.onChange(chips);
}

/* Registerkarten innerhalb einer Seite. Erwartet .tabs mit data-tab und
   .tabpanel mit passender id. */
function initTabs(navSel, opts = {}) {
  const nav = $(navSel); if (!nav) return;
  const show = id => {
    $$('.tabpanel').forEach(p => { p.hidden = p.id !== 'tab-' + id; });
    $$(navSel + ' button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    if (opts.onShow) opts.onShow(id);
  };
  $$(navSel + ' button').forEach(b => b.onclick = () => show(b.dataset.tab));
  show(QS.get('tab') || opts.initial || nav.querySelector('button').dataset.tab);
}

/* =================== 6. Statuszeile =================== */
function renderStatusbar(sources) {
  const f = document.createElement('div');
  f.className = 'statusbar';
  const stamp = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  f.innerHTML =
    `<span>Datenstand <b>${stamp}</b></span>` +
    (sources || []).map(s => `<span>${s}</span>`).join('') +
    `<span class="sp"></span><span>Testmandant · fiktive Daten</span>`;
  const b = document.createElement('button');
  b.className = 'btn sm';
  b.textContent = 'Sitzung zurücksetzen';
  b.onclick = () => { Store.reset(); toast('Sitzung zurückgesetzt'); location.reload(); };
  f.appendChild(b);
  document.body.appendChild(f);
}
