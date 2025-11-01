// board-interaction.js - Funktionen für das interaktive Board
/* --- GLOBALS & NORMALISIERUNG ------------------------------------------- */
window.sessionData    = window.sessionData    || null;
window.boardType      = window.boardType      || 'board1';
window.cards          = window.cards          || [];
window.notes          = window.notes          || [];
window.participants   = window.participants   || [];

// ==== Debounced DB-Save (bündelt alle Saves & speichert nur bei Änderungen) ====
let _saveTimer = null;
let _saveInFlight = false;
let _lastStateHash = '';

// ---- RT-Owner-Priorität & Koordinaten-Helper ---------------------
const RT_PRI = () => (isOwner() ? 2 : 1);
const RT_LAST = new Map(); // key -> { prio, ts, sender }

function shouldApply(objKey, incomingPrio, now = performance.now(), senderId = null) {
  const last = RT_LAST.get(objKey);
  if (!last) {
    RT_LAST.set(objKey, { prio: incomingPrio, ts: now, sender: senderId });
    return true;
  }
  const fresh = (now - last.ts) <= 150;
  const sameSender = senderId && last.sender && senderId === last.sender;
  const ok = !fresh || sameSender || (incomingPrio > last.prio);
  if (ok) RT_LAST.set(objKey, { prio: incomingPrio, ts: now, sender: senderId });
  return ok;
}

window.normalizeCardZIndex = window.normalizeCardZIndex || function(el){
  // Karten über Notizen, aber unter aktivem Drag halten
  try {
    const base = 1100;
    if (el) el.style.zIndex = String(Math.max(base, parseInt(el.style.zIndex||'0', 10) || base));
  } catch {}
};

// Board-Rechteck holen
function getStage() {
  return document.querySelector('.board-area') || document.body;
}
function getStageRect() {
  return getStage().getBoundingClientRect();
}


function getScaleX(){
  const a = document.querySelector('.board-area');
  return parseFloat(a?.dataset.scaleX || a?.dataset.scale || '1') || 1;
}
function getScaleY(){
  const a = document.querySelector('.board-area');
  return parseFloat(a?.dataset.scaleY || a?.dataset.scale || '1') || 1;
}

function getScale(){
  const area = document.querySelector('.board-area');
  return parseFloat(area?.dataset.scale || '1') || 1;
}


function getStageSizeUnscaled() {
  // Keine abgeleiteten „scaled rects“ dividieren – nimm die echte Weltgröße
  return getWorldSize(); // { width, height } = fixe Welt-Pixel
}

// --- Kanonische Weltgröße + Viewport-Fit (GLOBAL) ---
function getWorldSize() {
  const area = document.querySelector('.board-area');
  if (!area) return { width: 2400, height: 1350 }; // Fallback

  // Wenn gesetzt, diese *kanonischen* Pixel verwenden:
  const dw = Number(area.dataset.worldW || area.dataset.worldw || 0);
  const dh = Number(area.dataset.worldH || area.dataset.worldh || 0);
  if (dw > 0 && dh > 0) return { width: dw, height: dh };

  // Sonst: unskalierte Layoutgröße (offsetWidth/Height ignorieren CSS-Transforms)
  return { width: area.offsetWidth, height: area.offsetHeight };
}

function fitBoardToViewport() {
  const area = document.querySelector('.board-area');
  if (!area) return;

  // Feste Board-Welt (kommt aus data-world-w/h)
  const { width: worldW, height: worldH } = getWorldSize();

  // WP-Adminbar berücksichtigen
  const adminBarH = document.getElementById('wpadminbar')?.offsetHeight || 0;

  // Viewport
  const vw = window.innerWidth  || document.documentElement.clientWidth;
  const vhTotal = window.innerHeight || document.documentElement.clientHeight;
  const vh = vhTotal - adminBarH;

  // --- Fit to width: keine horizontalen Ränder ---
  const scale = vw / worldW;
  const offX  = 0;                 // bündig links
  const offY  = adminBarH;         // unter die Adminbar (oben bündig)

  // Canvas/Welt auf fixe Pixel setzen und transformieren
  area.style.transformOrigin = 'top left';
  area.style.width  = worldW + 'px';
  area.style.height = worldH + 'px';
  area.style.position = 'fixed';
  area.style.left = '0';
  area.style.top  = '0';
  area.style.margin = '0';
  area.style.padding = '0';
  area.style.transform = `translate(${offX}px, ${offY}px) scale(${scale})`;

  // für Eingabemapping: aktuelle Scale/Offsets ablegen
  area.dataset.scaleX = area.dataset.scaleY = area.dataset.scale = String(scale);
  area.dataset.offsetX = String(offX);
  area.dataset.offsetY = String(offY);
}


// holt Props aus w.props ODER (legacy) top-level w.foo
function gprop(w, key, def) {
  if (w && w.props && w.props[key] !== undefined) return w.props[key];
  if (w && w[key]   !== undefined) return w[key];
  return def;
}

function hexToRgba(hex, alpha = 1) {
  const h = (hex||'').replace('#','');
  const s = h.length === 3 ? h.split('').map(c=>c+c).join('') : h;
  const r = parseInt(s.slice(0,2)||'00',16);
  const g = parseInt(s.slice(2,4)||'00',16);
  const b = parseInt(s.slice(4,6)||'00',16);
  return `rgba(${r},${g},${b},${alpha})`;
}


function toNorm(px, py) {
  const { width, height } = getStageSizeUnscaled();
  return { nx: px / width, ny: py / height };
}

function fromNorm(nx, ny) {
  const { width, height } = getStageSizeUnscaled();
  return { x: nx * width, y: ny * height };
}

// Karten analog:
function toNormCard(px, py)   { return toNorm(px, py); }
function fromNormCard(nx, ny) { return fromNorm(nx, ny); }

// Liefert ein schlankes Template-Objekt (egal welche Rohform ankommt)
function normalizeTemplate(raw) {
  if (!raw) return null;
  const tpl = raw.template || raw.board || raw; // erlaubte Varianten
  const widgets = Array.isArray(tpl.widgets) ? tpl.widgets : [];
  return {
    worldW: tpl.worldW || tpl.width  || tpl.w || null,
    worldH: tpl.worldH || tpl.height || tpl.h || null,
    bgColor: tpl.bgColor || tpl.backgroundColor || null,
    bgImage: tpl.bgImage || tpl.backgroundImage || null,
    widgets
  };
}

// 1st: /app/assets/boards/<slug>/board.json
// 2nd: /wp-json/cc/v1/boards/<slug> (liefert { template: {...} })
// 3rd: sinnvolles Minimal-Template (kein harter Fehler)
async function fetchBoardTemplate(slug) {
  const safe = (slug || '').toString().trim().toLowerCase();

  // 1) Bevorzugt: statisches Asset / Node (gleiche Origin)
  try {
    const url = `/app/assets/boards/${safe}/board.json?ts=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      const asText = JSON.stringify(json||{});
      if (!/not\s*found|nicht\s*gefunden/i.test(asText) && !json?.error && json?.status !== 'not_found') {
        return normalizeTemplate(json);
      }
    } else if (res.status !== 404) {
      throw new Error(`HTTP ${res.status} beim Laden von ${url}`);
    }
  } catch (e) {
    console.debug('[TPL] asset/node fetch fail', e);
  }

  // 2) Optionaler Fallback: WordPress-REST (wenn vorhanden)
  try {
    const wpUrl = `/wp-json/cc/v1/boards/${encodeURIComponent(safe)}`;
    const r = await fetch(wpUrl, { cache: 'no-store' });
    if (r.ok) {
      const data = await r.json();
      const tpl  = data?.template || data?.board_template || data;
      const norm = normalizeTemplate(tpl);
      if (norm) return norm;
    }
  } catch (e) {
    console.debug('[TPL] wp-rest fetch fail (ok wenn WP-Route nicht existiert)', e);
  }

  console.warn(`[TPL] kein Template gefunden für "${safe}" – nutze Basis-Template`);
  return { worldW: 2400, worldH: 1350, bgColor: '#f9ecd2', bgImage: null, widgets: [] };
}


// applySampleCardFromTemplate(): bgMap unterstützen
function applySampleCardFromTemplate(tpl) {
  const sample = tpl?.widgets?.find?.(w => w.type === 'sampleCard');
  if (!sample) return;

  const W = Array.isArray(tpl.widgets) ? tpl.widgets : [];

  // Aktives Format vorrangig aus Cardset (applyDeckFormatRatio)
  const activeFmt = (window.CARDSET_FORMAT && String(window.CARDSET_FORMAT)) ||
                    String(gprop(sample, 'format', '') || '');

  // ► Neu: bgMap (format -> bgId) nutzen; Legacy: bgId als Fallback
  const bgMap = gprop(sample, 'bgMap', null);
  let linkId = (bgMap && activeFmt && bgMap[activeFmt]) || gprop(sample, 'bgId', null);
  let box = linkId ? W.find(w => w.type === 'bgrect' && w.id === linkId) : null;
  window.__CARD_BG_ID__ = (linkId || (box && box.id)) || null;

  const PAD = 20;

  // Ratio dynamisch (von applyDeckFormatRatio gesetzt)
  const ratioVar = getComputedStyle(document.documentElement).getPropertyValue('--card-ratio').trim();
  const RATIO = ratioVar ? parseFloat(ratioVar) : (window.RATIO || (260/295));

  // Formatspezifische Kartengröße
  const fmtSizes = gprop(sample, 'formatSizes', null); // { '2:3':{w,h}, ... }
  let cw = 0, ch = 0;
  if (fmtSizes && activeFmt && fmtSizes[activeFmt]) {
    cw = Number(fmtSizes[activeFmt].w) || 0;
    ch = Number(fmtSizes[activeFmt].h) || 0;
  }

  // Legacy-Fallbacks (alte Boards)
  if (!cw || !ch) {
    cw = Number(gprop(sample, 'cardWidth',  0)) || 0;
    ch = Number(gprop(sample, 'cardHeight', 0)) || 0;
    if (!cw && sample.w) cw = Math.round(sample.w);
    if (!ch && sample.h) ch = Math.round(sample.h);
  }

  // Box über Geometrie ableiten, falls keine verlinkt
  if (!box) {
    box = W.filter(w => w.type === 'bgrect')
           .find(b => (sample.x >= b.x && sample.x <= b.x + b.w &&
                       sample.y >= b.y && sample.y <= b.y + b.h));
  }

  // Wenn Kartengröße fehlt: best-fit in Box
  if ((!cw || !ch) && box && Number.isFinite(box.w) && Number.isFinite(box.h)) {
    const bw = Number(gprop(box, 'borderWidth', 0)) || 0;
    const availW = Math.max(40, (box.w - 2*PAD - 2*bw));
    const availH = Math.max(40, (box.h - 2*PAD - 2*bw));
    const byW = { w: availW,          h: availW * RATIO };
    const byH = { w: availH / RATIO,  h: availH         };
    if (byW.h <= availH) { cw = Math.round(byW.w); ch = Math.round(byW.h); }
    else                 { cw = Math.round(byH.w); ch = Math.round(byH.h); }
  }

  if (!cw || !ch) { cw = 260; ch = Math.round(cw * (260/295)); }

  // Maße spiegeln
  sample.cardWidth = cw; sample.cardHeight = ch;
  sample.w = cw; sample.h = ch;
  document.documentElement.style.setProperty('--card-w', String(cw) + 'px');

  // ► Formatspezifische Boxmaße (sizeByFormat) respektieren, sonst ableiten
  if (box) {
    const bw = Number(gprop(box, 'borderWidth', 0)) || 0;
    const boxSizes  = gprop(box, 'sizeByFormat', null) || gprop(box, 'formatSizes', null);
    const boxManual = gprop(box, 'manualSizeByFormat', null) || gprop(box, 'formatSizeManual', null);
    let useW = 0, useH = 0;
    if (boxSizes && activeFmt && boxSizes[activeFmt]) {
      useW = Number(boxSizes[activeFmt].w) || 0;
      useH = Number(boxSizes[activeFmt].h) || 0;
    }
    const isManual = !!(boxManual && activeFmt && boxManual[activeFmt]);
    if ((!useW || !useH) && !isManual) {
      useW = cw + 2*PAD + 2*bw;
      useH = ch + 2*PAD + 2*bw;
    }
    if (useW && useH) { box.w = useW; box.h = useH; }
  }
}




/* === Z-Index Helper global bereitstellen (fix für RT.ws.onmessage) === */
if (!window.getHighestInteractiveZIndex) {
  window.getHighestInteractiveZIndex = function () {
    const interactive = [
      ...Array.from(document.querySelectorAll('.card')).filter(c => !c.closest('#card-stack')),
      ...Array.from(document.querySelectorAll('.notiz')),
    ];
    let highest = 1199;
    interactive.forEach(el => {
      const z = parseInt(getComputedStyle(el).zIndex, 10);
      if (!isNaN(z) && z > highest) highest = z;
    });
    return highest;
  };
}

if (!window.normalizeCardZIndex) {
  window.normalizeCardZIndex = function (card) {
    const newZ = Math.max(window.getHighestInteractiveZIndex() + 1, 1200);
    card.style.zIndex = String(newZ);
  };
}

// Backward-compat: lokaler Alias, falls irgendwo "normalizeCardZIndex(...)" direkt aufgerufen wird
// (damit muss sonst kein weiterer Code angepasst werden)
if (typeof window.normalizeCardZIndex === 'function' && typeof normalizeCardZIndex === 'undefined') {
  var normalizeCardZIndex = window.normalizeCardZIndex;
}

// Wartet kurz auf CC_INIT (postMessage) oder gibt nach Timeout auf
function waitForBootConfig(timeoutMs = 800) {
  return new Promise((resolve) => {
    // Schon vorhanden? sofort weiter
    if (window.CC_BOOT && (window.CC_BOOT.board || (window.CC_BOOT.session && (window.CC_BOOT.session.board || window.CC_BOOT.session.board_template)))) {
      return resolve(true);
    }
    // Auf CC_INIT warten
    const onMsg = (ev) => {
      const d = ev.data || {};
      if (d.type === 'CC_INIT' && d.config) {
        window.removeEventListener('message', onMsg);
        resolve(true);
      }
    };
    window.addEventListener('message', onMsg);
    // Fallback: nach timeout weiter
    setTimeout(() => {
      window.removeEventListener('message', onMsg);
      resolve(false);
    }, timeoutMs);
  });
}


// ---- NOTE/NOTIZ: robustes Erzeugen & Selektieren -----------------
function ensureNotesContainer() {
  return document.getElementById('notes-container')
      || document.querySelector('.notes-container')
      || document.getElementById('session-board')  // Fallback
      || document.querySelector('.board-area');
}

function ensureNoteEl(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'notiz';
    el.id = id;
    const content = document.createElement('div');
    content.className = 'notiz-content';
    content.setAttribute('contenteditable', 'false');
    el.appendChild(content);
    ensureNotesContainer().appendChild(el);
    L('DOM_CREATE', { id });
  } else {
    L('DOM_REUSE', {
      id,
      locked: el.dataset.locked,
      by: el.dataset.lockedBy,
      until: el.dataset.lockedUntil,
      isEditingClass: el.classList.contains('is-editing')
    });
  }

  // Content-Element robust finden
  const content = el.querySelector('.notiz-content') || el.querySelector('.note-content');

  // immer die Handler/Beobachter setzen
  try { attachNoteResizeObserver && attachNoteResizeObserver(el); } catch {}
  try { attachNoteAutoGrow && attachNoteAutoGrow(el); } catch {}
  try { setupNoteEditingHandlers && setupNoteEditingHandlers(el); } catch {}
  try { enhanceDraggableNote && enhanceDraggableNote(el); } catch {}

  // Falls versehentlich gelockt: entsperren (nur Erzeugung, kein Editing!)
  delete el.dataset.locked;
  el.classList.remove('is-editing');

  return { el, content };
}

function isLockActiveForMe(note) {
  const locked = note && note.dataset.locked === '1';
  if (!locked) return false;

  const me = (window.RT && RT.uid) ? String(RT.uid) : '';
  const by = note.dataset.lockedBy ? String(note.dataset.lockedBy) : '';
  const until = parseInt(note.dataset.lockedUntil || '0', 10) || 0;
  const expired = until && Date.now() > until;
  L('LOCK_CHECK', { id: note?.id, locked, by, me, until, expired, isEditingClass: note?.classList?.contains('is-editing') });

  if (!locked) return false;
  // Abgelaufene Locks lokal „hart“ aufräumen
  if (expired) {
    delete note.dataset.locked;
    delete note.dataset.lockedBy;
    delete note.dataset.lockedUntil;
    note.classList.remove('is-editing');
    L('LOCK_EXPIRED_CLEANED', { id: note.id });
    return false;
  }

  // Lock blockiert nur, wenn er von jemand anderem stammt
  return !!by && by !== me;
}

// --- Notiz-Text robust auslesen/setzen -----------------------------
function getNoteContentEl(note) {
  return note.querySelector('.notiz-content') || note.querySelector('.note-content');
}

function getNoteText(note) {
  const el = getNoteContentEl(note);
  if (!el) return '';
  // &nbsp; → Space, CRLF → LF, echte Zeilenumbrüche aus innerText
  return el.innerText.replace(/\u00A0/g, ' ').replace(/\r\n/g, '\n');
}

function setNoteText(note, text) {
  const el = getNoteContentEl(note);
  if (el) el.textContent = text || '';
}

function placeCardInStackInstant(el, data) {
  const stack = document.getElementById('cards-container') || document.querySelector('.cards-container');
  if (!stack) return;
  // Transitions kurz aus
  const prev = el.style.transition;
  el.style.transition = 'none';
  // Container: stapel
  stack.appendChild(el);
  // Flip-Status exakt gemäß Snapshot setzen (keine Flip-Animation!)
  if (data.flipped) el.classList.add('flipped'); else el.classList.remove('flipped');
  // Absolutposition/Z-Index hart setzen (ohne "fliegen")
  if (typeof data.x === 'number') el.style.left = data.x + 'px';
  if (typeof data.y === 'number') el.style.top  = data.y + 'px';
  if (typeof data.z === 'number') el.style.zIndex = String(data.z);
  // Reflow und Transition zurück
  void el.offsetHeight;
  el.style.transition = prev || '';
}


// ---- Focus Note: Live-Editing für Owner & Gäste --------------------------
function initFocusNoteLive() {
  const editable = document.getElementById('focus-note-editable');
  const display  = document.getElementById('focus-note-display');
  if (!editable || !display) return;

  // Editor öffnen, wenn auf Anzeige geklickt wird
  display.addEventListener('click', () => {
    // nur wenn Editieren erlaubt ist
    if (!editable.isContentEditable) return;

    display.style.display  = 'none';
    editable.style.display = 'block';

    // Caret ans Ende setzen
    const sel = window.getSelection();
    const rng = document.createRange();
    rng.selectNodeContents(editable);
    rng.collapse(false);
    sel.removeAllRanges(); sel.addRange(rng);
    editable.focus();
  });

  // Editor schließen auf Blur oder Enter (ohne Shift)
  function closeEditor(){ editable.style.display = 'none'; display.style.display = 'flex'; }
  editable.addEventListener('keydown', (e) => {
    // Enter erzeugt einen normalen Absatz – NICHT beenden
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      // nichts tun → Browser fügt Zeilenumbruch ein
      return;
    }
    // Optional: STRG/⌘+Enter beendet Editieren
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      editable.blur();
    }
  });
  editable.addEventListener('blur', closeEditor);

  // Platzhalter-Text
  const PH = 'Schreiben sie hier die Focus Note der Sitzung rein';

  // Anti-Echo beim Anwenden entgegengenommener Updates
  let setByRemote = false;
  window.__ccSetFocusNote = (txt) => {
    setByRemote = true;
    const t = (txt || '');
    editable.textContent = t;
    const trimmed = t.trim();
    display.textContent = trimmed || PH;
    display.classList.toggle('has-content', !!trimmed);
    queueMicrotask(() => { setByRemote = false; });
  };

  // Beim Tippen: lokal die Anzeige spiegeln + nach 100ms senden
  let deb;
  const emit = () => {
    if (setByRemote) return;
    const txt = editable.textContent || '';
    const trimmed = txt.trim();
    display.textContent = trimmed || PH;
    display.classList.toggle('has-content', !!trimmed);

    clearTimeout(deb);
    deb = setTimeout(() => {
      if (typeof sendRT === 'function') {
        // Owner & Gäste senden beide – Server broadcastet an alle anderen
        sendRT({ t:'focus_update', content: txt, prio: (typeof RT_PRI==='function'? RT_PRI():1), ts: Date.now() });
      }
    }, 100);
  };

  // Alle relevanten Eingabewege abdecken (echtes Live-Typing)
  ['input','beforeinput','keyup','paste','cut','compositionend'].forEach(evt => {
    editable.addEventListener(evt, emit);
    // bei jeder Eingabe zusätzlich Autosave (debounced)
    editable.addEventListener('input', () => {
      try {
        if (typeof debouncedSave === 'function') debouncedSave();
      } catch {}
    });
  });
}

// -------- Presence / Cursor UI (baut auf RT aus Schritt 2 auf) --------
const Presence = (() => {
  let layer;
  const peers = new Map(); // id -> { el, color, label }

  function ensureLayer(){
    if (!layer) {
      layer = document.getElementById('rt-cursor-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'rt-cursor-layer';
        document.body.appendChild(layer);
      }
    }
    return layer;
  }

  function ensureCursorEl(id, color, label){
    ensureLayer();
    let p = peers.get(id);
    if (!p) {
      const el = document.createElement('div');
      el.className = 'rt-cursor';
      el.innerHTML = `<span class="dot"></span><span class="label"></span>`;
      layer.appendChild(el);
      p = { el, color: color || '#888', label: label || ('User '+id) };
      peers.set(id, p);
    }
    const dot = p.el.querySelector('.dot');
    const lab = p.el.querySelector('.label');
    if (color) p.color = color;
    if (label) p.label = label;
    dot.style.background = p.color;
    lab.textContent = p.label;
    return p;
  }

  function move(id, xUnscaled, yUnscaled, color, label){
    const p = ensureCursorEl(id, color, label);
    const boardEl = document.querySelector('.board-area') || document.body;
    const r = (document.querySelector('.board-area') || document.body).getBoundingClientRect();
    const sx = getScaleX(), sy = getScaleY();
    const absX = r.left + xUnscaled * sx;
    const absY = r.top  + yUnscaled * sy;
    p.el.style.left = absX + 'px';
    p.el.style.top  = absY + 'px';
  }

  function remove(id){
    const p = peers.get(id);
    if (!p) return;
    try { p.el.remove(); } catch{}
    peers.delete(id);
  }

  function clearAll(){
    for (const id of peers.keys()) remove(id);
  }

  return { ensureCursorEl, move, remove, clearAll };
})();


// ---- Realtime Core (WS) -----------------------------------------------------
const RT = { ws:null, sid:null, uid:null, name:'', role:'participant' };

// === Reconnect/Heartbeat-Manager ============================================
RT._reconnect = {
  tries: 0,
  timer: null,
  hb: null,
  stop: false,             // auf true setzen, wenn Session absichtlich endet
  cursorAttached: false    // damit der Mousemove-Listener nicht dupliziert wird
};

function startHeartbeat(){
  stopHeartbeat();
  // leichte Herzschläge (Nachrichten-Ebene), falls Server-Ping nicht reicht
  RT._reconnect.hb = setInterval(() => {
    try { sendRT({ t:'ping', ts: Date.now() }); } catch {}
  }, 20000);
}
function stopHeartbeat(){
  if (RT._reconnect.hb) { clearInterval(RT._reconnect.hb); RT._reconnect.hb = null; }
}

function scheduleReconnect(reason = ''){
  if (RT._reconnect.stop) return; // nie reconnecten, wenn absichtlich beendet
  stopHeartbeat();

  const attempt = RT._reconnect.tries++;
  const base = Math.min(10000, 500 * Math.pow(2, attempt)); // 0.5s .. 10s
  const jitter = Math.floor(Math.random() * 250);
  const delay = base + jitter;

  console.warn('[RT] reconnect in', delay, 'ms', reason ? '('+reason+')' : '');
  clearTimeout(RT._reconnect.timer);
  RT._reconnect.timer = setTimeout(() => {
    try { initRealtime(window.CC_CONFIG || null); } catch(e){ console.warn(e); }
  }, delay);
}

// Sichtbarkeits-/Netzwerk-Hooks → schneller reconnecten, wenn sinnvoll
window.addEventListener('online', () => {
  if (!RT.ws || RT.ws.readyState !== 1) scheduleReconnect('online');
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!RT.ws || RT.ws.readyState > 1)) scheduleReconnect('visible');
});



// ---- DEBUG SWITCH -----------------------------------------------------------
const DBG = { on: localStorage.DEBUG_NOTES === '1' };
function L(tag, obj = {}) {
  if (!DBG.on) return;
  try { console.log(`[NOTES] ${tag}`, obj); } catch {}
}
window.DEBUG_NOTES = function(on = true){
  DBG.on = !!on;
  localStorage.DEBUG_NOTES = on ? '1' : '0';
  console.log('[NOTES] Debug ' + (on ? 'ON' : 'OFF'));
};
// ---------------------------------------------------------------------------

function sendRT(payload) {
  try { if (RT.ws && RT.ws.readyState === 1) RT.ws.send(JSON.stringify(payload)); } catch {}
}

async function initRealtime(config) {
  // 1) Session-ID ermitteln
  const qs = new URLSearchParams(location.search);
  RT.sid = Number(qs.get('id') || 0);
  if (!RT.sid) { console.warn('[RT] keine sid in URL'); return; }

  // 2) Nutzer aus localStorage + Rolle ableiten
  let cur = {};
  try { cur = JSON.parse(localStorage.getItem('currentUser') || '{}'); } catch {}

  const nameFromQS = qs.get('n') || qs.get('name') || '';

  RT.uid  = cur.id   || ('u-' + Math.random().toString(36).slice(2));
  RT.role = isOwner() ? 'owner' : 'participant';
  RT.name = cur.name || nameFromQS || (isOwner() ? 'Owner' : 'Gast');

  // 3) WS-URL bauen (CC_CONFIG liefert wsUrl + token)
  const base = (config && config.wsUrl)
    ? config.wsUrl
    : ((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws');

  const u = new URL(base);
  u.searchParams.set('token', (config && config.token) || ''); // Token-Check schalten wir später scharf
  u.searchParams.set('sid',   String(RT.sid));
  u.searchParams.set('uid',   RT.uid);
  u.searchParams.set('name',  RT.name);
  u.searchParams.set('role',  RT.role);

  console.log('[RT] connecting ->', u.toString());
  RT.ws = new WebSocket(u.toString());

  RT.ws.onopen = () => {
    startHeartbeat();
    RT._reconnect.tries = 0; // Backoff zurücksetzen

    if (typeof fitBoardToViewport === 'function') fitBoardToViewport();

    // Mousemove-Listener nur EINMAL binden (wichtig für Reconnect)
    const boardEl = document.querySelector('.board-area');
    if (!RT._reconnect.cursorAttached && boardEl) {
      let last = 0;
      boardEl.addEventListener('mousemove', (e) => {
        const now = performance.now();
        if (now - last < 30) return; // ~33/s
        last = now;

        const r = boardEl.getBoundingClientRect();
        const sx = getScaleX(), sy = getScaleY();
        const { width: worldW, height: worldH } = getWorldSize();

        const xu = (e.clientX - r.left) / sx;
        const yu = (e.clientY - r.top)  / sy;

        const nx = xu / worldW;
        const ny = yu / worldH;

        sendRT({ t:'cursor', nx, ny });
      }, { passive: true });

      RT._reconnect.cursorAttached = true;
    }

    // --- NEU: Gast wartet, bis Owner da ist
    try {
      if (RT.role === 'participant') {
        window.showWaitingForOwner && window.showWaitingForOwner('Warte auf den Ersteller …');
        // einmalig sofort fragen
        sendRT({ t: 'owner_status?' });
        // alle 3s erneut fragen bis Owner da
        clearInterval(window.__ownerPoll);
        window.__ownerPoll = setInterval(() => { sendRT({ t: 'owner_status?' }); }, 3000);
      }
    } catch(e){ console.warn('[wait owner] onopen', e); }

  };

  /* === Eingehende RT-Events rAF-bündeln, ohne Logik zu ändern =============== */

  // Empfängt Kartenbewegungen (RT) und setzt sie ruckelfrei auf dem Board um.
  // Unterstützt normalisierte Koordinaten (nx, ny) oder Pixel (x, y).
  // Empfängt Kartenbewegungen (RT) und setzt sie ruckelfrei auf dem Board um.
  function applyIncomingCardMove(m) {
    // Gleich-priorisierte Frames desselben Senders NICHT droppen
    if (!shouldApply(`move:${m.id}`, m.prio || 1, performance.now(), m.idFrom || null)) return;

    const el = document.getElementById(m.id);
    if (!el) return;

    // Remote-Apply: Hover/Transitions kurz unterdrücken
    el.classList.add('remote-dragging');
    clearTimeout(el._rdTO);
    el._rdTO = setTimeout(() => { el.classList.remove('remote-dragging'); el._rdTO = null; }, 90);

    const boardArea = document.querySelector('.board-area') || document.body;
    const stage = document.getElementById('cards-container') || boardArea;

    // Falls noch im Stapel: in die Bühne hängen
    if (el.closest && el.closest('#card-stack')) {
      try { stage.appendChild(el); } catch {}
      el.style.position = 'absolute';
    }

    // Eingehende Position: erst in Stage-Pixel (unkaliert), dann parent-lokal
    const p = (typeof m.nx === 'number' && typeof m.ny === 'number')
      ? fromNormCard(m.nx, m.ny)
      : { x: m.x, y: m.y };

    const s = parseFloat(boardArea?.dataset.scale || '1') || 1;
    const stageRect  = boardArea.getBoundingClientRect();
    const parentRect = (el.parentElement || stage).getBoundingClientRect();

    const left = Math.round(p.x - ((parentRect.left - stageRect.left) / s));
    const top  = Math.round(p.y - ((parentRect.top  - stageRect.top ) / s));

    if (el.style.left !== left + 'px') el.style.left = left + 'px';
    if (el.style.top  !== top  + 'px') el.style.top  = top  + 'px';
    if (m.z !== undefined && m.z !== '') el.style.zIndex = String(m.z);

    document.dispatchEvent(new CustomEvent('boardStateUpdated', { detail:{ type:'card_move', id:m.id }}));
  }

  function applyIncomingNoteMove(m) {
    // Echo-Drop anhand idFrom (Server hängt das Feld an)
    if (m.idFrom && RT && m.idFrom === RT.uid) return;

    const { el } = ensureNoteEl(m.id);

    // Bühne → parent-lokale px
    const p = fromNorm(m.nx, m.ny);
    const parentRect = el.parentNode.getBoundingClientRect();
    const stageRect  = getStageRect();
    const s = parseFloat(document.querySelector('.board-area')?.dataset.scale || '1') || 1;

    const left = Math.round(p.x - ((parentRect.left - stageRect.left) / s));
    const top  = Math.round(p.y - ((parentRect.top  - stageRect.top ) / s));

    if (el.style.left !== left + 'px') el.style.left = left + 'px';
    if (el.style.top  !== top  + 'px') el.style.top  = top  + 'px';
  }

  function applyIncomingCursor(m) {
    const { width: worldW, height: worldH } = getWorldSize();
    const pxu = (typeof m.nx === 'number') ? m.nx * worldW : m.x;
    const pyu = (typeof m.ny === 'number') ? m.ny * worldH : m.y;
    // deine bestehende Cursor-UI
    Presence.move(m.id, pxu, pyu, m.color, m.label);
  }

  // 1b) Minimaler rAF-Batcher (neu), der NUR die Apply-Funktionen aufruft.
  (function(){
    const qCard   = new Map(); // id -> last payload
    const qNote   = new Map(); // id -> last payload
    const qCursor = new Map(); // id -> last payload
    let raf = 0;

    function schedule(){ if (raf) return; raf = requestAnimationFrame(flush); }

    function flush(){
      raf = 0;
      window.__RT_APPLYING__ = true;
      document.documentElement.classList.add('rt-batch-apply');

      // Karten zuerst (dein Apply)
      qCard.forEach((m) => { try { applyIncomingCardMove(m); } catch(e){ console.warn(e); } });
      qCard.clear();

      // Notizen
      qNote.forEach((m) => { try { applyIncomingNoteMove(m); } catch(e){ console.warn(e); } });
      qNote.clear();

      // Cursor zuletzt
      qCursor.forEach((m) => { try { applyIncomingCursor(m); } catch(e){ console.warn(e); } });
      qCursor.clear();

      document.documentElement.classList.remove('rt-batch-apply');
      window.__RT_APPLYING__ = false;
      // Hinweis: boardStateUpdated wird in deinen Applys (Karte) ohnehin gefeuert.
      // Ein Ereignis für alle gebündelten Änderungen
      document.dispatchEvent(new Event('boardStateUpdated'));
      // Hinweis: boardStateUpdated wird in deinen Applys (Karte) ohnehin gefeuert.
    }

    // global nutzen
    window.RTFrame = {
      enqueueCard(m){ qCard.set(m.id, m); schedule(); },
      enqueueNote(m){ qNote.set(m.id, m); schedule(); },
      enqueueCursor(m){ qCursor.set(m.id, m); schedule(); },
    };
  })();


  RT.ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }

    // Cursor/Präsenz:
    if (m.t === 'hello') {
      // optional: eigene Farbe aus m.color beachten
      return;
    }
    if (m.t === 'presence') {
      // jemand Neues ist da – sofort Label/Farbe setzen
      Presence.ensureCursorEl(m.id, m.color, m.label);
      return;
    }
    // Autoritativer Snapshot vom Server/Owner
    if (m.t === 'state_full') {
      (async () => {
        try {
          const state = m.state || (m.state_b64 ? base64ToJSONUTF8(m.state_b64) : null);
          if (!state) return;
          if (typeof waitForCards === 'function') await waitForCards();

          const skipNotesNow =
            !!document.querySelector('.notiz .notiz-content[contenteditable="true"]') ||
            !!document.querySelector('.notiz.being-dragged') ||
            (window.__isEditingNote === true);

          const lastRemoteTick = window.__lastRemoteCardMoveTs || 0;
          const stillMoving = (performance.now() - lastRemoteTick) < 160;

          const skipCardsNow =
            !!document.querySelector('.card.being-dragged') ||
            Array.from(document.querySelectorAll('.card')).some(el => el._remoteDragActive === true) ||
            stillMoving;

          restoreBoardState(state, { skipNotes: skipNotesNow, skipCards: skipCardsNow });
          document.dispatchEvent(new Event('boardStateUpdated'));
          window.__HAS_BOOTSTRAPPED__ = true;
          window.__SUPPRESS_AUTOSAVE__ = false;                 // NEU: jetzt darf gespeichert werden
          window.__pauseSnapshotUntil  = Date.now() + 500;      // mini Puffer gegen Nachbeben
        } catch (e) { console.warn('[RT] state_full apply failed', e); }
      })();
      return;
    }

    if (m.t === 'cursor') {
      RTFrame.enqueueCursor(m);
      return;
    }

    if (m.t === 'leave') {
      Presence.remove(m.id);
      return;
    }

    // --- NEU: Roster-Snapshot (kommt sofort nach hello) ---
    if (m.t === 'roster') {
      if (RT.role === 'participant') {
        const hasOwner = Array.isArray(m.peers) && m.peers.some(p => p.role === 'owner');
        if (hasOwner) {
          clearInterval(window.__ownerPoll);
          window.hideWaitingForOwner && window.hideWaitingForOwner();
        } else {
          window.showWaitingForOwner && window.showWaitingForOwner('Warte auf den Ersteller …');
        }
      }
      return;
    }

    // --- NEU: Antwort auf owner_status? ---
    if (m.t === 'owner_status') {
      if (RT.role === 'participant') {
        if (m.present) {
          clearInterval(window.__ownerPoll);
          window.hideWaitingForOwner && window.hideWaitingForOwner();
        } else {
          window.showWaitingForOwner && window.showWaitingForOwner('Warte auf den Ersteller …');
        }
      }
      return;
    }

    // --- vorhandene presence/leave um Owner-Tracking ergänzen ---
    if (m.t === 'presence') {
      // Wer reinkommt, ist ggf. der Owner
      if (m.role === 'owner') {
        window.__currentOwnerId = m.id;
        if (RT.role === 'participant') {
          clearInterval(window.__ownerPoll);
          window.hideWaitingForOwner && window.hideWaitingForOwner();
        }
      }
      // bestehende Cursor-UI beibehalten:
      Presence.ensureCursorEl(m.id, m.color, m.label);
      return;
    }

    if (m.t === 'leave') {
      // wenn der Owner geht → Gäste zurück in den Wartemodus
      if (RT.role === 'participant' && window.__currentOwnerId && m.id === window.__currentOwnerId) {
        window.showWaitingForOwner && window.showWaitingForOwner('Warte auf den Ersteller …');
        // Polling wieder aufnehmen
        clearInterval(window.__ownerPoll);
        window.__ownerPoll = setInterval(() => { sendRT({ t:'owner_status?' }); }, 3000);
      }
      Presence.remove(m.id);
      return;
    }

    // --- NEU: Der Owner beendet die Sitzung ---
    if (m.t === 'end_session') {
      if (RT.role !== 'owner') {
        RT._reconnect.stop = true;
        stopHeartbeat();
        try { clearInterval(window.__ownerPoll); } catch {}
        // <<<

        try {
          // Overlay anzeigen und Interaktionen sperren – Tab bleibt offen
          document.documentElement.classList.add('owner-wait-active');
          window.showOwnerEndedByCreator && window.showOwnerEndedByCreator();
        } catch (e) {
          console.warn('[end_session guest]', e);
        }
      }
      return;
    }
    
    if (m.t === 'focus_update') {
      if (typeof window.__ccSetFocusNote === 'function') {
        window.__ccSetFocusNote(String(m.content || ''));
      } else {
        const el = document.getElementById('focus-note-editable');
        const t  = String(m.content || '');
        if (el) el.innerText = t;
        const disp = document.getElementById('focus-note-display');
        if (disp) disp.textContent = t || 'Schreiben sie hier die Focus Note der Sitzung rein';
      }
      // Owner persistiert den neuen Stand (Teilnehmer-Änderung)
      try { if (typeof isOwner === 'function' && isOwner()) saveCurrentBoardState('rt'); } catch {}
      return;
    }

    
    if (m.t === 'card_move') {
      RTFrame.enqueueCard(m);
      return;
    }

    if (m.t === 'card_flip') {
      const gateKey = `flip:${m.id}`;
      if (!shouldApply(gateKey, m.prio || 1)) return;

      const el = document.getElementById(m.id);
      if (!el) return;

      // 1) Sicherstellen, dass keine Drag-Blocker aktiv sind
      el.classList.remove('remote-dragging');
      if (el._rdTO) { clearTimeout(el._rdTO); el._rdTO = null; }

      const want = !!m.flipped;
      const has  = el.classList.contains('flipped');
      if (want !== has) {
        // 2) Flip-Animation sichtbar machen
        el.classList.add('flipping');
        void el.offsetWidth; // Reflow, um die Animation sicher zu starten

        el.classList.toggle('flipped', want);

        // 3) Aufräumen nach Ende
        const cleanup = () => {
          el.classList.remove('flipping');
          el.removeEventListener('transitionend', cleanup);
          el.removeEventListener('animationend', cleanup);
        };
        el.addEventListener('transitionend', cleanup);
        el.addEventListener('animationend', cleanup);
        setTimeout(cleanup, 550); // Fallback

        // Sound beibehalten
        try {
          const snd = window.cardFlipSound || document.getElementById('card-flip-sound');
          if (snd) { snd.currentTime = 0; snd.play().catch(()=>{}); }
        } catch {}
      }
      return;
    }

    // Karte zu Stapel zurückgelegt (via Drop oder Taste "b")
    if (m.t === 'card_sendback') {
      const gateKey = `sendback:${m.id}`;
      if (!shouldApply(gateKey, m.prio || 1)) return;

      const c = document.getElementById(m.id);
      if (c) returnCardToStack(c);
      return;
    }


    // Stapel mischen (inkl. Animation+Sound) – mit deterministischer Reihenfolge
    if (m.t === 'deck_shuffle') {
      // Echo-Unterdrückung (Owner gewinnt), damit der Sender sich nicht doppelt mischt
      if (!shouldApply('deck', m.prio || 1)) return;

      const order = Array.isArray(m.order) ? m.order : null;
      if (typeof window.shuffleCards === 'function') {
        window.shuffleCards(Array.isArray(order) ? order : null);
      } else {
        console.warn('shuffleCards ist (noch) nicht global verfügbar');
      }
      return;
    }


    // ---- Notizen ----
    if (m.t === 'note_create') {
      if (!shouldApply(m.id, m.prio || 1)) return;

      const { el } = ensureNoteEl(m.id); // bindet jetzt intern alle Handler

      // Position setzen
      const p = (typeof m.nx === 'number') ? fromNorm(m.nx, m.ny) : { x: m.x, y: m.y };
      const parent = el.parentElement || document.querySelector('.board-area') || document.body;
      const parentRect = parent.getBoundingClientRect();
      const stageRect  = getStageRect();
      const s = parseFloat(document.querySelector('.board-area')?.dataset.scale || '1') || 1;
      el.style.left = Math.round(p.x - ((parentRect.left - stageRect.left) / s)) + 'px';
      el.style.top  = Math.round(p.y - ((parentRect.top  - stageRect.top ) / s)) + 'px';
      if (m.z !== undefined && m.z !== '') el.style.zIndex = m.z;
      if (m.w) el.style.width  = Math.round(m.w) + 'px';
      if (m.h) el.style.height = Math.round(m.h) + 'px';
      if (m.color) { el.dataset.color = m.color; el.style.backgroundColor = m.color; }
      if (typeof m.content === 'string') setNoteText(el, m.content);

      if (isOwner && isOwner()) { saveCurrentBoardState?.('rt'); }
      return;
    }

    if (m.t === 'note_move') {
      RTFrame.enqueueNote(m);
      return;
    }

    if (m.t === 'note_update') {
      // Eigene Echos ignorieren, solange wir DIESE Notiz lokal editieren
      const isLocalEdit =
        (window.__isEditingNote === true && window.__editingNoteId === m.id);
      L('UPDATE_RECV', { id: m.id, drop: isLocalEdit, len: (m.content||'').length });

      if (isLocalEdit) return;

      // Kollisionen/Prio beachten (wie gehabt)
      if (!shouldApply(m.id, (m.prio || 1))) { L('UPDATE_DROPPED_BY_PRIO', { id: m.id }); return; }

      // Notiz sicherstellen
      const existing = document.getElementById(m.id);
      const { el } = existing ? { el: existing } : ensureNoteEl(m.id);

      // Text nur setzen, wenn er sich wirklich geändert hat
      if (typeof m.content === 'string') {
        const getText = (typeof getNoteText === 'function')
          ? () => getNoteText(el)
          : () => (el.querySelector('.notiz-content')?.textContent || '');
        const setText = (typeof setNoteText === 'function')
          ? (txt) => setNoteText(el, txt)
          : (txt) => { const c = el.querySelector('.notiz-content'); if (c) c.textContent = txt; };

        const current = getText();
        if (current !== m.content) {
          setText(m.content);
          const current = getText();
          if (current !== m.content) {
            setText(m.content);

            // neu: remote sofort neu vermessen (live AutoGrow)
            if (el._autoGrowRecalc) { el._autoGrowRecalc(); }
            else if (typeof attachNoteAutoGrow === 'function') { attachNoteAutoGrow(el); }
          }
          if (typeof attachNoteAutoGrow === 'function') attachNoteAutoGrow(el);
        }
      }

      // Optionale Styles/Eigenschaften wie bisher übernehmen
      if (m.color) { el.dataset.color = m.color; el.style.backgroundColor = m.color; }
      if (m.w) el.style.width  = Math.round(m.w) + 'px';
      if (m.h) el.style.height = Math.round(m.h) + 'px';

      // Beim Owner aktuellen Zustand persistieren (wie gehabt)
      if (isOwner && isOwner()) { saveCurrentBoardState?.('rt'); }
      return;
    }

    if (m.t === 'note_delete') {
      if (!shouldApply(m.id, m.prio || 1)) return;
      const note = document.getElementById(m.id);
      if (note) note.remove();
      if (isOwner && isOwner()) { saveCurrentBoardState?.('rt'); }
      return;
    }

    if (m.t === 'note_lock') {
      L('LOCK_RECV', { id: m.id, by: m.by, lease: m.lease });

      const { el } = ensureNoteEl(m.id);
      el.dataset.locked = '1';
      if (m.by) el.dataset.lockedBy = String(m.by);
      const lease = (typeof m.lease === 'number' && m.lease > 0) ? m.lease : 8000;
      el.dataset.lockedUntil = String(Date.now() + lease);
      el.classList.add('is-editing');

      // Auto-Expire falls unlock nie ankommt
      clearTimeout(el._lockExpireTimer);
      el._lockExpireTimer = setTimeout(() => {
        delete el.dataset.locked;
        delete el.dataset.lockedBy;
        delete el.dataset.lockedUntil;
        el.classList.remove('is-editing');
      }, lease + 1000);
      return;
    }

    if (m.t === 'note_unlock') {
      L('UNLOCK_RECV', { id: m.id });

      const { el } = ensureNoteEl(m.id);
      delete el.dataset.locked;
      delete el.dataset.lockedBy;
      delete el.dataset.lockedUntil;
      el.classList.remove('is-editing');
      clearTimeout(el._lockExpireTimer);
      el._lockExpireTimer = null;
      return;
    }
  };

  RT.ws.onclose = (e) => {
    console.warn('[RT] close', e && e.code, e && e.reason);
    stopHeartbeat();
    Presence.clearAll();
    // Nur reconnecten, wenn nicht absichtlich beendet
    if (!RT._reconnect.stop) scheduleReconnect('close');
  };

  RT.ws.onerror = (e) => {
    console.warn('[RT] error', e);
    // Fehler führen oft kurz darauf zu "close" – wir triggern vorsorglich
    if (!RT._reconnect.stop) scheduleReconnect('error');
  };

}

function hashState(state) {
  try { return JSON.stringify(state); } catch { return String(Date.now()); }
}
function isOwner() {
  return document.documentElement.getAttribute('data-ccs-owner') === '1';
}

async function _doSave(reason = 'auto') {
  if (!isOwner()) return false;
  if (window.__SUPPRESS_AUTOSAVE__ && reason !== 'force') return false; // Boot-Gate
  if (_saveInFlight) return false;

  // WICHTIG: Beim erzwungenen Save (Schließen) OHNE Änderungen NICHT neu messen!
  if (reason === 'force' && window.__DIRTY__ === false) {
    return false; // nichts zu tun, Stand ist bereits in DB
  }

  const sid = new URLSearchParams(location.search).get('id');
  if (!sid) return false;
  if (typeof captureBoardState !== 'function') {
    console.warn('[Autosave] captureBoardState fehlt (noch)');
    return false;
  }

  // DOM messen (nur wenn nötig) und Hash bilden
  const state = captureBoardState();
  const h = hashState(state);

  // Duplikate NIE speichern – auch nicht bei "force"
  if (h === _lastStateHash) {
    window.__DIRTY__ = false;
    return false;
  }

  _saveInFlight = true;
  try {
    const ok = await persistStateToServer(state);
    if (ok) {
      window.__LAST_GOOD_STATE__ = state; // letzten guten Stand puffern
      _lastStateHash = h;
      window.__DIRTY__ = false;
      try { showSaveToast && showSaveToast(); } catch {}
    }
    return !!ok;
  } catch (e) {
    console.warn('[Autosave] persist failed', e);
    return false;
  } finally {
    _saveInFlight = false;
  }
}


// Wird vom Owner-Dialog (OK/Beenden) aufgerufen:
window.onOwnerEndSessionConfirmed = async function () {
  RT._reconnect.stop = true; // Reconnects verhindern

  // 1) letzten Stand hart & sofort speichern
  try { await flushSaveNow(); } catch (e) { console.warn('[end_session save]', e); }

  // 2) allen Gästen "end_session" senden
  try { sendRT({ t: 'end_session' }); } catch {}

  // 3) den Wrapper (server.js) schließen lassen
  try {
    if (window.top && window.top !== window) {
      window.top.postMessage({ type:'END_SESSION', sessionId: RT.sid }, '*');
    } else {
      window.postMessage({ type:'END_SESSION', sessionId: RT.sid }, '*');
      window.close();
    }
  } catch (e) { console.warn('[end_session owner]', e); }
};

// Sammelpunkt für alle Save-Auslöser
function saveCurrentBoardState(reason = 'auto') {
  // Nur echte lokale Interaktionen als „dirty“ markieren
  // (keine RT-Übernahme, kein Zeit-Intervall, kein Load)
  if (reason !== 'rt' && reason !== 'interval' && reason !== 'load') {
    window.__DIRTY__ = true;
  }
  clearTimeout(_saveTimer);
  const defer = Math.max(0, (window.__pauseSnapshotUntil || 0) - Date.now());
  _saveTimer = setTimeout(() => { _doSave(reason); }, 400 + defer);
  return true;
}

// Sofort speichern (z. B. beim Sitzungsende)
async function flushSaveNow() {
  clearTimeout(_saveTimer);
  return _doSave('force');
}


// CC_INIT vom Token-Wrapper entgegennehmen (Name/Board/Deck)
window.addEventListener('message', (ev) => {
  const d = ev.data || {};
  if (d.type !== 'CC_INIT' || !d.config) return;

  window.CC_BOOT = d.config; // global merken

  // H1 oben füllen
  const sess = d.config.session || {};
  const boardFromBoot =
    sess.board ||
    d.config.board ||
    (sess.board_template && (sess.board_template.slug || sess.board_template.id || sess.board_template.name));

  if (boardFromBoot) {
    window.boardType = (typeof canonBoardSlug === 'function')
      ? canonBoardSlug(boardFromBoot)
      : String(boardFromBoot);
  }

  // Falls das Board bereits mit einem anderen Typ gebootet wurde → neu aufbauen
  try {
    if (document.readyState !== 'loading' && typeof window.rebuildBoard === 'function') {
      window.rebuildBoard();
    }
  } catch (e) { console.warn('[CC_INIT] rebuild failed', e); }
  
  try { initRealtime(d.config); } catch(e) { console.warn('[RT] init failed', e); }

});

// Kanonische Slugs -> interne Keys
function canonBoardSlug(s='') {
  const raw = (s || '').toString().trim();
  const low = raw.toLowerCase();
  // Legacy-Mappings weiter unterstützen:
  if (['problem-lösung','problem-loesung','problemlösung','problem','problem_loesung','board_problem_loesung'].includes(low)) return 'board1';
  if (['boardtest','testboard','board_test'].includes(low)) return 'boardTest';
  // Neu: beliebige Slugs zulassen (sanitizen, kein Fallback auf board1)
  return raw
    .replace(/\s+/g, '-')          // Leerzeichen → Bindestrich
    .replace(/[^a-zA-Z0-9_-]/g, '')// unsichere Zeichen raus
    .toLowerCase();
}

function canonDeckSlug(s='') {
  s = (s || '').toString().toLowerCase();
  if (['starterdeck','starter','deck_starter','startkarten'].includes(s)) return 'deck1';
  if (['testdeck','test_deck'].includes(s)) return 'test_deck';
  return s || 'deck1';
}

// --- helpers für Karten-IDs + readiness -------------------------
function normalizeCardId(raw) {
  if (!raw) return null;
  const m = String(raw).match(/card-?(\d+)/i);
  return m ? Number(m[1]) : null;
}

function resolveCardElement(cardLike) {
  const num = normalizeCardId(cardLike?.id || cardLike?.cardId || cardLike);
  if (!num) return null;
  // probiere: #card-36  /  #card36  /  data-card-id="36"
  return (
    document.getElementById(`card-${num}`) ||
    document.getElementById(`card${num}`)  ||
    document.querySelector(`.card[data-card-id="${num}"]`)
  );
}

//richtige Codierung sicherstellen
function jsonToBase64UTF8(obj){
  const json = JSON.stringify(obj);
  if (window.TextEncoder) {
    const bytes = new TextEncoder().encode(json);
    let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin);
  }
  // Fallback
  return btoa(unescape(encodeURIComponent(json)));
}

function base64ToJSONUTF8(b64){
  const bin = atob(b64 || '');
  if (window.TextDecoder) {
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  // Fallback
  return JSON.parse(decodeURIComponent(escape(bin)));
}

async function persistStateToServer(boardState) {
  try {
    const sessionId = new URLSearchParams(location.search).get('id');
    if (!sessionId) return false;
    const res = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: Number(sessionId), state: boardState })
    });
    if (!res.ok) throw new Error(await res.text());
    return true;
  } catch (e) {
    console.warn('PersistStateToServer fehlgeschlagen:', e);
    return false;
  }
}

// Wartet, bis der Kartenstapel im DOM existiert (oder timeout)
function waitForCards(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const ready = () => document.querySelector('#card-stack .card, .board-area .card');
    if (ready()) return resolve();

    const obs = new MutationObserver(() => {
      if (ready()) { obs.disconnect(); resolve(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => { try { obs.disconnect(); } catch {} resolve(); }, timeoutMs);
  });
}



// Lädt den gespeicherten Zustand aus der Sitzung
async function loadSavedBoardState() {
  try {


    const sessionId = new URLSearchParams(location.search).get('id');
    if (!sessionId) return false;

    // Karten abwarten (wichtig!)
    await waitForCards();

    const res = await fetch(`/api/state?id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(await res.text());

    const { state_b64, version } = await res.json();
    // Version fürs Debugging merken & loggen
    try {
      window.__STATE_VERSION = Number.isFinite(version) ? version : (version ? parseInt(version, 10) : 0);
      console.debug('[STATE] loaded version', window.__STATE_VERSION);
    } catch {}
    if (!state_b64) {
      console.log('[DEBUG] Kein Zustand in der DB vorhanden – hebe Autosave-Gate auf.');
      // Gate für neue Sitzungen öffnen, damit Änderungen überhaupt gespeichert werden
      window.__SUPPRESS_AUTOSAVE__ = false;
      // kleine Schonfrist, damit das Board fertig initialisieren kann
      window.__pauseSnapshotUntil  = Date.now() + 1500;

      // Optional: gleich einen initialen Snapshot erzeugen (nur Owner)
      // So ist *sofort* etwas in der DB, auch ohne erste Interaktion.
      setTimeout(() => {
        try {
          if (typeof flushSaveNow === 'function' && typeof isOwner === 'function' && isOwner()) {
            flushSaveNow();
          }
        } catch {}
      }, 800);

      return false;
    }

    const state = base64ToJSONUTF8(state_b64); // UTF-8 sicher
    const ok = restoreBoardState(state);
    if (ok) {
      try { _lastStateHash = hashState(state); } catch {}
      window.__LAST_GOOD_STATE__ = state;   // ← letzten guten Stand puffern
      window.__DIRTY__ = false;             // ← nach Restore keine offenen Änderungen
      window.__SUPPRESS_AUTOSAVE__ = false;            
      window.__pauseSnapshotUntil  = Date.now() + 1500; 
    }
    return ok;
  } catch (e) {
    console.warn('[DEBUG] Laden aus DB fehlgeschlagen:', e);
    return false;
  }
}


// kleine Boot-Konfig (vom Token-Host per postMessage optional gesetzt)
window.CC_BOOT = window.CC_BOOT || {};

// ------------------------------------------------------------------
// WICHTIG: Effektiven Board/Deck-Typ aus URL/Boot/Sitzung ermitteln
// und auf 'board1' fallbacken, wenn etwas Unbekanntes kommt.
// ------------------------------------------------------------------
function resolveBoardAndDeck() {
  const url = new URLSearchParams(location.search);
  const rawBoard =
    url.get('board') ||
    window.CC_BOOT?.board ||
    window.CC_BOOT?.session?.board ||
    window.CC_BOOT?.session?.board_template?.slug ||   // << wichtig
    window.sessionData?.boardId ||
    'board1';

  const rawDeck =
    url.get('deck') ||
    window.CC_BOOT?.deck ||
    window.CC_BOOT?.session?.deck ||
    'deck1';

  return { board: canonBoardSlug(rawBoard), deck: canonDeckSlug(rawDeck) };
}


/* Kompat: wird vom Token/Join-Flow ggf. gesetzt */
// Karten-Seitenverhältnis (Höhe/Breite); Default bleibt kompatibel
let RATIO = 260 / 295;
window.CC_BOOT = window.CC_BOOT || {};

function handleSessionJoin() {
  const qs   = new URLSearchParams(location.search);
  const boot = (window.CC_BOOT && window.CC_BOOT.session) || {};

  // Session-ID aus URL ODER (Token-Host) aus Boot-Kontext
  const sid = qs.get('id') || boot.id;
  if (!sid) {
    if (typeof showError === 'function') {
      showError('Ungültiger Link: Keine Sitzungs-ID gefunden.');
    } else {
      alert('Ungültiger Link: Keine Sitzungs-ID gefunden.');
    }
    return false;
  }

  // Board-Key ermitteln (QS > CC_BOOT.board > boot.board > Default)
  const boardCandidate =
    qs.get('board') ||
    window.CC_BOOT?.board ||
    boot.board ||
    boot.board_template?.slug ||
    'board1';

  const effectiveBoard =
    (typeof canonBoardSlug === 'function') ? canonBoardSlug(boardCandidate) : boardCandidate;

  // minimale Sitzungsdaten bereitstellen (ohne Prompts)
  window.sessionData = {
    id: sid,
    name: boot.name || 'Sitzung',
    boardId: effectiveBoard,
    participants: []
  };

  return true;
}


// In der board-interaction.js müssen Sie diese Funktion aufrufen
function initializeParticipantJoin() {
  if (window.addParticipantNamePromptStyles) {
    window.addParticipantNamePromptStyles();
  }
}

document.addEventListener('DOMContentLoaded', async function() {
  window.__SUPPRESS_AUTOSAVE__ = true;        // Save bis zum ersten Snapshot unterdrücken
  window.__pauseSnapshotUntil  = Date.now() + 1500; // kleine zusätzliche Schonfrist
  window.__DIRTY__ = false;                   // gibt es ungespeicherte Änderungen?
  window.__LAST_GOOD_STATE__ = null;          // letzter bestätigter Snapshot (geladen/gespeichert)

  // --- Boot/Slug vor dem ersten Render sauber auflösen ---
  await waitForBootConfig(800);
  const { board, deck } = resolveBoardAndDeck();
  await applyDeckFormatRatio(deck);
  window.boardType = board;

  // sorgt dafür, dass das Standard-Beige aus CSS greift
  document.body.classList.add('board-container');
  // Elemente auswählen
  const ok =
    (window.handleSessionJoinOwnerAware && window.handleSessionJoinOwnerAware()) ||
    (window.handleSessionJoin && window.handleSessionJoin());
    if (ok === false) return; // falls Link ungültig o.ä.
  const boardTitle = document.getElementById('board-title');
  const boardTypeElement  = document.getElementById('board-type');
  const cardsContainer = document.getElementById('cards-container');
  const notesContainer = document.getElementById('notes-container');
  const participantsContainer = document.getElementById('participants-container');
  const shuffleCardsBtn = document.getElementById('shuffle-cards-btn');
  const newNoteBtn = document.getElementById('new-note-btn');
  const closeSessionBtn = document.getElementById('close-session-btn');
  const cardFilter = document.getElementById('card-filter');
  const errorContainer = document.getElementById('error-container');
  const errorMessage = document.getElementById('error-message');
  const shuffleSound = document.getElementById('shuffle-sound');
  const cardFlipSound = document.getElementById('card-flip-sound');

  window.cardFlipSound = cardFlipSound;
  window.shuffleSound  = shuffleSound;
  
  // CSS für Notiz-Placeholder nur im Editiermodus (verhindert Verlust des ersten Zeichens)
  if (!document.getElementById('note-placeholder-style')) {
    const style = document.createElement('style');
    style.id = 'note-placeholder-style';
    style.textContent = `
      .notiz-content.editing:empty:before {
        content: 'Hier tippen...';
        color: #999;
        font-style: italic;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }
  // Globale No-Select-Hilfe für Drag
  if (!document.getElementById('ccs-no-select-style')) {
    const st = document.createElement('style');
    st.id = 'ccs-no-select-style';
    st.textContent = `
      .ccs-no-select, .ccs-no-select * { user-select: none !important; }
    `;
    document.head.appendChild(st);
  }


  // Session-ID aus der URL extrahieren
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('id');
  const isJoining = urlParams.get('join') === 'true';

  // Sitzungsdaten und Board-Typ
  var sessionData  = window.sessionData  || null;
  var boardType    = window.boardType    || 'board1';
  var cards        = window.cards        || [];
  var notes        = window.notes        || [];
  var participants = window.participants || [];

  // Maximal zulässige Notizgröße dynamisch relativ zum Viewport
  function getMaxNoteSize() {
    return {
      width: Math.min(Math.floor(window.innerWidth * 0.80), 900),
      height: Math.min(Math.floor(window.innerHeight * 0.70), 700)
    };
  }

  // Kleine Debounce-Hilfe fürs Speichern
  function debounce(fn, delay) {
    let t;
    return function() {
      const ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function(){ fn.apply(ctx, args); }, delay);
    };
  }
  const debouncedSave = debounce(() => {
    if (typeof saveCurrentBoardState === 'function') {
      saveCurrentBoardState();
    }
  }, 400);

  // Beobachtet Größenänderungen eines Notizzettels und speichert/clamped diese
  function attachNoteResizeObserver(noteEl) {
    try {
      if (!noteEl || !('ResizeObserver' in window)) return;
      if (noteEl._resizeObserverAttached) return;

      const ro = new ResizeObserver((entries) => {
        // Wenn AutoGrow gerade rechnet, hier NICHT eingreifen (verhindert Flackern)
        if (noteEl._autoGrowInProgress) return;
        const max = getMaxNoteSize();
        let changed = false;
        entries.forEach(entry => {
          const rect = entry.contentRect || entry.target.getBoundingClientRect();
          // Nur clampen, wenn über Max – sonst nichts schreiben (verhindert Jitter)
          if (rect.width > max.width) {
            entry.target.style.width = max.width + 'px';
            changed = true;
          }
          if (rect.height > max.height) {
            entry.target.style.height = max.height + 'px';
            changed = true;
          }
        });
        if (changed) debouncedSave();
      });
      ro.observe(noteEl);
      noteEl._resizeObserverAttached = true;
    } catch (e) {
      console.warn('ResizeObserver nicht verfügbar oder Fehler:', e);
    }
  }

  // Lässt eine Notiz ohne Scrollbalken mit dem Inhalt wachsen.
  // Breite wächst zuerst bis zur Maximalbreite; danach erhöht sich die Höhe.
  function attachNoteAutoGrow(noteEl) {
    try {
      if (!noteEl || noteEl._autoGrowAttached) return;
      const content = noteEl.querySelector('.notiz-content, .note-content');
      if (!content) return;

      function px(n) { return isNaN(n) ? 0 : n; }

      function recalc() {
        const max = getMaxNoteSize();
        const cs = getComputedStyle(noteEl);
        const padX = px(parseFloat(cs.paddingLeft)) + px(parseFloat(cs.paddingRight))
                   + px(parseFloat(cs.borderLeftWidth)) + px(parseFloat(cs.borderRightWidth));
        const padY = px(parseFloat(cs.paddingTop)) + px(parseFloat(cs.paddingBottom))
                   + px(parseFloat(cs.borderTopWidth)) + px(parseFloat(cs.borderBottomWidth));

        // Min-Größen aus CSS berücksichtigen
        const minW = Math.max(0, px(parseFloat(cs.minWidth)) || 0);
        const minH = Math.max(0, px(parseFloat(cs.minHeight)) || 0);

        noteEl._autoGrowInProgress = true;

        // Zuerst horizontale Wunschbreite ermitteln (ohne Umbruch)
        const prevWhiteSpace = content.style.whiteSpace;
        const prevWidthStyle = content.style.width;
        content.style.whiteSpace = 'nowrap';
        content.style.width = 'max-content';

        // temporär auf auto setzen, um natürliche Größe zu ermitteln
        noteEl.style.width = 'auto';
        noteEl.style.height = 'auto';

        // Zielbreite: Inhalt + Rahmen, zwischen min und max
        let targetW = Math.ceil(content.scrollWidth + padX);
        targetW = Math.max(targetW, minW);
        if (targetW > max.width) {
          targetW = max.width;
          content.style.whiteSpace = 'normal'; // danach in die Höhe wachsen
          content.style.wordBreak = 'break-word';
          content.style.overflowWrap = 'anywhere';
        }

        // Setzen, nur wenn wirklich geändert (verhindert ResizeObserver-Jitter)
        const sX = (parseFloat(document.querySelector('.board-area')?.dataset.scaleX || '1') || 1);
        const sY = (parseFloat(document.querySelector('.board-area')?.dataset.scaleY || '1') || 1);
        const currentW = Math.ceil(noteEl.getBoundingClientRect().width  / sX);
        const currentH = Math.ceil(noteEl.getBoundingClientRect().height / sY);

        if (Math.abs(currentW - targetW) > 1) {
          noteEl.style.width = targetW + 'px';
        }

        // Höhe: Inhaltshöhe bei gesetzter Breite
        let targetH = Math.ceil(content.scrollHeight + padY);
        targetH = Math.max(targetH, minH);
        if (targetH > max.height) targetH = max.height;
        if (Math.abs(currentH - targetH) > 1) {
          noteEl.style.height = targetH + 'px';
        }

        // Wenn Max-Höhe erreicht, vertikales Scrollen erlauben, sonst sichtbar lassen
        if (targetH >= max.height - 1) {
          noteEl.style.overflowY = 'auto';
        } else {
          noteEl.style.overflowY = 'visible';
        }

        // Nach der Messung immer umbruchfähig rendern
        content.style.width = '100%';
        content.style.whiteSpace = 'normal';
        content.style.wordBreak = 'break-word';
        content.style.overflowWrap = 'anywhere';
        noteEl._autoGrowInProgress = false;
        // Beim Ziehen KEIN Autosave (vermeidet Snapshot-Jitter)
        if (!noteEl.classList.contains('being-dragged')) {
          debouncedSave();
        }

        debouncedSave();
      }

      // Speichern, um extern aufrufen zu können (z. B. bei window.resize)
      noteEl._autoGrowRecalc = recalc;

      // Initial berechnen
      requestAnimationFrame(recalc);

      // Auf Eingaben reagieren
      ['input', 'keyup', 'change'].forEach(ev => content.addEventListener(ev, recalc));
      const mo = new MutationObserver(recalc);
      mo.observe(content, { childList: true, characterData: true, subtree: true });

      noteEl._autoGrowAttached = true;
    } catch (e) {
      console.warn('AutoGrow-Setup fehlgeschlagen:', e);
    }
  }
  
  // Focus Note Texte nach Board-Typ
  const focusNoteTexts = {
    'board1': "Welche Probleme sind im Alltag?",
    'boardTest': "Welche Probleme sind im Alltag?",
    'board2': "Welchen Stress gibt es bei welchen Situationen?"
  };

  // Kartenrückenfarben nach Board-Typ
  const cardBackColors = {
    'board1': "#ff0000", // Rot
    'boardTest': "#ff0000", // Rot wie board1
    'board2': "#0000ff"  // Blau
  };

  // Session laden und Board initialisieren (JOIN-Flow-sicher, mit Mapping)
  function loadSession() {
    const url = new URLSearchParams(window.location.search);
    const sid = url.get('id');
    if (!sid) { showError('Keine gültige Sitzungs-ID gefunden.'); return; }
    const nameFromUrl = url.get('name') || url.get('n');

    // Board/Deck aus URL oder aus CC_BOOT (vom Token-Wrapper)
    const rawBoard = url.get('board') || window.CC_BOOT?.board || window.CC_BOOT?.session?.board || 'board1';
    const rawDeck  = url.get('deck')  || window.CC_BOOT?.deck  || window.CC_BOOT?.session?.deck  || 'deck1';
    let effBoard = canonBoardSlug(rawBoard);
    let effDeck  = canonDeckSlug(rawDeck);
    if (!effBoard) effBoard = 'board1';
    if (!effDeck) effDeck = 'deck1';

    // Sessiondaten minimal belegen (Name kommt aus CC_BOOT.session)
      window.sessionData = window.sessionData || {
        id: sid,
        name: (window.CC_BOOT?.session?.name) || nameFromUrl || 'Sitzung'
      };

    // Optionaler Zusatz: Name aus LocalStorage als weiterer Fallback
    if (!window.CC_BOOT?.session?.name && !nameFromUrl) {
      try {
        const list = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
        const local = list.find(s => String(s.id) === String(sid));
        if (local?.name) window.sessionData.name = local.name;
      } catch {}
    }

    // Titel setzen – mit neuer Priorität
    const titleEl = document.getElementById('board-title');
    if (titleEl) {
      titleEl.textContent =
        nameFromUrl ||
        (window.CC_BOOT?.session?.name) ||
        (window.sessionData && window.sessionData.name) ||
        'Sitzung';
      document.title = titleEl.textContent;
    }
  }
  

  // Board mit Karten und Notizen initialisieren
  const initializeBoard = () => {
    console.debug('[BOOT]', {
      fromUrl: new URLSearchParams(location.search).get('board'),
      fromBootBoard: window.CC_BOOT?.board,
      fromBootSessionBoard: window.CC_BOOT?.session?.board,
      fromBootTpl: !!window.CC_BOOT?.session?.board_template,
      resolvedBoardType: window.boardType
    });

    //Werte aus dem Board-Template (vom Server) nehmen
    const tpl = (window.CC_BOOT?.session?.board_template) || null;
    const sample = tpl?.widgets?.find?.(w => w.type === 'sampleCard');

    const area = document.querySelector('.board-area');
    if (area && tpl) {
      const bg = tpl.bgColor || tpl.backgroundColor || null;
      const bgImg = tpl.bgImage || tpl.backgroundImage || null;

      if (bg) area.style.backgroundColor = bg;
      if (bgImg) area.style.backgroundImage = `url('${bgImg}')`;
    }

    // Basiseinstellungen für das Board (Hintergrund etc.) basierend auf dem Board-Typ
    const bootTplRaw =
      window.CC_BOOT?.session?.board_template ||
      window.CC_BOOT?.board_template ||
      null;

    const bootTpl = normalizeTemplate(bootTplRaw);

    // erst Karten erzeugen (Container existiert), dann Template anwenden
    createCards();


    // 2) Template aus Boot oder via fetch laden und rendern
    const loadTpl = bootTpl ? Promise.resolve(bootTpl) : fetchBoardTemplate(window.boardType);

    loadTpl
      .then((tpl) => {
        const slug = window.boardType;

        // Wenn kein Template oder leeres Template zurückkommt,
        // zeigen wir das Fehler-Overlay statt eines Fallback-Boards.
        // (fetchBoardTemplate() liefert bei "nicht gefunden" ein Minimal-Objekt mit leeren widgets.) 
        // -> Das werten wir hier als Ladefehler. :contentReference[oaicite:1]{index=1}
        if (!tpl || !Array.isArray(tpl.widgets) || tpl.widgets.length === 0) {
          console.warn('[TPL] not found/empty for', slug);
          if (typeof window.showLoadFailureOverlay === 'function') {
            window.showLoadFailureOverlay('board', slug);
          }
          return; // nichts rendern
        }

        console.debug('[TPL bgrects]', (tpl.widgets || []).filter(w => w.type === 'bgrect'));
        console.debug('[TPL sample]',  (tpl.widgets || []).find(w => w.type === 'sampleCard'));

        // normales Rendering
        applySampleCardFromTemplate(tpl);   // Stapel positionieren & Cardmaß
        // Nur die zum aktuellen Kartenformat gehörende BG-Box behalten
        try {
          const sample = (tpl.widgets || []).find(w => w && w.type === 'sampleCard');
          const map    = (sample?.props?.bgMap) || {};
          const fmt    = String(window.CARDSET_FORMAT || '');
          const activeBgId = map[fmt] || sample?.props?.bgId || null;

          if (activeBgId) {
            // für spätere Positionierung merken
            window.__CARD_BG_ID__ = activeBgId;
            // alle anderen bgrects ausfiltern
            tpl.widgets = (tpl.widgets || []).filter(w => w.type !== 'bgrect' || w.id === activeBgId);
          }
        } catch (e) {
          console.debug('[tpl] bg-filter skipped', e);
        }
        buildBoardFromTemplate(tpl);        // Widgets/Hintergrund zeichnen
      })
      .catch((err) => {
        console.error('[TPL] fetch/load failed', err);
        if (typeof window.showLoadFailureOverlay === 'function') {
          window.showLoadFailureOverlay('board', window.boardType);
        }
      })
      .finally(() => {
        // vorhandene Initialisierung beibehalten (wie in deiner Datei)
        try { initializeParticipants && initializeParticipants(); } catch(e){}
        try { addTrashContainer && addTrashContainer(); } catch(e){}
        try { initFocusNoteLive && initFocusNoteLive(); } catch(e){}
        try {
          if (typeof waitForCards === 'function' && typeof loadSavedBoardState === 'function') {
            waitForCards().then(() => { try { loadSavedBoardState(); } catch(e) { console.warn(e); } });
          }
        } catch(e){}
      });


    // Add drop handling to allow repositioning cards and notes
    const boardArea = document.querySelector('.board-area');


    // Enable dropping on the board
    boardArea.addEventListener('dragover', function(e) {
      // This preventDefault is CRITICAL - it's what allows dropping
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    // Handle the actual drop
    boardArea.addEventListener('drop', function(e) {
      e.preventDefault();

      const id = e.dataTransfer.getData('text/plain');
      const el = document.getElementById(id);
      if (!el) return;

      const boardRect = boardArea.getBoundingClientRect();

      // Drop-Punkt in UNSKALIERTEN px
      const sX = getScaleX(), sY = getScaleY();
      const dropXu = (e.clientX - boardRect.left) / sX;
      const dropYu = (e.clientY - boardRect.top)  / sY;

      // mittig ablegen
      const halfW = Math.round((el.offsetWidth  || 0) / 2);
      const halfH = Math.round((el.offsetHeight || 0) / 2);
      const newLeft = Math.round(dropXu - halfW);
      const newTop  = Math.round(dropYu - halfH);

      el.style.position = 'absolute';
      el.style.left = newLeft + 'px';
      el.style.top  = newTop  + 'px';

      // Karte ggf. aus dem Stapel lösen
      const cardStack = document.getElementById('card-stack');
      if (cardStack && cardStack.contains(el)) {
        try { cardStack.removeChild(el); } catch {}
        boardArea.appendChild(el);
      }

      // → Normierte Koordinaten berechnen & broadcasten
      if (el.classList.contains('card')) {
        const { nx, ny } = toNormCard(newLeft, newTop);
        shouldApply(`move:${el.id}`, RT_PRI(), performance.now(), RT.uid);
        sendRT({ t:'card_move', id: el.id, nx, ny, z: el.style.zIndex || '', prio: RT_PRI(), ts: Date.now() });
      } else if (el.classList.contains('notiz') || el.classList.contains('note')) {
        // Notiz: relative zur Bühne normalisieren
        const { nx, ny } = toNorm(newLeft, newTop);
        sendRT({ t:'note_move', id:el.id, nx, ny, prio: RT_PRI(), ts: Date.now() });
      }

      // Lokal sichern (Owner persistiert, Gäste nur lokal)
      saveCurrentBoardState?.();
    });

    // Setup Focus Note Editable Field
    setupFocusNoteEditable();

    // Event-Listener für Aktionen einrichten
    setupEventListeners();

    // beim Start & bei Resize anwenden
    window.addEventListener('resize', (() => {
      let t; 
      return () => { clearTimeout(t); t = setTimeout(fitBoardToViewport, 120); };
    })());

    fitBoardToViewport();
    ensureEndSessionButton();
  };

  //Erzeugt generisch wichtigste Widgets aus WP-Template
  function buildBoardFromTemplate(tpl) {
    const prop = (w) => (w && w.props) || {};
    const area =
      document.querySelector('.board-area') ||
      document.getElementById('session-board') ||
      document.body;

    // Aufräumen: alte Template-Knoten (bei Rebuild)
    area.querySelectorAll('.tpl-node').forEach(el => el.remove());

    if (!tpl || !Array.isArray(tpl.widgets)) {
      console.warn('[TPL] kein gültiges Template – fallback');
      // Fallback auf die alten (nur wenn du willst)
      // createCardPlaceholders();
      // createFocusNote();
      return;
    }

    // Optional: Welt/Canvas-Größe und Hintergrund
    if (tpl.worldW && tpl.worldH) {
      area.style.position = area.style.position || 'relative';
      area.style.width  = Math.round(tpl.worldW) + 'px';
      area.style.height = Math.round(tpl.worldH) + 'px';
    }
    area.style.backgroundColor = tpl.bgColor || '#f9ecd2';
    if (tpl.bgImage) {
      area.style.backgroundImage = `url(${tpl.bgImage})`;
      area.style.backgroundSize  = 'cover';
      area.style.backgroundPosition = 'center';
    }

    const px = (n) => (Math.round(n || 0) + 'px');

    function place(el, w) {
      el.classList.add('tpl-node');
      el.style.position = 'absolute';
      if (w.x != null) el.style.left   = px(w.x);
      if (w.y != null) el.style.top    = px(w.y);
      if (w.w != null) el.style.width  = px(w.w);
      if (w.h != null) el.style.height = px(w.h);
      if (w.z != null) el.style.zIndex = String(Math.max(0, (w.z|0)));
      else el.style.zIndex = '0';
      area.appendChild(el);
    }

    const W = Array.isArray(tpl.widgets) ? tpl.widgets : [];

    const sample    = W.find(w => w.type === 'sampleCard');
    const fmtFromDeck = String(window.CARDSET_FORMAT || prop(sample).format || '');
    const bgMap     = (prop(sample).bgMap || sample?.bgMap || {});
    const activeBgId = window.__CARD_BG_ID__ || (fmtFromDeck && bgMap[fmtFromDeck]) || prop(sample).bgId || null;

    const bgList = W.filter(w => w.type === 'bgrect' && (!activeBgId || String(w.id || '') === String(activeBgId)));

    bgList.forEach(w => {
      const el = document.createElement('div');
      el.className  = 'board-bg-rect tpl-node';
      el.dataset.id = w.id || '';

      // Position & Größe laut Template
      place(el, w);

      // hinten halten & nicht klickfangend
      el.style.pointerEvents = 'none';
      // falls kein z im Widget gesetzt, einen sehr niedrigen setzen
      if (!w.z) el.style.zIndex = '0';

      // Optik aus props/legacy übernehmen
      const radius = (prop(w).radius ?? 12);
      el.style.borderRadius = `${Math.round(radius)}px`;

      const fillCol = (prop(w).color ?? '#f3ead7');
      const fillA   = (prop(w).opacity ?? 1);
      el.style.backgroundColor = hexToRgba(fillCol, fillA);

      const bw   = (prop(w).borderWidth ?? 0);
      const bsty = (prop(w).borderStyle ?? 'solid');
      if (bw > 0 && bsty !== 'none') {
        const bcol = (prop(w).borderColor ?? '#000000');
        const ba   = (prop(w).borderOpacity ?? 1);
        el.style.border = `${bw}px ${bsty} ${hexToRgba(bcol, ba)}`;
      } else {
        el.style.border = 'none';
      }
      if (bw === 0) el.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.06) inset';

      // Merker für Fix B: die Box, in die der Stapel soll
      if (activeBgId && String(w.id || '') === String(activeBgId)) {
        window.CARD_BG_EL = el;
      }
    });

    // --- bgrect zuerst (Z-Reihenfolge)
    tpl.widgets.filter(w => w.type === 'bgrect').forEach(w => {
      const el = document.createElement('div');
      el.className   = 'board-bg-rect tpl-node';
      el.dataset.id  = w.id || '';

      // zuerst positionieren (left/top/w/h/z) – deine place(..) nutzt w.x,y,w,h,w.z
      place(el, w);

      // nicht klickfangend & weit hinten
      el.style.pointerEvents = 'none';
      if (!w.z) el.style.zIndex = '10';

      // Optik aus props ODER legacy top-level
      const radius = gprop(w,'radius',12);
      el.style.borderRadius = `${Math.round(radius)}px`;

      const fillCol = gprop(w,'color','#f3ead7');
      const fillA   = gprop(w,'opacity',1);
      el.style.backgroundColor = hexToRgba(fillCol, fillA);

      const bw   = gprop(w,'borderWidth',0);
      const bsty = gprop(w,'borderStyle','solid');
      if (bw > 0 && bsty !== 'none') {
        const bcol = gprop(w,'borderColor','#000000');
        const ba   = gprop(w,'borderOpacity',1);
        el.style.border = `${bw}px ${bsty} ${hexToRgba(bcol, ba)}`;
      } else {
        el.style.border = 'none';
      }

      // dezenter innerer Rahmen (falls kein expliziter Rand gesetzt ist)
      if (bw === 0) el.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.06) inset';
    });


    // --- cardholder: Zonen inklusive Titel/Desc mit optionaler Bearbeitung ---
    tpl.widgets.filter(w => w.type === 'cardholder').forEach(w => {
      const p = prop(w); // merged props (inkl. title/body + ...UserEditable)
      const el = document.createElement('div');
      el.className = 'board-cardholder tpl-node';
      el.style.position = 'absolute';

      // Geometrie aus Template
      el.style.left   = (w.x || 0) + 'px';
      el.style.top    = (w.y || 0) + 'px';
      if (w.w) el.style.width  = w.w + 'px';
      if (w.h) el.style.height = w.h + 'px';

      // sanfte Standardoptik, aber KEIN Weiß! (Hintergrund nur, wenn explizit gesetzt)
      const bsty = p.borderStyle || 'dashed';
      const bw   = (p.borderWidth ?? 2);
      const bcol = p.borderColor || '#b8b8b8';
      const ba   = (typeof p.borderOpacity === 'number') ? p.borderOpacity : 1;
      el.style.border       = (bw > 0 && bsty !== 'none')
        ? `${bw}px ${bsty} ${ba >= 1 ? bcol : hexToRgba(bcol, ba)}`
        : 'none';
      el.style.borderRadius = (p.radius != null ? p.radius : 14) + 'px';

      const fillCol = p.background || p.color || null;
      const fillA   = (typeof p.opacity === 'number') ? p.opacity : 0;
      el.style.background = fillCol
        ? (fillA >= 1 ? fillCol : hexToRgba(fillCol, fillA))
        : 'transparent';

      el.style.backdropFilter = 'blur(2px)';
      el.style.display = 'flex';
      el.style.flexDirection = 'column';
      el.style.overflow = 'hidden';
      el.style.pointerEvents = 'auto';

      // OBERER TEXT-BEREICH
      const top = document.createElement('div');
      top.className = 'ch-top';
      top.style.flex = '0 0 auto';
      top.style.padding = '8px 10px 6px 10px';

      // Titel
      const title = document.createElement('div');
      title.className = 'ch-title';
      title.textContent = (p.title ?? p.heading ?? p.name ?? '').trim();
      title.style.fontWeight = '600';
      title.style.lineHeight = '1.25';
      title.style.whiteSpace = 'pre-wrap';
      title.style.wordBreak = 'break-word';
      title.style.textAlign = p.titleAlign || p.textAlign || 'center';

      // Text/Body
      const desc = document.createElement('div');
      desc.className = 'ch-desc';
      desc.textContent = (p.body ?? p.text ?? '').trim();
      desc.style.marginTop = '4px';
      desc.style.lineHeight = '1.3';
      desc.style.whiteSpace = 'pre-wrap';         // Absatz mit Enter geht nach unten, nicht „rechts“
      desc.style.wordBreak  = 'break-word';
      desc.style.overflowWrap = 'anywhere';
      desc.style.textAlign = p.bodyAlign || p.textAlign || 'center';

      // Separator
      const sep = document.createElement('div');
      sep.className = 'ch-sep';
      sep.style.height = '1px';
      sep.style.background = 'rgba(0,0,0,0.15)';

      // UNTERER ABLEGE-BEREICH (Dropzone)
      const space = document.createElement('div');
      space.className = 'ch-space';
      space.style.flex = '1 1 auto';
      space.style.position = 'relative';
      space.style.minHeight = '40px';
      space.style.display = 'flex';
      space.style.alignItems = 'center';
      space.style.justifyContent = 'center';
      space.dataset.dropzone = 'cards'; // Hook für deine DnD-Logik

      // Editierbarkeit laut Builder-Flags
      const makeEditable = (node, allowed, defaultText) => {
        if (!allowed) return;
        node.setAttribute('contenteditable', 'true');
        node.dataset.default = (defaultText || '').trim();
        let clearedOnce = false;
        node.addEventListener('focus', () => {
          // Einmaliges Auto-Löschen: nur wenn noch der Admin-Text drin steht
          if (!clearedOnce && node.textContent.trim() === node.dataset.default) {
            node.textContent = '';
            clearedOnce = true;
          }
        });
        // Autosave/Sync (falls vorhanden)
        ['input','keyup','paste','cut','blur'].forEach(ev => {
          node.addEventListener(ev, () => {
            try { if (typeof debouncedSave === 'function') debouncedSave(); } catch {}
          });
        });
      };

      makeEditable(title, !!p.titleUserEditable, title.textContent);
      makeEditable(desc,  !!p.bodyUserEditable,  desc.textContent);

      // Zusammenbauen
      top.appendChild(title);
      top.appendChild(desc);
      el.appendChild(top);
      el.appendChild(sep);
      el.appendChild(space);

      // In den DOM & Größe begrenzen: Der Body darf NICHT höher werden als der obere Bereich
      place(el, w); // deine bestehende Platzierungsfunktion
      requestAnimationFrame(() => {
        // Maximalhöhe des oberen Bereichs begrenzen (z. B. 40% der Boxhöhe, capped)
        const maxTop = Math.min(Math.round((w.h || el.clientHeight) * 0.4), 220);
        top.style.maxHeight = maxTop + 'px';
        // Desc-Scroll statt Überlaufen
        const used = title.offsetHeight + 10; // plus Innenabstände
        const maxDesc = Math.max(0, maxTop - used);
        desc.style.maxHeight = maxDesc + 'px';
        desc.style.overflowY = 'auto';
      });
    });

    // --- focusNote: große Fokus-Notiz an Template-Position
    const focus = tpl.widgets.find(w => w.type === 'focusNote');
    if (focus) {
      const p = prop(focus); // merged props
      // Container erstellen
      const el = document.createElement('div');
      el.className = 'focus-note tpl-node';
      el.style.position = 'absolute';
      el.style.boxShadow = 'none';                     // kein Notizzettel-Schatten
      el.style.display = 'flex';
      el.style.flexDirection = 'column';
      el.style.overflow = 'hidden';
      // Geometrie aus Template
      el.style.left   = px(focus.x || 0);
      el.style.top    = px(focus.y || 0);
      if (focus.w) el.style.width  = px(focus.w);
      if (focus.h) el.style.height = px(focus.h);

      // Optik aus Props
      const bg  = p.background || p.color || '#e6f6ea';
      const rad = (p.radius != null ? p.radius : 14);
      const bw  = (p.borderWidth  != null ? p.borderWidth  : 2);
      const bs  = (p.borderStyle  || 'solid');
      const bc  = (p.borderColor  || '#c5e7d2');
      const ba  = (p.borderOpacity != null ? p.borderOpacity : 1);
      el.style.background   = bg;
      el.style.borderRadius = rad + 'px';
      el.style.border       = bw > 0 && bs !== 'none' ? `${bw}px ${bs} rgba( ${hexToRgba
        ? hexToRgba(bc, ba).match(/\d+,\d+,\d+,\d+(\.\d+)?/)[0]
        : '197,231,210,' + ba } )` : 'none';

     // Titel + Inhalt (Defaults merken für "einmalig löschen")
      const titleText = p.title ?? p.heading ?? 'Focus Note';
      const bodyText  = p.body  ?? p.text    ?? '';
      const defaultTitle = (titleText ?? '').trim();
      const defaultBody  = (bodyText  ?? '').trim();

      const title = document.createElement('div');
      title.className = 'focus-note-title';
      title.textContent = titleText;
      if (p.titleUserEditable) title.setAttribute('contenteditable', 'true');

      const content = document.createElement('div');
      content.className = 'focus-note-content';
      content.textContent = bodyText;
      if (p.bodyUserEditable) content.setAttribute('contenteditable', 'true');

      // === Ausrichtung & Schrift aus dem Builder übernehmen ===
      // Der Builder schreibt die Ausrichtung in props.textAlign (links/center/rechts) :contentReference[oaicite:1]{index=1}
      const align = (['left','center','right'].includes(p.textAlign) ? p.textAlign : 'center');
      title.style.textAlign   = align;
      content.style.textAlign = align;

      // optionale Text-Props aus dem Builder (global für beide Felder)
      if (p.fontSize)   { title.style.fontSize   = p.fontSize + 'px'; content.style.fontSize   = p.fontSize + 'px'; }
      if (p.fontColor)  { title.style.color      = p.fontColor;       content.style.color      = p.fontColor; }
      if (p.fontFamily) { title.style.fontFamily = p.fontFamily;      content.style.fontFamily = p.fontFamily; }
      if (p.bold)       { content.style.fontWeight = '700'; } // Title hat unten schon 700
      if (p.italic)     { content.style.fontStyle  = 'italic'; }
      if (p.underline)  { content.style.textDecoration = 'underline'; }

      // Layout für sauberes Scrollen statt Wachsen (leicht angepasst)
      title.style.padding = '8px 12px';
      title.style.fontWeight = '700'; // behalten
      title.style.borderBottom = '1px solid rgba(0,0,0,0.06)';
      title.style.userSelect = 'text';

      content.style.flex = '1';
      content.style.padding = '12px';
      content.style.overflow = 'auto';
      content.style.whiteSpace = 'pre-wrap';
      content.style.wordBreak = 'break-word';
      content.style.userSelect = 'text';

      // === "Einmalig löschen", wenn Admin-Text noch drin ist ===
      function setupOneTimeClear(node, defaultVal) {
        let clearedOnce = false;
        node.addEventListener('focus', () => {
          const cur = (node.textContent || '').trim();
          if (!clearedOnce && cur === (defaultVal || '')) {
            node.textContent = '';
            clearedOnce = true;
          }
        });
        node.addEventListener('input', () => {
          // Sobald der Nutzer etwas Eigenes drin hat, nie wieder auto-löschen
          const cur = (node.textContent || '').trim();
          if (cur && cur !== (defaultVal || '')) clearedOnce = true;
        });
      }
      if (p.titleUserEditable)  setupOneTimeClear(title,   defaultTitle);
      if (p.bodyUserEditable)   setupOneTimeClear(content, defaultBody);

      el.appendChild(title);
      el.appendChild(content);

      // Platzieren …
      place(el, focus);
    }


    // --- description: Infobox/Fließtext aus Template (mit optionaler Bearbeitung)
    tpl.widgets.filter(w => w.type === 'description').forEach(w => {
      const p  = prop(w); // merged props inkl. heading/text & ...UserEditable
      const el = document.createElement('div');
      el.className = 'board-description-box tpl-node';
      el.style.position = 'absolute';

      // Geometrie aus Template
      if (w.x != null) el.style.left = w.x + 'px';
      if (w.y != null) el.style.top  = w.y + 'px';
      if (w.w) el.style.width  = w.w + 'px';
      if (w.h) el.style.height = w.h + 'px';

      // Hintergrund / Rahmen wie im Builder (kein globales opacity!)
      const fillCol = p.background || p.color || null;
      const fillA   = (typeof p.opacity === 'number') ? p.opacity : 1;
      el.style.background = fillCol
        ? (fillA >= 1 ? fillCol : hexToRgba(fillCol, fillA))
        : 'transparent';
      if (p.radius != null) el.style.borderRadius = p.radius + 'px';
      if (p.borderWidth) {
        el.style.borderStyle = p.borderStyle || 'solid';
        const ba = (typeof p.borderOpacity === 'number') ? p.borderOpacity : 1;
        const bc = p.borderColor || 'rgba(0,0,0,0.15)';
        el.style.borderWidth = p.borderWidth + 'px';
        el.style.borderColor = (ba >= 1 ? bc : hexToRgba(bc, ba));
      }

      // Container: füllt die Box und lässt den Body den restlichen Platz bekommen
      el.style.display = 'flex';
      el.style.flexDirection = 'column';
      el.style.overflow = 'hidden';
      el.style.pointerEvents = 'auto';
      el.style.padding = (p.padding != null ? p.padding : 12) + 'px';

      //  Struktur Titel + Body-Wrapper (Body wird vertikal zentriert)
      const align = ['left','center','right'].includes(p.textAlign) ? p.textAlign : 'center';

      // Titel
      const title = document.createElement('div');
      title.className = 'desc-title';
      title.textContent = (p.title ?? p.heading ?? '').trim() || 'Überschrift';
      title.style.fontWeight = '700';
      title.style.lineHeight = '1.25';
      title.style.whiteSpace = 'pre-wrap';
      title.style.wordBreak  = 'break-word';
      title.style.textAlign  = p.titleAlign || p.textAlign || 'center';

      title.style.background = 'transparent';
      title.style.outline = 'none';
      title.style.border = 'none';
      title.style.boxShadow = 'none';

      // Schrift-Props aus dem Builder (global)
      if (p.fontSize)   title.style.fontSize   = p.fontSize + 'px';
      if (p.fontFamily) title.style.fontFamily = p.fontFamily;
      if (p.fontColor)  title.style.color      = p.fontColor;

      // Body (transparentes, feldfüllendes Textfeld)
      const content = document.createElement('div');
      content.className = 'desc-content';
      content.textContent = (p.body ?? p.text ?? '').trim() || 'Beschreibung';
      content.style.flex = '1 1 auto';
      content.style.minHeight = '0';          // wichtig für flex + overflow
      content.style.whiteSpace = 'pre-wrap';
      content.style.wordBreak  = 'break-word';
      content.style.overflow   = 'auto';
      content.style.textAlign  = p.bodyAlign || p.textAlign || 'center';
      content.style.background = 'transparent';
      content.style.outline    = 'none';
      content.style.border     = 'none';

      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.justifyContent = 'center';
      content.style.alignItems = 'stretch';
      
      // Schrift-Props spiegeln
      if (p.fontSize)   content.style.fontSize   = p.fontSize + 'px';
      if (p.fontFamily) content.style.fontFamily = p.fontFamily;
      if (p.fontColor)  content.style.color      = p.fontColor;

      // === Optionale Bearbeitbarkeit wie bei Cardholder ===
      function setupOneTimeClear(node, defaultVal) {
        let clearedOnce = false;
        node.addEventListener('focus', () => {
          const cur = (node.textContent || '').trim();
          if (!clearedOnce && cur === (defaultVal || '')) {
            node.textContent = '';
            clearedOnce = true;
          }
        });
        node.addEventListener('input', () => {
          const cur = (node.textContent || '').trim();
          if (cur && cur !== (defaultVal || '')) clearedOnce = true;
        });
      }
      const defaultTitle = title.textContent;
      const defaultBody  = content.textContent;

      if (p.titleUserEditable) {
        title.setAttribute('contenteditable', 'true');
        setupOneTimeClear(title, defaultTitle);
        ['input','keyup','paste','cut','blur'].forEach(ev =>
          title.addEventListener(ev, () => { try { debouncedSave(); } catch {} })
        );
      }
      if (p.bodyUserEditable) {
        content.setAttribute('contenteditable', 'true');
        content.style.cursor = 'text';
        setupOneTimeClear(content, defaultBody);
        ['input','keyup','paste','cut','blur'].forEach(ev =>
          content.addEventListener(ev, () => { try { debouncedSave(); } catch {} })
        );
      }

      el.appendChild(title);
      el.appendChild(content);

      // Platzieren gemäß w.x/w.y/w.w/w.h
      place(el, w);
    });


    // --- notepad: Bereich für Notizen (aus dem Builder), inkl. Farbe/Rahmen
    tpl.widgets
      .filter(w => w.type === 'notepad' || w.type === 'bb-notepad')
      .forEach(w => {
        const p = (typeof prop === 'function') ? prop(w) : (w.props || w); // robust
        // vorhandenen Container nehmen oder neu erstellen
        let el = document.getElementById('notes-container') || document.querySelector('.notes-container');
        const isNew = !el;
        if (!el) {
          el = document.createElement('div');
          el.id = 'notes-container';
          el.className = 'notizzettel-box notes-container tpl-node';
        }

        // Optik aus Template-Props
        el.style.borderRadius = (p.radius != null ? p.radius : 12) + 'px';
        el.style.background   = p.background || p.color || 'rgba(255,248,220,0.5)'; // sanftes Gelb als Default
        if (p.borderStyle || p.borderWidth || p.borderColor) {
          el.style.borderStyle = p.borderStyle || 'solid';
          el.style.borderWidth = (p.borderWidth || 0) + 'px';
          el.style.borderColor = p.borderColor || 'rgba(0,0,0,0.08)';
        } else {
          el.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.06) inset';
        }

        // Position/Größe laut Template
        place(el, w); // nutzt die vorhandene place(..)-Hilfsfunktion

        // Erst jetzt anhängen (falls neu)
        if (isNew) area.appendChild(el);

        el.dataset.role = 'notepad';
        el.setAttribute('draggable', 'false');
        el.addEventListener('dragstart', e => e.preventDefault());

        // Nur wenn auf den Hintergrund des Blocks geklickt wird (nicht auf eine vorhandene Notiz)
        el.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          if (e.target.closest('.notiz, .note')) return; // nicht auslösen, wenn man eine existierende Notiz anklickt
          startDragNewNote(e); // erzeugt & zieht einen neuen Notizzettel aus genau diesem Container
        });

        // Touch-Support: erzeugt ein „Mausäquivalent“ mit button=0
        el.addEventListener('touchstart', (e) => {
          try { e.preventDefault(); } catch {}
          const t = e.touches && e.touches[0];
          if (!t) return;
          startDragNewNote({
            clientX: t.clientX,
            clientY: t.clientY,
            button: 0,
            preventDefault: () => {}
          });
        }, { passive:false });

        el.style.cursor = 'grab'; // visuelles Feedback
        el.__noteInit = true;
      });

      // Sicherheit: existierende Notizen in den Container umhängen
      document.querySelectorAll('.notiz').forEach(n => { if (!el.contains(n)) el.appendChild(n); });
      
    try {
      const activeId = window.__CARD_BG_ID__;
      const box = activeId
        ? area.querySelector(`.board-bg-rect[data-id="${CSS.escape(String(activeId))}"]`)
        : null;
      const stack = document.getElementById('card-stack');

      if (box && stack) {
        // Box muss Positionierungs-Kontext sein
        const prevPos = getComputedStyle(box).position;
        if (prevPos === 'static') box.style.position = 'relative';

        // Stapel in die Box verschieben und zentrieren
        box.appendChild(stack);
        stack.style.position  = 'absolute';
        stack.style.left      = '50%';
        stack.style.top       = '50%';
        stack.style.transform = 'translate(-50%, -50%)';
      }
    } catch (e) {
      console.debug('mount stack into bgrect failed', e);
    }
  }

  

  // Board anhand der aktuellen window.boardType/window.deck neu aufbauen
  window.rebuildBoard = function() {
    const area = document.querySelector('.board-area');
    if (area) area.innerHTML = '';
    initializeBoard();
    if (typeof waitForCards === 'function' && typeof loadSavedBoardState === 'function') {
      waitForCards().then(() => { try { loadSavedBoardState(); } catch(e) { console.warn(e); } });
    }
    if (typeof fitBoardToViewport === 'function') { fitBoardToViewport(); }
  };


  // Ablageplätze für Karten erstellen
  const createCardPlaceholders = () => {
    if (boardType === 'board1' || boardType === 'boardTest') {
      // 1. Header-Bereich erstellen
      const headerArea = document.createElement('div');
      headerArea.className = 'board-header-area';
    
      // 1.1 Info-Box
      const infoBox = document.createElement('div');
      infoBox.className = 'board-info-box';
      infoBox.textContent = 'Fester Platz für Problem-Lösung';
    
      // 1.2 Beschreibungs-Box
      const descriptionBox = document.createElement('div');
      descriptionBox.className = 'board-description-box';
      if (boardType === 'boardTest') {
        descriptionBox.innerHTML = `
          <h3>Hier steht das Problem</h3>
          <p>Hier steht die Ausführung des Problems</p>
        `;
      } else {
        descriptionBox.innerHTML = `
          <h3>Problem-Lösung</h3>
          <p>Das Lösen eines Problems beginnt mit dem ersten Schritt und gutem HinterFRAGEN.</p>
        `;
      }
    
      // 1.3 Focus Note Area - jetzt mit integriertem Text
      const focusNoteArea = document.createElement('div');
      focusNoteArea.className = 'focus-note-area';
      focusNoteArea.innerHTML = `
        <h2 class="area-main-title">Focus Note</h2>
        <div class="focus-note-content">
          <div id="focus-note-display" class="focus-note-display">Schreiben sie hier die Focus Note der Sitzung rein</div>
          <div id="focus-note-editable" class="notiz-content" contenteditable="true" style="display: none;">Schreiben sie hier die Focus Note der Sitzung rein</div>
        </div>
      `;
      focusNoteArea.id = 'focus-note-area';
    
      // 1.4 Notizzettel Box im Post-It Stil (abziehbar)
      const notizzettelBox = document.createElement('div');
      notizzettelBox.className = 'notizzettel-box';
      notizzettelBox.textContent = ''; // Kein Text im Stapel
      notizzettelBox.addEventListener('mousedown', startDragNewNote);

    
      // Header-Elemente hinzufügen
      headerArea.appendChild(infoBox);
      headerArea.appendChild(descriptionBox);
      headerArea.appendChild(focusNoteArea);
      headerArea.appendChild(notizzettelBox);
    
      // 2. Hauptbereich für Karten erstellen
      const mainArea = document.createElement('div');
      mainArea.className = 'board-main-area';
    
      // 2.1 Drei Bereiche für die Karten - jetzt kleiner und formattiert für Spielkarten
      const problemArea = document.createElement('div');
      problemArea.className = 'card-placeholder-area problem-area';
      if (boardType === 'boardTest') {
        problemArea.innerHTML = `
          <h2 class="area-main-title">Feld1</h2>
        `;
      } else {
        problemArea.innerHTML = `
          <h2 class="area-main-title">Problem</h2>
          <h3 class="area-subtitle">Wie machen Sie Ihr Problem?</h3>
        `;
      }
      problemArea.id = 'problem-area';
      
      const secretWinArea = document.createElement('div');
      secretWinArea.className = 'card-placeholder-area secretWin-area';
      if (boardType === 'boardTest') {
        secretWinArea.innerHTML = `
          <h2 class="area-main-title">Feld2</h2>
        `;
      } else {
        secretWinArea.innerHTML = `
          <h2 class="area-main-title">Geheimer Gewinn</h2>
          <h3 class="area-subtitle">Was ist das Gute am jetzigen Zustand?</h3>
        `;
      }
      secretWinArea.id = 'secretWin-area';
      
      const firstStepArea = document.createElement('div');
      firstStepArea.className = 'card-placeholder-area firstStep-area';
      if (boardType === 'boardTest') {
        firstStepArea.innerHTML = `
          <h2 class="area-main-title">Feld3</h2>
        `;
      } else {
        firstStepArea.innerHTML = `
          <h2 class="area-main-title">Erster Schritt</h2>
          <h3 class="area-subtitle">Welches Verhalten ist ein guter Einstieg zur Lösung?</h3>
        `;
      }
      firstStepArea.id = 'firstStep-area';
    
      // Hauptbereich-Elemente hinzufügen
      mainArea.appendChild(problemArea);
      mainArea.appendChild(secretWinArea);
      mainArea.appendChild(firstStepArea);
    
      // Alles zum Board-Bereich hinzufügen
      const boardArea = document.querySelector('.board-area');
      boardArea.innerHTML = ''; // Vorhandene Elemente entfernen
      boardArea.appendChild(headerArea);
      boardArea.appendChild(mainArea);
    
      // Den End-Session Button zum Footer hinzufügen (falls nicht bereits vorhanden)
      ensureEndSessionButton();
    

    } else {
      // Bestehender Code für andere Board-Typen
      const placeholders = [
        { id: 'platz1', label: 'Platz 1', left: '20%', top: '70%' },
        { id: 'platz2', label: 'Platz 2', left: '50%', top: '70%' },
        { id: 'platz3', label: 'Platz 3', left: '80%', top: '70%' }
      ];
      
      const cardPlaceholdersContainer = document.createElement('div');
      cardPlaceholdersContainer.id = 'card-placeholders';
      
      placeholders.forEach(place => {
        const placeholder = document.createElement('div');
        placeholder.className = 'card-placeholder';
        placeholder.id = place.id;
        placeholder.textContent = place.label;
        placeholder.style.left = place.left;
        placeholder.style.top = place.top;
        
        cardPlaceholdersContainer.appendChild(placeholder);
      });
      
      document.querySelector('.board-area').appendChild(cardPlaceholdersContainer);
    }
  };

  // Teilnehmerliste initialisieren
  const initializeParticipants = () => {
    if (!window.sessionData || !Array.isArray(window.sessionData.participants)) return;
    if (!participantsContainer) return;
    
    // Container leeren
    participantsContainer.innerHTML = '';
    
    // Teilnehmer der Sitzung anzeigen
    const participants = (window.sessionData?.participants) || [];
    
    participants.forEach(participant => {
      const participantElement = document.createElement('div');
      participantElement.className = 'participant';
      participantElement.dataset.participantId = participant.id;
      
      // Anzeige je nach Rolle unterschiedlich gestalten
      const isOwner = participant.role === 'owner';
      const isCurrentUser = participant.id === SessionStorage.getCurrentUserId();
      
      participantElement.innerHTML = `
        <span class="participant-name ${isOwner ? 'owner' : ''}">
          ${participant.name} ${isOwner ? '(Ersteller)' : ''} ${isCurrentUser ? '(Sie)' : ''}
        </span>
      `;
      
      participantsContainer.appendChild(participantElement);
    });
  };

  const setupFocusNoteEditable = () => {
    const focusNoteEditable = document.getElementById('focus-note-editable');
    const focusNoteDisplay = document.getElementById('focus-note-display');
    if (!focusNoteEditable || !focusNoteDisplay) return;
    
    // Klick auf den angezeigten Text aktiviert das Bearbeitungsfeld
    focusNoteDisplay.addEventListener('click', function() {
      // Anzeige ausblenden und Editierfeld einblenden
      focusNoteDisplay.style.display = 'none';
      focusNoteEditable.style.display = 'block';
      
      // Wenn es der Platzhaltertext ist, leeren
      if (focusNoteEditable.textContent === 'Schreiben sie hier die Focus Note der Sitzung rein') {
        focusNoteEditable.textContent = '';
      }
      
      // Fokus auf das Editierfeld setzen
      focusNoteEditable.focus();
    });
    
    // Bei Fokus den Platzhaltertext sofort entfernen
    focusNoteEditable.addEventListener('focus', function() {
      if (this.textContent === 'Schreiben sie hier die Focus Note der Sitzung rein') {
        this.textContent = '';
      }
    });
    
    // Wenn der Fokus verloren geht, Editierfeld ausblenden und Anzeige wieder einblenden
    focusNoteEditable.addEventListener('blur', function() {
      const text = this.textContent.trim();
      
      // Editierfeld ausblenden
      focusNoteEditable.style.display = 'none';
      
      // Anzeige-Text aktualisieren und einblenden
      if (text === '') {
        focusNoteDisplay.textContent = 'Schreiben sie hier die Focus Note der Sitzung rein';
        focusNoteDisplay.classList.remove('has-content');
      } else {
        focusNoteDisplay.textContent = text;
        focusNoteDisplay.classList.add('has-content');
      }
      
      focusNoteDisplay.style.display = 'block';

      saveCurrentBoardState();
    });
    
    // Enter-Taste bestätigt die Eingabe
    focusNoteEditable.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.blur(); // Fokus entfernen, löst das blur-Event aus
      }
    });
  };

  function imageExists(src) {
    return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
    });
  }

  function detectCardCount(basePath, maxProbe = 200) {
    return new Promise(async (resolve) => {
    let count = 0;
    for (let i = 1; i <= maxProbe; i++) {
    const exists = await imageExists(`${basePath}/card${i}.png`);
    if (!exists) break;
    count = i;
    }
    resolve(count);
    });
  }

  // Liest /app/assets/cards/<deck>/meta.json und setzt --card-ratio sowie ein Friendly-Format
  async function applyDeckFormatRatio(deckSlug){
    try{
      // 1) meta.json laden
      const res = await fetch(`/app/assets/cards/${encodeURIComponent(deckSlug)}/meta.json?ts=${Date.now()}`, { cache:'no-store' });
      if(!res.ok) { console.debug('applyDeckFormatRatio: meta.json fehlt für', deckSlug); return; }
      const meta = await res.json();

      // 2) Format-String flexibel lesen: "format" | "card_format" | "ratio"
      const fmtRaw = (meta && (meta.format || meta.card_format || meta.ratio))
        ? String(meta.format || meta.card_format || meta.ratio).trim().toLowerCase()
        : '';

      // 3) Namens- und W:H-Mapping → JS-Ratio = H/W
      //    Gewünscht: 2:3 (Skat hoch), 3:2 (gedrehte Skat = quer), 1:2 (hoch schlank), 2:1 (quer schlank)
      let ratio = null;
      const named = {
        'skat':    (3/2),   // 2:3 => H/W = 3/2
        '2:3':     (3/2),
        '3:2':     (2/3),
        '1:2':     (2/1),
        '2:1':     (1/2),
        // ggf. historische/alias Namen:
        'skat-l':  (2/3),
        'square-rounded': 1,
        'long-portrait':  (2/1)
      };

      ratio = named[fmtRaw] ?? null;

      if (!ratio && /^\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?$/.test(fmtRaw)) {
        const [wStr,hStr] = fmtRaw.split(':').map(s => parseFloat(s));
        if (isFinite(wStr) && isFinite(hStr) && wStr > 0 && hStr > 0) {
          ratio = hStr / wStr;
        }
      }

      if (!ratio) {
        // Fallback: nichts überschreiben, falls zuvor gesetzt
        ratio = window.RATIO || (260/295);
      }

      // 4) Werte setzen
      window.RATIO = ratio;
      document.documentElement.style.setProperty('--card-ratio', String(ratio));

      // freundlicher String (für applySampleCardFromTemplate)
      window.CARDSET_FORMAT =
        fmtRaw || (ratio === 1 ? '1:1' : (Math.abs(ratio-(3/2))<0.001 ? '2:3'
                  : (Math.abs(ratio-(2/3))<0.001 ? '3:2'
                  : (Math.abs(ratio-(2/1))<0.001 ? '1:2'
                  : (Math.abs(ratio-(1/2))<0.001 ? '2:1' : '2:3')))));
    }catch(e){
      console.debug('applyDeckFormatRatio failed', e);
    }
  }


  // Karten erstellen und als Stapel anordnen
  // Kartenstapel für board1/boardTest erzeugen (Decks robust auflösen)
  async function createCards() {

    // Helfer lokal
    const canonDeckSlug = (s = '') => {
      s = String(s || '').toLowerCase();
      if (['starterdeck','starter','deck_starter','startkarten'].includes(s)) return 'deck1';
      if (['testdeck','test_deck'].includes(s)) return 'test_deck';
      return s || 'deck1';
    };
    const resolveDeck = () => {
      const url = new URLSearchParams(location.search);
      const raw = url.get('deck') || (window.CC_BOOT && window.CC_BOOT.deck) || (window.boardType === 'boardTest' ? 'test_deck' : 'deck1');
      return canonDeckSlug(raw);
    };

    // Zielcontainer (linke Info-Box) suchen
    const infoBox = document.querySelector('.board-info-box') || document.getElementById('board-info-box') || document.querySelector('.board-area');
    if (!infoBox) {
      console.warn('createCards(): kein Container gefunden – weder .board-info-box noch .board-area');
      return;
    }

    // Container vorbereiten
    infoBox.textContent = '';
    infoBox.style.position = 'relative';

    // Kartenstapel-Element
    const stack = document.createElement('div');
    stack.className = 'card-stack';
    stack.id = 'card-stack';

    // Bevorzugte Host-Box: aktive BG-Box aus dem Template
    const bgBox = (() => {
      const bgId = window.__CARD_BG_ID__;
      if (!bgId) return null;
      // großzügiger Selektor: funktioniert mit Live- und Builder-Markup
      return document.querySelector(`.bb-bgrect[data-id="${bgId}"], [data-id="${bgId}"].bb-bgrect, [data-id="${bgId}"]`);
    })();

    // Host bestimmen (Fallbacks, falls keine bgBox gefunden wurde)
    const host =
      bgBox ||
      document.getElementById('board-info-box') ||
      document.querySelector('.board-area');

    if (!host) {
      console.warn('createCards(): kein Host gefunden – weder bgBox, #board-info-box noch .board-area');
      return;
    }

    // Host relativ positionieren, falls noch nicht geschehen
    if (!host.style.position) host.style.position = 'relative';

    // Stapel mittig in der Box platzieren (ohne Messung)
    stack.style.position  = 'absolute';
    stack.style.width     = 'var(--card-w)';
    stack.style.height    = 'var(--card-h)';
    stack.style.left      = '50%';
    stack.style.top       = '50%';
    stack.style.transform = 'translate(-50%, -50%)';
    stack.style.zIndex    = '10000';

    host.appendChild(stack);

    // Optional: Nach Layout eine exakte Zentrierung mit Maßen (falls nötig)
    if (bgBox) {
      requestAnimationFrame(() => {
        const sw = stack.offsetWidth, sh = stack.offsetHeight;
        const pw = bgBox.clientWidth, ph = bgBox.clientHeight;
        stack.style.left = Math.round((pw - sw) / 2) + 'px';
        stack.style.top  = Math.round((ph - sh) / 2) + 'px';
      });
    }

    // Globale Arrays initialisieren
    window.cards = [];
    const deckSlug = resolveDeck();
    const deckPath = `/app/assets/cards/${deckSlug}`;
    await applyDeckFormatRatio(deckSlug); // Ratio + CSS-Var setzen, auch window.CARDSET_FORMAT

    // Anzahl Karten feststellen und Stapel aufbauen
    if (typeof detectCardCount !== 'function') {
      console.warn('detectCardCount() fehlt – Karten können nicht geladen werden.');
      if (typeof window.showLoadFailureOverlay === 'function') {
        window.showLoadFailureOverlay('cardset', deckSlug);
      }
      return;
    }

    detectCardCount(deckPath).then((total) => {
      if (!total || total < 1) {
        console.warn('Keine Kartenbilder gefunden unter', deckPath);
        if (typeof window.showLoadFailureOverlay === 'function') {
          window.showLoadFailureOverlay('cardset', deckSlug);
        }
        return;
      }

      for (let i = 1; i <= total; i++) {
        const card = document.createElement('div');
        card.className = 'card';
        card.id = `card-${i}`;
        card.dataset.cardId = String(i);

        // leichte Staffelung
        const offset = (i - 1) * 0.5;
        card.style.position = 'absolute';
        card.style.left = `${offset}px`;
        card.style.top  = `${offset}px`;
        card.style.zIndex = i;

        card.innerHTML = `
          <div class="card-front">
            <img src="${deckPath}/card${i}.png" alt="Karte ${i}" style="width:100%;height:100%;object-fit:contain;">
          </div>
          <div class="card-back" style="background-image:url('${deckPath}/card-back.png')">
            <div class="card-back-design"></div>
          </div>
        `;

        // Interaktionen
        if (typeof flipCard === 'function') card.addEventListener('dblclick', () => flipCard(card));
        if (typeof makeDraggable === 'function') makeDraggable(card);

        stack.appendChild(card);
        window.cards.push(card);
      }

      // kurz warten, dann mischen + gespeicherten Zustand versuchen
      (async () => {
        const restored = await loadSavedBoardState(); // true/false vom Restore nutzen
        if (!restored) {
          setTimeout(() => { try { shuffleCards(); } catch(e) { console.warn(e); } }, 300);
        }
      })();
    });
  }


  // Karte zum Stapel zurücklegen
  // Karte zum Stapel zurücklegen – animiert (Flug → Flip → unten einsortieren)
  function returnCardToStack(card) {
    if (!card) return;

    const cardStack = document.getElementById('card-stack');
    const boardArea = document.querySelector('.board-area');
    if (!cardStack || !boardArea) return;

    // Falls Karte in einem Platzhalter steckte → freigeben
    if (card.dataset.placedAt) {
      const ph = document.getElementById(card.dataset.placedAt);
      if (ph) ph.classList.remove('filled');
      delete card.dataset.placedAt;
    }

    // Ausgangs- und Zielkoordinaten ermitteln (relativ zur Board-Stage & mit Scale)
    const scale     = parseFloat(boardArea.dataset.scale || '1');
    const boardRect = boardArea.getBoundingClientRect();
    const stackRect = cardStack.getBoundingClientRect();
    const cardRect  = card.getBoundingClientRect();

    // Ziel: mittig über dem Stapel leicht „aufsetzen“
    const targetLeft = (stackRect.left - boardRect.left) / scale
                    + (stackRect.width  - cardRect.width)  / (2 * scale);
    const targetTop  = (stackRect.top  - boardRect.top)  / scale + 6;

    // Karte in die Bühne hängen & Startposition setzen, damit die Transition sichtbar ist
    card.classList.remove('being-dragged');
    if (!boardArea.contains(card)) {
      card.style.position = 'absolute';
      card.style.left = ((cardRect.left - boardRect.left) / scale) + 'px';
      card.style.top  = ((cardRect.top  - boardRect.top)  / scale) + 'px';
      boardArea.appendChild(card);
    }

    // Flug vorbereiten
    card.classList.remove('being-dragged');
    card.style.zIndex = String(Math.max(getHighestInteractiveZIndex() + 10, 1500));
    card.classList.add('returning');

    // Reflow triggern, dann Zielkoordinaten setzen → löst Transition aus
    void card.offsetWidth;
    card.style.left = Math.round(targetLeft) + 'px';
    card.style.top  = Math.round(targetTop)  + 'px';

    const FLY_MS  = 330; // „zügig, aber nicht zu schnell“
    const FLIP_MS = 300;

    // Nach dem Flug: ggf. Flip (nur wenn Vorderseite sichtbar)
    setTimeout(() => {
      let extraDelay = 0;
      if (card.classList.contains('flipped')) {
        // dezenter Flip über dem Stapel
        try {
          if (typeof cardFlipSound !== 'undefined' && cardFlipSound) {
            cardFlipSound.currentTime = 0;
            cardFlipSound.play().catch(()=>{});
          }
        } catch {}
        card.classList.add('flipping');
        // eigentlicher Flip – entspricht eurer Flip-Logik (Vorder-/Rückseite)
        setTimeout(() => {
          card.classList.remove('flipping');
          card.classList.remove('flipped');
        }, FLIP_MS);
        extraDelay = FLIP_MS;
      }

      // Nach Flip: Karte UNTEN in den Stapel einsortieren und Offsets/Z-Index setzen
      setTimeout(() => {
        card.classList.remove('returning');

        // als erstes Kind einfügen → „unten im Stapel“
        if (cardStack.firstChild) cardStack.insertBefore(card, cardStack.firstChild);
        else cardStack.appendChild(card);

        const stackCards = Array.from(cardStack.querySelectorAll(':scope > .card'));
        stackCards.forEach((el, idx) => {
          const offset = idx * 0.5;
          el.style.position = 'absolute';
          el.style.left = offset + 'px';
          el.style.top  = offset + 'px';
          el.style.zIndex = String(idx + 1); // unten→oben
        });

        // Speichern/nach außen signalisieren
        if (typeof saveCurrentBoardState === 'function') saveCurrentBoardState();
      }, extraDelay + 10);
    }, FLY_MS);
  }
  window.returnCardToStack = returnCardToStack;


  // Event-Listener für Tastaturkürzel
  const setupKeyboardShortcuts = () => {
    // Variablen zum Verfolgen, ob Maus über Karte/Stapel ist
    // WICHTIG: Diese müssen global bleiben, damit sie in Eventhändlern verfügbar sind
    window.isHoveringCard = false;
    window.isHoveringStack = false;
    window.hoveredCard = null;
    
    // Hover-Tracking für Karten einrichten
    function setupCardHoverTracking() {
      console.log("[DEBUG] Richte Hover-Tracking ein...");
      
      // Alle vorherigen Event-Listener entfernen
      document.querySelectorAll('.card').forEach(card => {
        if (card._mouseenterHandler) {
          card.removeEventListener('mouseenter', card._mouseenterHandler);
        }
        if (card._mouseleaveHandler) {
          card.removeEventListener('mouseleave', card._mouseleaveHandler);
        }
        
        // Alle Hover-Zustände zurücksetzen
        card._isHovered = false;
      });
      
      console.log("[DEBUG] Anzahl Karten für Hover-Tracking:", document.querySelectorAll('.card').length);
      
      // Neue Event-Listener für alle Karten einrichten
      document.querySelectorAll('.card').forEach(card => {
        // Neue Handler-Funktionen erstellen
        const enterHandler = () => {
          console.log(`[DEBUG] Maus über Karte ${card.id}`);
          window.isHoveringCard = true;
          window.hoveredCard = card;
          card._isHovered = true;
        };
        
        const leaveHandler = () => {
          console.log(`[DEBUG] Maus verlässt Karte ${card.id}`);
          window.isHoveringCard = false;
          window.hoveredCard = null;
          card._isHovered = false;
        };
        
        // Handler in der Karte speichern, damit wir sie später entfernen können
        card._mouseenterHandler = enterHandler;
        card._mouseleaveHandler = leaveHandler;
        
        // Event-Listener hinzufügen
        card.addEventListener('mouseenter', enterHandler);
        card.addEventListener('mouseleave', leaveHandler);
      });

      // Auch für den Kartenstapel
      const cardStack = document.getElementById('card-stack');
      if (cardStack) {
        // Alten Stack-Hover-Handler entfernen
        if (cardStack._stackEnterHandler) {
          cardStack.removeEventListener('mouseenter', cardStack._stackEnterHandler);
        }
        if (cardStack._stackLeaveHandler) {
          cardStack.removeEventListener('mouseleave', cardStack._stackLeaveHandler);
        }
        
        // Neue Handler erstellen
        const stackEnterHandler = () => {
          console.log("[DEBUG] Maus über Kartenstapel");
          window.isHoveringCard = true;
        };
        
        const stackLeaveHandler = () => {
          console.log("[DEBUG] Maus verlässt Kartenstapel");
          // Nur zurücksetzen, wenn nicht über einer einzelnen Karte
          if (!window.hoveredCard) {
            window.isHoveringCard = false;
          }
        };
        
        // Handler speichern
        cardStack._stackEnterHandler = stackEnterHandler;
        cardStack._stackLeaveHandler = stackLeaveHandler;
        
        // Neue Event-Listener hinzufügen
        cardStack.addEventListener('mouseenter', stackEnterHandler);
        cardStack.addEventListener('mouseleave', stackLeaveHandler);
        // Capture-Listener ergänzen, um Stack-Hover-Zustand zuverlässig zu setzen
        cardStack.addEventListener('mouseenter', () => {
          window.isHoveringStack = true;
          window.isHoveringCard = false;
          window.hoveredCard = null;
        }, true);
        cardStack.addEventListener('mouseleave', () => {
          window.isHoveringStack = false;
        }, true);
        
        console.log("[DEBUG] Hover-Tracking für Kartenstapel eingerichtet");
      }

      // Zusätzliche, robuste Erkennung via Mausbewegung (falls mouseenter nicht greift)
      if (window._hoverMoveHandler) {
        document.removeEventListener('mousemove', window._hoverMoveHandler);
      }
      let _hoverRAF = 0, _lastEvt = null;
      window._hoverMoveHandler = function(e){
        _lastEvt = e;
        if (_hoverRAF) return;
        _hoverRAF = requestAnimationFrame(() => {
          _hoverRAF = 0;
          const ev = _lastEvt;
          const el = document.elementFromPoint(ev.clientX, ev.clientY);
          const stackEl = el ? el.closest('#card-stack') : null;
          const cardEl  = el ? el.closest('.card')       : null;
          // … deine bestehende Logik …
        });
      };
      document.addEventListener('mousemove', window._hoverMoveHandler, { passive: true });

      console.log("[DEBUG] Hover-Tracking Setup abgeschlossen");
    }
    
    // Initial einrichten
    setupCardHoverTracking();
    
    // Bei Änderung des Board-Status (neue Karten) Tracking erneuern
    (function(){
      let lastCount = 0;
      let raf = 0;

      function maybeRebind(){
        raf = 0;
        if (window.__RT_APPLYING__) return;
        if (document.activeElement && document.activeElement.isContentEditable) return;
        const count = document.querySelectorAll('.card').length;
        if (count !== lastCount) {
          lastCount = count;
          setupCardHoverTracking();
        }
      }

      document.addEventListener('boardStateUpdated', () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(maybeRebind);
      });
    })();


    
    // Debug-Ausgabe hinzufügen, um den Status zu überwachen
    setInterval(() => {
      if (window.isHoveringCard) {
        console.log(`[DEBUG] Hover-Status: ${window.isHoveringCard}, Karte: ${window.hoveredCard ? window.hoveredCard.id : 'Stapel'}`);
      }
    }, 5000); // Alle 5 Sekunden, nur zu Debug-Zwecken

    // Tastaturverhalten überschreiben: nur bei Hover über Karte/Stapel aktiv
    document.addEventListener('keydown', (e) => {
      const isInTextInput =
        (e.target && e.target.isContentEditable) ||
        (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'));
      if (isInTextInput) return;

      const key = (e.key || '').toLowerCase();

      // F: nur Karte direkt unter dem Cursor umdrehen
      if (key === 'f') {
        e.stopImmediatePropagation();
        if (window.hoveredCard) {
          flipCard(window.hoveredCard);
        }
        return;
      }

      // M: nur mischen, wenn Cursor über dem Stapel (nicht über einzelner Karte)
      if (key === 'm') {
        e.stopImmediatePropagation();

        if (window.isHoveringStack) {
          const cardStack = document.getElementById('card-stack');
          if (!cardStack) return;

          // aktuelle IDs der Stapelkarten holen
          const ids = Array.from(cardStack.querySelectorAll(':scope > .card')).map(c => c.id);

          // Fisher–Yates auf der ID-Liste → deterministische Order zum Senden
          for (let i = ids.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [ids[i], ids[j]] = [ids[j], ids[i]];
          }

          // lokal anwenden (inkl. Animation/Sound) …
          shuffleCards(ids);
          // … und mitsenden
          shouldApply('deck', RT_PRI());
          sendRT({ t: 'deck_shuffle', order: ids, prio: RT_PRI(), ts: Date.now() });
        }
        return;
      }

      // B: nur Karte direkt unter dem Cursor zurück zum Stapel
      if (key === 'b') {
        e.stopImmediatePropagation();
        if (window.hoveredCard) {
          returnCardToStack(window.hoveredCard);

          // Gate setzen + Broadcast
          shouldApply(`sendback:${window.hoveredCard.id}`, RT_PRI());
          sendRT({
            t: 'card_sendback',
            id: window.hoveredCard.id,
            prio: RT_PRI(),
            ts: Date.now()
          });
        }
        return;
      }
    }, true);

    document.addEventListener('keydown', (e) => {
    // Nur blockieren, wenn der Nutzer gerade wirklich in einem Eingabefeld tippt
    const isInTextInput =
    (e.target && e.target.isContentEditable) ||
    (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'));

    if (isInTextInput) return;
    });
  };

  // Hilfsfunktion, um die oberste Karte zu finden
  const findTopCard = () => {
    if (cards.length === 0) return null;
    
    let topCard = cards[0];
    let highestZIndex = parseInt(getComputedStyle(cards[0]).zIndex, 10);
    
    for (let i = 1; i < cards.length; i++) {
      const zIndex = parseInt(getComputedStyle(cards[i]).zIndex, 10);
      if (zIndex > highestZIndex) {
        highestZIndex = zIndex;
        topCard = cards[i];
      }
    }
    
    return topCard;
  };

  // Liefert den höchsten z-index unter allen Karten, die NICHT im Stapel liegen
  function getHighestCardZIndexOnBoard() {
    const boardCards = Array.from(document.querySelectorAll('.card'))
      .filter(c => !c.closest('#card-stack'));
    let highest = 1199; // Basis: etwas über typischen UI-Elementen (z.B. 1000)
    boardCards.forEach(c => {
      const z = parseInt(getComputedStyle(c).zIndex, 10);
      if (!isNaN(z) && z > highest) highest = z;
    });
    return highest;
  }

  // Normalisiert den z-index einer Karte nach dem Loslassen:
  // - Über Basis-UI (min 1200),
  // - Unterhalb von Notizen im Drag/Edit (unter 10000)
  function normalizeCardZIndex(card) {
    const newZ = Math.max(getHighestInteractiveZIndex() + 1, 1200);
    card.style.zIndex = newZ;
  }

  // Liefert den h�chsten z-index �ber allen interaktiven Elementen (Karten au�erhalb des Stapels und Notizzettel)
  // Global verf�gbar machen, damit alle Handler darauf zugreifen k�nnen
  if (!window.getHighestInteractiveZIndex) {
    window.getHighestInteractiveZIndex = function() {
      const interactive = [
        ...Array.from(document.querySelectorAll('.card')).filter(c => !c.closest('#card-stack')),
        ...Array.from(document.querySelectorAll('.notiz')),
      ];
      let highest = 1199; // Basis leicht �ber UI-Boxen
      interactive.forEach(el => {
        const z = parseInt(getComputedStyle(el).zIndex, 10);
        if (!isNaN(z) && z > highest) highest = z;
      });
      return highest;
    };
  }

  function getHighestInteractiveZIndex() { return window.getHighestInteractiveZIndex(); }
  // Focus Note erstellen
  const createFocusNote = () => {
    if (boardType === 'board1' || boardType === 'boardTest') {
      // Bei Board1 platzieren wir die Focus Note im vorgesehenen Bereich
      const focusNoteArea = document.getElementById('focus-note-area');
  // Liefert den h�chsten z-index unter allen interaktiven Elementen (Karten au�erhalb des Stapels und Notizzettel)
  function getHighestInteractiveZIndex() {
    const interactive = [
      ...Array.from(document.querySelectorAll('.card')).filter(c => !c.closest('#card-stack')),
      ...Array.from(document.querySelectorAll('.notiz')),
    ];
    let highest = 1199; // Basis leicht �ber UI-Boxen
    interactive.forEach(el => {
      const z = parseInt(getComputedStyle(el).zIndex, 10);
      if (!isNaN(z) && z > highest) highest = z;
    });
    return highest;
  }
      if (focusNoteArea) {
        // Wir müssen nichts tun, da der Text bereits in createCardPlaceholders gesetzt wurde
        // Der Text ist bereits in der focus-note-content enthalten
      }
    } else {
      // Bestehender Code für andere Board-Typen
      const focusNote = document.createElement('div');
      focusNote.className = 'note focus-note';
      focusNote.style.top = '30%';
      focusNote.style.left = '50%';
      focusNote.style.transform = 'translate(-50%, -50%)';
      focusNote.style.backgroundColor = '#9FE2BF'; // Türkis/Mint Farbe
      
      focusNote.innerHTML = `
        <div class="note-content" contenteditable="false">
          ${focusNoteTexts[boardType] || "Fokus der Sitzung"}
        </div>
        <div class="note-actions">
          <button class="note-color-btn" title="Farbe ändern">🎨</button>
        </div>
      `;
      
      notesContainer.appendChild(focusNote);
      // Resize/AutoGrow für Focus-Note
      attachNoteResizeObserver(focusNote);
      attachNoteAutoGrow(focusNote);
      
      // Event-Listener für Farbe ändern
      focusNote.querySelector('.note-color-btn').addEventListener('click', (e) => {
        const colors = ['#9FE2BF', '#FFD700', '#FF7F50', '#CCCCFF', '#FFF8DC'];
        const currentColor = focusNote.style.backgroundColor;
        const currentIndex = colors.indexOf(currentColor);
        const nextIndex = (currentIndex + 1) % colors.length;
        focusNote.style.backgroundColor = colors[nextIndex];
      });
      
      // Drag-and-Drop für die Notiz aktivieren
      makeDraggable(focusNote);
    }
  };  
    
  // Funktion zum Starten des Ziehens eines neuen Notizzettels
  function startDragNewNote(e) {
    const btn = (typeof e.button === 'number') ? e.button : 0; // Touch hat kein button → als Links-Klick werten
    if (btn !== 0) return;
    e.preventDefault();

    const notizId = 'note-' + Date.now();
    const note = document.createElement('div');
    note.className = 'notiz';
    note.id = notizId;
    note.innerHTML = `<div class="notiz-content" contenteditable="false"></div>`;

    const parent = ensureNotesContainer();            // WICHTIG
    parent.appendChild(note);                         // ← nicht body!

    attachNoteResizeObserver(note);
    attachNoteAutoGrow(note);
    setupNoteEditingHandlers(note);
    enhanceDraggableNote(note);
    // Sofort als Drag kennzeichnen und Cursor setzen
    note.classList.add('being-dragged');
    document.body.classList.add('ccs-no-select');
    document.onselectstart = () => false;
    document.body.style.cursor = 'grabbing';

    const s = parseFloat((document.querySelector('.board-area')?.dataset.scale) || '1') || 1;
    const parentRect = parent.getBoundingClientRect();

    // Beim ersten Frame Maße haben (für Zentrierung)
    const halfW = (note.offsetWidth  || 180) / 2;
    const halfH = (note.offsetHeight || 180) / 2;

    const setPosFromClient = (cx, cy) => {
      const xu = (cx - parentRect.left) / s;         // unskaliert, relativ zum Parent
      const yu = (cy - parentRect.top)  / s;
      note.style.left = (xu - halfW) + 'px';
      note.style.top  = (yu - halfH) + 'px';
      note.style.zIndex = Math.max(getHighestInteractiveZIndex() + 1, 1200);
    };

    // Position unter dem Cursor setzen & während Drag verfolgen
    setPosFromClient(e.clientX, e.clientY);
    // SOFORT an alle: neue Notiz an Startposition erzeugen/broadcasten
    {
      const stageRect = getStageRect();
      const px = parseFloat(note.style.left) || 0;
      const py = parseFloat(note.style.top)  || 0;
      const pxStage = ((parentRect.left - stageRect.left) / s) + px;
      const pyStage = ((parentRect.top  - stageRect.top ) / s) + py;
      const { nx, ny } = toNorm(pxStage, pyStage);

      const rect = note.getBoundingClientRect();
      sendRT({
        t: 'note_create',
        id: note.id, nx, ny,
        z: note.style.zIndex || '',
        content: note.querySelector('.notiz-content')?.textContent || '',
        color: note.style.backgroundColor || (note.dataset.color || ''),
        w: Math.round(rect.width), h: Math.round(rect.height),
        prio: RT_PRI(), ts: Date.now()
      });
    }
    let _rtTick = 0;
    const move = (ev) => {
      setPosFromClient(ev.clientX, ev.clientY);

      const now = performance.now();
      if (now - _rtTick >= 33) {
        _rtTick = now;

        const stageRect = getStageRect();
        const px = parseFloat(note.style.left) || 0;
        const py = parseFloat(note.style.top)  || 0;
        const pxStage = ((parentRect.left - stageRect.left) / s) + px;
        const pyStage = ((parentRect.top  - stageRect.top ) / s) + py;
        const { nx, ny } = toNorm(pxStage, pyStage);

        sendRT({ t:'note_move', id:note.id, nx, ny, prio:RT_PRI(), ts:Date.now() });
      }
    };

    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);

      // Cursor/Selection zurücksetzen
      document.body.classList.remove('ccs-no-select');
      document.onselectstart = null;
      document.body.style.removeProperty('cursor');
      note.classList.remove('being-dragged');

      // Normierte Koordinaten wie beim späteren Drag ermitteln & senden
      const stageRect = getStageRect();
      const px = parseFloat(note.style.left) || 0;
      const py = parseFloat(note.style.top)  || 0;
      const pxStage = ((parentRect.left - stageRect.left) / s) + px;
      const pyStage = ((parentRect.top  - stageRect.top ) / s) + py;
      const { nx, ny } = toNorm(pxStage, pyStage);
      sendRT({ t:'note_move', id:note.id, nx, ny, prio:RT_PRI(), ts:Date.now() });

      if (typeof saveCurrentBoardState === 'function') saveCurrentBoardState();
    };

    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }


  // Hilfsfunktion, um den höchsten z-index zu finden
  function getHighestZIndex() {
    const elements = document.getElementsByClassName('notiz');
    let highest = 100; // Basiswert
    
    for (let i = 0; i < elements.length; i++) {
      const zIndex = parseInt(window.getComputedStyle(elements[i]).zIndex, 10);
      if (!isNaN(zIndex) && zIndex > highest) {
        highest = zIndex;
      }
    }
    
    return highest;
  }

  // Einrichten der Bearbeitungs-Handler für eine Notiz
  function setupNoteEditingHandlers(notiz) {
    const content = notiz.querySelector('.notiz-content') || notiz.querySelector('.note-content');
    if (!content) return;

    //  Mehrfach-Bindungen verhindern (Enter wurde doppelt verarbeitet)
    if (content.dataset.editHandlersAttached === '1') return;
    content.dataset.editHandlersAttached = '1';
    let _rtNoteDeb = null;
    content.addEventListener('input', () => {
      clearTimeout(_rtNoteDeb);
      _rtNoteDeb = setTimeout(() => {
        sendRT({
          t: 'note_update',
          id: notiz.id,
          content: getNoteText(notiz),
          prio: RT_PRI(),
          ts: Date.now()
        });
      }, 120);
    });
    
    // Doppelklick zum Bearbeiten
    notiz.addEventListener('dblclick', (e) => {
      const blocked = isLockActiveForMe(notiz);
      L('DBLCLICK', { id: notiz.id, blocked, beingDragged: notiz.classList.contains('being-dragged') });
      // Drag-Doppelklick ignorieren & Fremd-Lock respektieren
      if (notiz.classList.contains('being-dragged')) return;
      if (blocked) return;
      if (isLockActiveForMe(notiz)) return;
      // Content-Element auf editierbar setzen
      content.setAttribute('contenteditable', 'true');

      // Bearbeitungs-Flag setzen (global)
      window.__isEditingNote = true;
      window.__editingNoteId = notiz.id;
      
      // Visuelle Rückmeldung hinzufügen
      content.classList.add('editing');
      
      // Optional: Cursor-Animation hinzufügen
      content.classList.add('blinking-cursor');
      
      // Kein DOM-Platzhalter mehr injizieren – Anzeige erfolgt per CSS (:empty:before)
      
      // Dem Notizzettel eine Klasse hinzufügen, um zu zeigen, dass er bearbeitet wird
      notiz.classList.add('is-editing');
      
      // Einen visuellen Indikator für den Bearbeitungsmodus hinzufügen
      if (!notiz.querySelector('.editing-indicator')) {
        const indicator = document.createElement('div');
        indicator.className = 'editing-indicator';
        indicator.innerHTML = '✏️';
        indicator.title = 'Bearbeitungsmodus - Klicken Sie außerhalb, um zu speichern';
        notiz.appendChild(indicator);
      }
      
      // Fokus auf das Textfeld setzen
      content.focus();

      const LEASE_MS = 8000; // 8s gelten die Locks, erneuern wir im Intervall
      notiz.dataset.locked = '1';
      notiz.dataset.lockedBy = (RT && RT.uid) ? RT.uid : '';
      notiz.dataset.lockedUntil = String(Date.now() + LEASE_MS);

      sendRT({ t: 'note_lock', id: notiz.id, lease: LEASE_MS, by: notiz.dataset.lockedBy });

      // alle 4s Lock erneuern, solange noch editiert wird
      clearInterval(notiz._lockRenew);
      notiz._lockRenew = setInterval(() => {
        if (content.getAttribute('contenteditable') === 'true') {
          notiz.dataset.locked = '1';
          notiz.dataset.lockedUntil = String(Date.now() + LEASE_MS);
          sendRT({ t: 'note_lock', id: notiz.id, lease: LEASE_MS, by: notiz.dataset.lockedBy });
        } else {
          clearInterval(notiz._lockRenew);
          notiz._lockRenew = null;
        }
      }, 4000);
      
      // Wenn der Inhalt bereits Text enthält, den Cursor ans Ende setzen
      if (content.textContent.trim() !== '') {
        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(content);
        range.collapse(false); // false = am Ende
        selection.removeAllRanges();
        selection.addRange(range);
      }
      
      e.stopPropagation(); // Verhindert das Bubbling zum Elternelement
      L('EDIT_START_SEND_LOCK', { id: notiz.id, by: RT.uid });
    });
    
    //Hilfsfunktionen für KeyDown
    function insertTextAtCursor(el, text) {
      el.focus();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        el.appendChild(document.createTextNode(text));
        placeCursorAtEnd(el);
        return;
      }
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      // Caret hinter den eingefügten Text setzen
      range.setStart(node, node.length);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function insertHtmlAtCursor(el, html) {
      el.focus();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        el.insertAdjacentHTML('beforeend', html);
        placeCursorAtEnd(el);
        return;
      }
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const frag = document.createDocumentFragment();
      let last = null;
      while (tmp.firstChild) { last = frag.appendChild(tmp.firstChild); }
      range.insertNode(frag);
      if (last) {
        range.setStartAfter(last);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    function placeCursorAtEnd(el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // === Plaintext-Insert-Helfer (keine HTML-Brüche) ===
    function insertTextAtCursor(el, text) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) {
        el.appendChild(document.createTextNode(text));
      } else {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        // Caret hinter den eingefügten Text setzen
        range.setStart(range.endContainer, range.endOffset);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      // wichtig: 'input' feuern, damit dein Debounce -> sendRT('note_update') läuft
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // --- NEU: Keydown-Handler komplett austauschen ---
    content.addEventListener('keydown', (e) => {
      // ESC lässt du woanders beenden; hier nicht blocken
      if (e.key === 'Escape') return;

      // Tab nicht als Zeichen in die Notiz schreiben
      if (e.key === 'Tab') { e.preventDefault(); return; }

      const txtNow = content.textContent || '';
      const emptyNow = txtNow.trim() === '';

      // 1) Erster *druckbarer* Tastendruck in leerer Notiz:
      //    -> "• " + (erstes Zeichen) einfügen
      const printable = (e.key.length === 1) && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (emptyNow && printable) {
        e.preventDefault();
        insertTextAtCursor(content, '• ' + e.key);
        return;
      }

      // 2) Enter erzeugt immer newline + nächsten Aufzählungspunkt – als Plaintext
      if (e.key === 'Enter') {
        e.preventDefault();
        // Wenn noch leer: starte mit "• ", sonst Zeilenumbruch + "• "
        const prefix = emptyNow ? '• ' : '\n• ';
        insertTextAtCursor(content, prefix);
        return;
      }

      // Sonst Standardverhalten (Browser tippt das Zeichen an Cursor-Position ein)
    });

    
    // Bearbeitung beenden, wenn außerhalb geklickt wird
    function endEditing() {
      if (content.getAttribute('contenteditable') !== 'true') return;

      // Edit-Modus aus
      content.setAttribute('contenteditable', 'false');
      content.classList.remove('editing','blinking-cursor');
      notiz.classList.remove('is-editing');
      const indicator = notiz.querySelector('.editing-indicator');
      if (indicator) indicator.remove();

      // Lock-Erneuerung stoppen
      clearInterval(notiz._lockRenew);
      notiz._lockRenew = null;

      // Lokal entsperren
      delete notiz.dataset.locked;
      delete notiz.dataset.lockedBy;
      delete notiz.dataset.lockedUntil;

      // *** WICHTIG: finalText zuerst ermitteln ***
      const finalText = (typeof getNoteText === 'function')
        ? getNoteText(notiz)
        : (content.innerText || content.textContent || '');

      // Debug
      L('EDIT_END', { id: notiz.id, finalTextLen: (finalText || '').length });

      // Unlock senden
      sendRT({ t: 'note_unlock', id: notiz.id });

      // Finalen Text broadcasten
      sendRT({
        t: 'note_update',
        id: notiz.id,
        content: finalText,
        prio: RT_PRI(),
        ts: Date.now()
      });

      // Leere Notizen entfernen, sonst Zustand speichern
      if ((finalText || '').trim() === '') {
        sendRT({ t: 'note_delete', id: notiz.id, prio: RT_PRI(), ts: Date.now() });
        notiz.remove();
        notes = (Array.isArray(notes) ? notes.filter(n => n !== notiz) : notes);
      } else {
        if (typeof saveCurrentBoardState === 'function') saveCurrentBoardState();
      }

      // Bearbeitungs-Flags zurücksetzen
      window.__isEditingNote = false;
      window.__editingNoteId = null;
    }

    // 1) Klick außerhalb
    document.addEventListener('click', (e) => {
      if (!notiz.contains(e.target) && content.getAttribute('contenteditable') === 'true') {
        endEditing();
      }
    });

    // 2) Blur auf dem Content-Element
    content.addEventListener('blur', () => {
      if (content.getAttribute('contenteditable') === 'true') endEditing();
    });

    // 3) Sicherheitshalber: Tab/Seite verlässt
    window.addEventListener('beforeunload', () => {
      if (content.getAttribute('contenteditable') === 'true') {
        // Nur Unlock senden – kein Text-Broadcast nötig
        sendRT({ t: 'note_unlock', id: notiz.id });
      }
    });
    
  }

  function enhanceDraggableNote(note){
    if (!note) return;
    note.removeAttribute('draggable');
    note.removeEventListener('dragstart', note._dragStart);
    note.removeEventListener('dragend', note._dragEnd);

    let isDragging = false, hasMoved = false;
    let offsetX = 0, offsetY = 0;   // Offsets in UNSKALIERTEN px (style.left/top)
    let overTrash = false;          // <- NEU: Track, ob wir über dem Papierkorb sind
    let _rtTick = 0;

    note.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // nur Linksklick

      const blocked = (e.target && e.target.isContentEditable) || note.classList.contains('is-editing');
      if (blocked) L('PRE_DRAG_BLOCKED', {
        id: note.id,
        targetEditable: !!(e.target && e.target.isContentEditable),
        isEditingClass: note.classList.contains('is-editing'),
        locked: note.dataset.locked, lockedBy: note.dataset.lockedBy
      });
      if (blocked) return;

      L('PRE_DRAG_OK', { id: note.id, left: note.style.left, top: note.style.top });
      // nicht ziehen, wenn im Edit/Lock
      if ((e.target && e.target.isContentEditable) ||
        note.classList.contains('is-editing')) return;

      // Wichtig: KEIN preventDefault hier, damit dblclick funktioniert
      const startX = e.clientX;
      const startY = e.clientY;
      let started = false;

      function startDrag(ev){
        const s = parseFloat((document.querySelector('.board-area')?.dataset.scale) || '1') || 1;
        const parentRect = note.parentNode.getBoundingClientRect();
        const left0 = parseFloat(note.style.left) || 0;
        const top0  = parseFloat(note.style.top)  || 0;

        offsetX = ((ev.clientX - parentRect.left) / s) - left0;
        offsetY = ((ev.clientY - parentRect.top)  / s) - top0;

        note.style.zIndex = Math.max(getHighestInteractiveZIndex() + 1, 1200);
        hasMoved   = false;
        isDragging = true;
        started    = true;
        note.classList.add('being-dragged');

        // Auswahl unterdrücken
        document.body.classList.add('ccs-no-select');
        document.onselectstart = () => false;

        ev.preventDefault();
        document.removeEventListener('mousemove', preMove);
        document.removeEventListener('mouseup',   preUp);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
        document.body.style.cursor = 'grabbing';

        L('DRAG_START', { id: note.id, left0, top0, z: note.style.zIndex });
      }

      function preMove(ev){
        const dx = Math.abs(ev.clientX - startX);
        const dy = Math.abs(ev.clientY - startY);
        if (dx > 3 || dy > 3) startDrag(ev);
      }
      function preUp(){
        document.removeEventListener('mousemove', preMove);
        document.removeEventListener('mouseup',   preUp);
      }

      document.addEventListener('mousemove', preMove);
      document.addEventListener('mouseup',   preUp);
    });

    function onMove(e){
      if (!isDragging) return;
      e.preventDefault();

      const s = parseFloat((document.querySelector('.board-area')?.dataset.scale) || '1') || 1;

      // Falls Note schon entfernt wurde -> sauber aufräumen
      if (!document.body.contains(note)) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        return;
      }

      const parent = note.parentElement || getStage();
      if (!parent || !parent.getBoundingClientRect) return;
      const parentRect = parent.getBoundingClientRect();

      const curXu = (e.clientX - parentRect.left) / s;
      const curYu = (e.clientY - parentRect.top)  / s;

      const newX = Math.round(curXu - offsetX);
      const newY = Math.round(curYu - offsetY);

      note.style.position = 'absolute';
      note.style.left = newX + 'px';
      note.style.top  = newY + 'px';
      hasMoved = true;

      if (!hasMoved) L('FIRST_MOVE', { id: note.id }); // nur einmal

      // --- NEU: Trash-Hitbox prüfen & Feedback setzen ---
      const trash = document.querySelector('.trash-container');
      if (trash) {
        const tr = trash.getBoundingClientRect();
        const nr = note.getBoundingClientRect();
        const hit = (nr.right > tr.left && nr.left < tr.right && nr.bottom > tr.top && nr.top < tr.bottom);
        if (hit !== overTrash) {
          overTrash = hit;
          trash.classList.toggle('drag-over', hit);
          // Minimales optisches Feedback (falls kein CSS vorhanden)
          trash.style.transform = hit ? 'scale(1.1)' : '';
          trash.style.backgroundColor = hit ? '#ffcccc' : '';
        }
      } else {
        overTrash = false;
      }

      // ~30/s Note-Position als Normalform broadcasten
      const now = performance.now();
      if (now - _rtTick >= 33) {
        _rtTick = now;
        const stageRect = getStageRect(); // skaliert
        const pxStage = ((parentRect.left - stageRect.left) / s) + newX;
        const pyStage = ((parentRect.top  - stageRect.top ) / s) + newY;
        const { nx, ny } = toNorm(pxStage, pyStage);
         L('MOVE_SEND', { id: note.id, nx, ny });
        sendRT({ t:'note_move', id:note.id, nx, ny, prio:RT_PRI(), ts:Date.now() });
      }
    }

    function onUp(){
      // Auswahl wieder zulassen
      document.body.classList.remove('ccs-no-select');
      document.onselectstart = null;
      document.body.style.removeProperty('cursor');

      try { window.getSelection()?.removeAllRanges(); } catch {}
      if (!isDragging) return;
      isDragging = false;
      note.classList.remove('being-dragged');

      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);

      // Papierkorb-Feedback zurücksetzen
      const trash = document.querySelector('.trash-container');
      if (trash) {
        trash.classList.remove('drag-over');
        trash.style.transform = '';
        trash.style.backgroundColor = '';
      }

      // --- NEU: Wenn über dem Papierkorb -> löschen statt positionieren ---
      if (overTrash) {
        overTrash = false;

        // kleine „Wegwerf“-Animation
        note.style.transition = 'all 0.25s ease';
        note.style.transform = 'scale(0.1) rotate(5deg)';
        note.style.opacity = '0';

        setTimeout(() => {
          // Mouseup-Handler sicher beenden, falls noch aktiv
          try { document.dispatchEvent(new Event('mouseup')); } catch {}
          // DOM entfernen
          try { note.remove(); } catch {}
          // RT-Delete
          sendRT({ t:'note_delete', id: note.id, prio: RT_PRI(), ts: Date.now() });
          // Optional: lokales Array pflegen
          if (typeof notes !== 'undefined' && Array.isArray(notes)) {
            notes = notes.filter(n => (n && (n.id || n) !== note.id && n !== note));
          }
          // Zustand speichern (Owner)
          if (typeof saveCurrentBoardState === 'function') saveCurrentBoardState();
        }, 250);

        return; // KEIN finaler note_move mehr
      }

      // --- sonst: finalen Schnappschuss senden + speichern (wie bisher) ---
      const s = parseFloat((document.querySelector('.board-area')?.dataset.scale) || '1') || 1;
      if (!document.body.contains(note)) return;

      const parent = note.parentElement || getStage();
      if (!parent || !parent.getBoundingClientRect) return;

      const parentRect = parent.getBoundingClientRect();
      const stageRect  = getStageRect();
      const px = parseFloat(note.style.left) || 0;
      const py = parseFloat(note.style.top)  || 0;

      const pxStage = ((parentRect.left - stageRect.left) / s) + px;
      const pyStage = ((parentRect.top  - stageRect.top ) / s) + py;
      const { nx, ny } = toNorm(pxStage, pyStage);

      sendRT({ t:'note_move', id: note.id, nx, ny, prio: RT_PRI(), ts: Date.now() });
      if (typeof saveCurrentBoardState === 'function') saveCurrentBoardState();
      L('DRAG_END', { id: note.id, hasMoved, finalLeft: note.style.left, finalTop: note.style.top });

    }
  }

  /* === SAFETY NET: Delegierte Handler-Anbindung für Notizzettel =================
    Problem: Bei manchen Pfaden (z.B. remote erstellte Notes) hängen
    keine Mousedown-/Dblclick-Handler am Element → keine Interaktion möglich.
    Lösung: Delegierte Listener am Dokument, die beim ersten Kontakt die
    echten Handler an das Ziel-Element hängen. ================================= */

  (function attachDelegatedNoteHandlers(){
    // kleine Helper-Logfunktion (optional)
    function L(tag, data){ try { window.DEBUG && console.debug('[DELEGATE_'+tag+']', data||''); } catch {} }

    function ensureNoteHandlers(note){
      if (!note || note.__noteHandlersAttached) return;
      try { 
        // deine bestehenden Hooks nachrüsten
        if (typeof setupNoteEditingHandlers === 'function') setupNoteEditingHandlers(note);
        if (typeof enhanceDraggableNote     === 'function') enhanceDraggableNote(note);
        note.__noteHandlersAttached = true;
        L('ATTACH', { id: note.id });
      } catch(e){
        console.warn('Delegated attach failed for note', note?.id, e);
      }
    }

    // 1) Beim ersten Mousedown (Drag-Start) sicherstellen, dass Handler dran sind
    document.addEventListener('mousedown', function(e){
      const note = e.target && (e.target.closest?.('.notiz, .note'));
      if (!note) return;
      ensureNoteHandlers(note);
    }, true); // useCapture=true: früh dran, bevor etwas stopPropagation macht

    // 2) Gleiches für Doppelklick (Edit-Start)
    document.addEventListener('dblclick', function(e){
      const note = e.target && (e.target.closest?.('.notiz, .note'));
      if (!note) return;
      ensureNoteHandlers(note);
      // danach greift dein regulärer Dblclick-Handler
    }, true);

    // 3) Optional: bestehende Notes beim DOM-Ready einmalig nachrüsten
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('.notiz, .note').forEach(ensureNoteHandlers);
      });
    } else {
      document.querySelectorAll('.notiz, .note').forEach(ensureNoteHandlers);
    }
  })();


  const addTrashContainer = () => {
    console.log("Erstelle Mülleimer...");
    
    // Zuerst alle vorhandenen Mülleimer entfernen
    document.querySelectorAll('.trash-container').forEach(trash => {
      console.log("Entferne alten Mülleimer");
      trash.remove();
    });
    
    // Neuen Mülleimer erstellen
    const trashContainer = document.createElement('div');
    trashContainer.className = 'trash-container';
    trashContainer.style.zIndex = '9999';
    
    trashContainer.removeAttribute('title');
    
    // Alternative Löschmethode: Direktes Anklicken des Mülleimers
    trashContainer.addEventListener('click', function() {
      const deletionMode = this.classList.toggle('deletion-mode');
      
      if (deletionMode) {
        // Visuelles Feedback, dass der Löschmodus aktiv ist
        this.style.backgroundColor = '#ffcccc';
        this.style.transform = 'scale(1.2)';
        
       
        
        // Benachrichtigung anzeigen
       showTooltip("Klicke auf einen Notizzettel zum Löschen", this);
        
        // Klick-Handler für alle Notizzettel
        document.querySelectorAll('.notiz').forEach(notiz => {
          notiz.classList.add('deletable');
          notiz.addEventListener('click', deleteNoteOnClick);
        });
      } else {
        // Löschmodus beenden
        this.style.backgroundColor = '';
        this.style.transform = '';
        
        // Benachrichtigung entfernen
       hideTooltip();
        
        // Klick-Handler entfernen
        document.querySelectorAll('.notiz').forEach(notiz => {
          notiz.classList.remove('deletable');
          notiz.removeEventListener('click', deleteNoteOnClick);
        });
      }
    });
    
    // Hilfsfunktion zum Löschen eines Notizzettels per Klick
    function deleteNoteOnClick(e) {
      e.preventDefault();
      e.stopPropagation();
      
      const notiz = this;
      console.log("Lösche Notiz per Klick:", notiz.id);
      
      // Animation zum Verschwinden
      notiz.style.transition = 'all 0.3s ease';
      notiz.style.transform = 'scale(0.1) rotate(5deg)';
      notiz.style.opacity = '0';
      
      // Nach Animation entfernen
      setTimeout(() => {
        try {
          document.dispatchEvent(new Event('mouseup')); // beendet Drag-Handler, falls aktiv
        } catch {}
        notiz.remove();
        
        // Array aktualisieren
        if (typeof notes !== 'undefined' && Array.isArray(notes)) {
          notes = notes.filter(note => {
            if (note instanceof Element) {
              return note.id !== notiz.id;
            } else if (note && note.id) {
              return note.id !== notiz.id;
            }
            return true;
          });
        }
        sendRT({ t: 'note_delete', id: notiz.id, prio: RT_PRI(), ts: Date.now() });
        console.log("Notiz erfolgreich gelöscht!");
        
        // Aktuellen Board-Zustand speichern
        if (typeof saveCurrentBoardState === 'function') {
          saveCurrentBoardState();
        }
      }, 300);
      
      // Feedback-Effekt für Mülleimer
      const trash = document.querySelector('.trash-container');
      if (trash) {
        trash.classList.add('note-deleted');
        setTimeout(() => {
          trash.classList.remove('note-deleted');
        }, 500);
      }
    }
    
    // Hilfsfunktion zum Anzeigen einer Tooltip-Nachricht
    function showTooltip(message, anchorEl) {
      let tooltip = document.getElementById('trash-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'trash-tooltip';
        tooltip.className = 'trash-tooltip';
        document.body.appendChild(tooltip);
      }
      tooltip.textContent = message;
      tooltip.style.display = 'block';

      // Anker bestimmen (Default: Papierkorb)
      const anchor = anchorEl || document.querySelector('.trash-container');
      if (!anchor) return;

      // Nach dem Einblenden messen und positionieren
      requestAnimationFrame(() => {
        const a = anchor.getBoundingClientRect();
        const t = tooltip.getBoundingClientRect();
        const margin = 12;

        // Standardposition: zentriert ÜBER dem Papierkorb
        let left = a.left + (a.width - t.width) / 2;
        let top  = a.top - t.height - margin;

        // Clamping: nie aus dem Viewport ragen
        left = Math.max(8, Math.min(left, window.innerWidth  - t.width  - 8));
        top  = Math.max(8, Math.min(top,  window.innerHeight - t.height - 8));

        tooltip.style.left = left + 'px';
        tooltip.style.top  = top  + 'px';
      });

      // Auto-Hide nach 3s (Timer zurücksetzen)
      clearTimeout(window._trashTooltipTimer);
      window._trashTooltipTimer = setTimeout(hideTooltip, 3000);
    }

    function hideTooltip() {
      const tooltip = document.getElementById('trash-tooltip');
      if (tooltip) tooltip.style.display = 'none';
    }

    
    // *** VERBESSERTE DRAG & DROP FUNKTIONALITÄT ***
    
    // WICHTIG: Präventiv alle drop/dragover/dragleave-Event-Listener entfernen
    trashContainer.removeEventListener('dragover', dragOverHandler);
    trashContainer.removeEventListener('dragleave', dragLeaveHandler);
    trashContainer.removeEventListener('drop', dropHandler);
    
    // Neue Event-Handler-Funktionen definieren
    function dragOverHandler(e) {
      // ABSOLUT NOTWENDIG: Verhindert Standard-Browser-Verhalten
      e.preventDefault();
      e.stopPropagation();
      
      // Visuelles Feedback - "Große" Animation für bessere UX
      this.classList.add('drag-over');
      this.style.transform = 'scale(1.2)';
      this.style.backgroundColor = '#ffcccc';
    }
    
    function dragLeaveHandler(e) {
      e.preventDefault();
      e.stopPropagation();
      
      // Visuelles Feedback entfernen
      this.classList.remove('drag-over');
      this.style.transform = '';
      this.style.backgroundColor = '';
    }
    
    function dropHandler(e) {
      // WICHTIG: Verhindert Standard-Browser-Verhalten
      e.preventDefault();
      e.stopPropagation();
      
      // Visuelles Feedback entfernen
      this.classList.remove('drag-over');
      this.style.transform = '';
      this.style.backgroundColor = '';
      
      console.log("Drop auf Mülleimer erkannt");
      
      try {
        // Sicherstellen, dass dataTransfer existiert
        if (!e.dataTransfer) {
          console.error("Kein dataTransfer im Event");
          return;
        }
        
        // Daten extrahieren
        const noteId = e.dataTransfer.getData('text/plain');
        console.log("Extrahierte Notiz-ID:", noteId);
        
        if (!noteId) {
          console.error("Keine ID in dataTransfer gefunden");
          return;
        }
        
        // Element finden
        const noteElement = document.getElementById(noteId);
        if (!noteElement) {
          console.error("Element nicht gefunden:", noteId);
          return;
        }
        
        // Prüfen, ob es eine Notiz ist
        if (!noteElement.classList.contains('notiz')) {
          console.log("Element ist keine Notiz, prüfe ob es eine Karte ist...");
          
          // Falls es eine Karte ist, spezielle Behandlung
          if (noteElement.classList.contains('card')) {
            console.log("Karte kann nicht gelöscht werden, sie wird zum Stapel zurückgelegt");
            // Hier könnte man die Karte zurück zum Stapel legen, falls erwünscht
            returnCardToStack(noteElement);
            return;
          }
          
          console.error("Element ist weder Notiz noch Karte:", noteId);
          return;
        }
        
        console.log("Lösche Notizzettel durch Drop:", noteId);
        
        // Notiz löschen mit Animation
        noteElement.style.transition = 'all 0.3s ease';
        noteElement.style.transform = 'scale(0.1) rotate(5deg)';
        noteElement.style.opacity = '0';
        
        setTimeout(() => {
          try {
            document.dispatchEvent(new Event('mouseup')); // beendet Drag-Handler, falls aktiv
          } catch {}
          noteElement.remove();
          sendRT({
            t: 'note_delete',
            id: noteId,
            prio: RT_PRI(),
            ts: Date.now()
          });
          
          // Array aktualisieren
          if (typeof notes !== 'undefined' && Array.isArray(notes)) {
            notes = notes.filter(note => {
              if (note instanceof Element) {
                return note.id !== noteId;
              } else if (note && note.id) {
                return note.id !== noteId;
              }
              return true;
            });
          }
          
          console.log("Notiz erfolgreich gelöscht!");
          
          // Aktuellen Board-Zustand speichern
          if (typeof saveCurrentBoardState === 'function') {
            saveCurrentBoardState();
          }
        }, 300);
        
        // Feedback-Effekt
        this.classList.add('note-deleted');
        setTimeout(() => {
          this.classList.remove('note-deleted');
        }, 500);
      } catch (error) {
        console.error("Fehler beim Drop-Handling:", error);
      }

    }
    
    // Event-Listener für die verbesserte Drag & Drop-Funktionalität hinzufügen
    trashContainer.addEventListener('dragover', dragOverHandler);
    trashContainer.addEventListener('dragleave', dragLeaveHandler);
    trashContainer.addEventListener('drop', dropHandler);
    
    // Zum DOM hinzufügen
    document.body.appendChild(trashContainer);
    console.log("Mülleimer erfolgreich erstellt mit verbesserter Drop-Funktionalität");
    
    // CSS für Tooltip und verbesserte Drag-and-Drop hinzufügen
    if (!document.getElementById('trash-tooltip-style')) {
      const style = document.createElement('style');
      style.id = 'trash-tooltip-style';
      style.textContent = `
        .trash-tooltip {
          position: fixed;
          top: 0;
          left: 0;
          transform: none;
          background-color: rgba(0, 0, 0, 0.8);
          color: white;
          padding: 10px 20px;
          border-radius: 5px;
          z-index: 10000;
          font-size: 16px;
          display: none;
          max-width: calc(100vw - 24px);
          white-space: normal;
          word-break: break-word;
        }
        
        .notiz.deletable {
          cursor: pointer;
          box-shadow: 0 0 8px rgba(255, 0, 0, 0.5);
        }
        
        .notiz.deletable:hover {
          transform: scale(1.05);
          box-shadow: 0 0 12px rgba(255, 0, 0, 0.8);
        }
        
        /* Verbesserte Styles für Drag & Drop */
        .trash-container.drag-over {
          animation: pulse 0.5s infinite alternate;
        }
        
        @keyframes pulse {
          0% { transform: scale(1.1); }
          100% { transform: scale(1.3); }
        }
        
        /* Verbesserte Animation für das Löschen */
        .notiz.being-dragged {
          opacity: 0.8 !important;
          transform: scale(0.9) !important;
          box-shadow: 0 10px 20px rgba(0, 0, 0, 0.2);
          pointer-events: none;
          z-index: 1000000 !important;
        }
      `;
      document.head.appendChild(style);
    }
    
    return trashContainer;
  };

  // Karte umdrehen
  const flipCard = (card) => {
    if (!card) return;
    
    card.classList.toggle('flipped');
    sendRT({
      t: 'card_flip',
      id: card.id,
      flipped: card.classList.contains('flipped'),
      prio: RT_PRI(),
      ts: Date.now()
    });
    
    // Sound abspielen
    if (cardFlipSound) {
      cardFlipSound.currentTime = 0;
      cardFlipSound.play().catch(e => console.log('Audio konnte nicht abgespielt werden:', e));
    }
    
    // Karte nach vorne bringen (normalisiert, aber unter Notizen im Drag/Edit)
    if (!card.closest('#card-stack')) {
      normalizeCardZIndex(card);
    }
    // Speichern des Board-Zustands nach dem Umdrehen einer Karte
    saveCurrentBoardState();
  };

  // Karten mischen - überarbeitete Version, die nur Karten auf dem Stapel mischt

  // Globale Shuffle-Funktion (oberste Karte = letztes Kind)
  window.shuffleCards = function(order) {
    const cardStack = document.getElementById('card-stack');
    if (!cardStack) return;

    // aktuelle Karten im Stapel
    const stackCards = Array.from(cardStack.querySelectorAll(':scope > .card'));
    if (!stackCards.length) return;

    // Ziel-Reihenfolge bestimmen
    let newOrderEls;
    if (Array.isArray(order) && order.length) {
      const map = new Map(stackCards.map(el => [el.id, el]));
      newOrderEls = order.map(id => map.get(id)).filter(Boolean);
      // fehlende (z.B. neue Karten) unten anhängen
      stackCards.forEach(el => { if (!newOrderEls.includes(el)) newOrderEls.push(el); });
    } else {
      // lokal mischen (wenn keine Reihenfolge übergeben wurde)
      newOrderEls = stackCards.slice();
      for (let i = newOrderEls.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newOrderEls[i], newOrderEls[j]] = [newOrderEls[j], newOrderEls[i]];
      }
    }

    // kurze Animation + sicherstellen, dass Karten zu sind
    newOrderEls.forEach(el => {
      el.classList.add('shuffling');
      setTimeout(() => el.classList.remove('shuffling'), 500);
      el.classList.remove('flipped');
    });

    // Sound (lokal abspielen)
    const snd = document.getElementById('shuffle-sound');
    if (snd) { try { snd.currentTime = 0; snd.play(); } catch(_) {} }

    // DOM in neuer Reihenfolge aufbauen + Z-Index/Offset setzen
    newOrderEls.forEach((el, idx) => {
      cardStack.appendChild(el);                 // unten → oben
      const offset = idx * 0.5;
      el.style.position = 'absolute';
      el.style.left = offset + 'px';
      el.style.top  = offset + 'px';
      el.style.zIndex = String(idx + 1);
    });

    if (typeof saveCurrentBoardState === 'function') saveCurrentBoardState();
  };



  // Event-Listener für Buttons und Aktionen einrichten
  const setupEventListeners = () => {
    // Karten mischen
    if (shuffleCardsBtn) {
      shuffleCardsBtn.addEventListener('click', shuffleCards);
    }
    
    // Neue Notiz erstellen
    if (newNoteBtn) {
      newNoteBtn.addEventListener('click', () => {
        // Zufällige Position im sichtbaren Bereich
        const left = Math.floor(Math.random() * (window.innerWidth - 200)) + 50;
        const top = Math.floor(Math.random() * (window.innerHeight - 200)) + 50;
        createNote(left, top);
      });
    }
    
    // Sitzung schließen
    const endSessionBtn = document.querySelector('.end-session-btn');
    if (endSessionBtn) {
      endSessionBtn.addEventListener('click', () => {
        createEndSessionDialog();
      });
    }
    
    // Karten filtern
    if (cardFilter) {
      cardFilter.addEventListener('change', () => {
        const filterValue = cardFilter.value;
        
        if (filterValue === 'none') {
          // Alle Elemente anzeigen
          document.querySelectorAll('.note, .card').forEach(elem => {
            elem.style.display = 'block';
          });
        } else {
          // Nur Elemente mit dem entsprechenden Typ anzeigen
          document.querySelectorAll('.note, .card').forEach(elem => {
            if (elem.classList.contains('focus-note') && filterValue === 'Focus') {
              elem.style.display = 'block';
            } else if (elem.classList.contains('card') && filterValue === 'Problem') {
              elem.style.display = 'block';
            } else if (elem.classList.contains('note') && !elem.classList.contains('focus-note') && filterValue === 'Note') {
              elem.style.display = 'block';
            } else {
              elem.style.display = 'none';
            }
          });
        }
      });
    }
    
    // Kontextmenü für rechte Maustaste
    document.addEventListener('contextmenu', (e) => {
      const target = e.target.closest('.card, .note');
      if (target) {
        e.preventDefault();
        showContextMenu(e, target);
      }
    });
    
    // Klick auf den Board-Bereich (zum Schließen von Kontextmenüs)
    document.addEventListener('click', () => {
      const contextMenu = document.querySelector('.context-menu');
      if (contextMenu) {
        contextMenu.remove();
      }
    });
    
    // WICHTIG: Tastaturkürzel aktivieren
    setupKeyboardShortcuts();
  };


  // Kontextmenü für Karten anzeigen
  const showCardContextMenu = (event, card) => {
    // Vorhandenes Kontextmenü entfernen
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
      existingMenu.remove();
    }
    
    // Neues Kontextmenü erstellen
    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.style.left = `${event.clientX}px`;
    contextMenu.style.top  = `${event.clientY}px`;
    // <<< NEU: sichtbar über allem
    contextMenu.style.zIndex = '2147483600';
    // (optional) Basestyles, falls deine CSS fehlt
    contextMenu.style.position = 'fixed';
    contextMenu.style.background = '#fff';
    contextMenu.style.border = '1px solid #ddd';
    contextMenu.style.borderRadius = '8px';
    contextMenu.style.boxShadow = '0 8px 24px rgba(0,0,0,.15)';
    contextMenu.style.overflow = 'hidden';

    contextMenu.innerHTML = `
      <ul style="list-style:none;margin:0;padding:6px 0">
        <li class="flip-card"     style="padding:8px 14px;cursor:pointer">Karte umdrehen (F)</li>
        <li class="reset-card"    style="padding:8px 14px;cursor:pointer">Zurück zum Stapel (B)</li>
        <li class="shuffle-cards" style="padding:8px 14px;cursor:pointer">Karten mischen (M)</li>
      </ul>
    `;
    document.body.appendChild(contextMenu);

    contextMenu.querySelector('.flip-card').addEventListener('click', () => {
      flipCard(card); // flipCard broadcastet selbst
      contextMenu.remove();
    });

    contextMenu.querySelector('.reset-card').addEventListener('click', () => {
      returnCardToStack(card);
      // <<< NEU: Broadcast
      sendRT({ t: 'card_sendback', id: card.id, prio: RT_PRI(), ts: Date.now() });
      contextMenu.remove();
    });

    contextMenu.querySelector('.shuffle-cards').addEventListener('click', () => {
      // IDs der Karten im Stapel ermitteln
      const ids = Array
        .from(document.querySelectorAll('#card-stack > .card'))
        .map(c => c.id);

      // lokal anwenden (Animation+Sound)
      window.shuffleCards(ids);

      // an alle senden (mit deterministischer Reihenfolge)
      sendRT({ t: 'deck_shuffle', order: ids, prio: RT_PRI(), ts: Date.now() });

      contextMenu.remove();
    });
    
    // Kontextmenü im Fenster halten
    const menuRect = contextMenu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
      contextMenu.style.left = `${window.innerWidth - menuRect.width}px`;
    }
    if (menuRect.bottom > window.innerHeight) {
      contextMenu.style.top = `${window.innerHeight - menuRect.height}px`;
    }
  };
  
  // Kontextmenü anzeigen
  const showContextMenu = (event, target) => {
    // Vorhandenes Kontextmenü entfernen
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
      existingMenu.remove();
    }
    
    // Wenn das Ziel eine Karte ist, verwenden wir die spezielle Funktion
    if (target.classList.contains('card')) {
      showCardContextMenu(event, target);
      return;
    }
    
    // Neues Kontextmenü erstellen
    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.style.left = `${event.clientX}px`;
    contextMenu.style.top = `${event.clientY}px`;
    
    let menuItems = '';
    
    if (target.classList.contains('note')) {
      // Menü für Notizen
      const colors = [
        { name: 'Gelb', value: '#FFFF99' },
        { name: 'Rot', value: '#FF9999' },
        { name: 'Grün', value: '#99FF99' },
        { name: 'Blau', value: '#9999FF' },
        { name: 'Orange', value: '#FFCC99' }
      ];
      
      let colorItems = '';
      colors.forEach(color => {
        colorItems += `<li class="change-color" data-color="${color.value}">${color.name}</li>`;
      });
      
      menuItems = `
        <ul>
          <li class="delete-note">Notiz löschen</li>
          <li class="color-submenu">
            Farbe ändern
            <ul class="color-options">
              ${colorItems}
            </ul>
          </li>
        </ul>
      `;
      
      contextMenu.innerHTML = menuItems;
      document.body.appendChild(contextMenu);
      
      contextMenu.querySelector('.delete-note').addEventListener('click', () => {
        const id = target.id;
        target.remove();
        notes = notes.filter(n => n !== target);
        sendRT({ t: 'note_delete', id, prio: RT_PRI(), ts: Date.now() });
        contextMenu.remove();
      });
      
      contextMenu.querySelectorAll('.change-color').forEach(item => {
        item.addEventListener('click', () => {
          const color = item.dataset.color;
          target.style.backgroundColor = color;
          contextMenu.remove();
        });
      });
    }
    
    // Kontextmenü im Fenster halten
    const menuRect = contextMenu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
      contextMenu.style.left = `${window.innerWidth - menuRect.width}px`;
    }
    if (menuRect.bottom > window.innerHeight) {
      contextMenu.style.top = `${window.innerHeight - menuRect.height}px`;
    }
  };
 
  // Element draggable machen - angepasst für Karten
  function makeDraggable(element) {
    if (element.id === 'notes-container' || element.classList.contains('notes-container')) {
      return; // Notizblock bleibt fixiert
    }
    if (element.__dragHandlersAttached) return;
    element.__dragHandlersAttached = true;
    console.log("Mache Element draggable:", element.id || "Unbekanntes Element");
    
    // Für Notizen die bestehende Logik verwenden
    if (element.classList.contains('notiz')) {
      enhanceDraggableNote(element);
      return;
    }

    let _rtRaf = null;
    let _rtPending = false;

    
    // Für Karten, benutzerdefiniertes Drag-and-Drop implementieren
    // ---- Karten: benutzerdefiniertes Dragging mit Scale-Korrektur ----
    if (element.classList.contains('card')) {
      element.removeAttribute('draggable');

      let isDragging = false;
      let offsetX = 0, offsetY = 0;     // Offsets in UNSKALIERTEN px (style.left/top)
      let initialParent = null;
      let isHoveringOverStack = false;

      let _rtRaf = null, _rtPending = false;
      // NEU: simple Throttle + Delta-Gate
      let _lastSend = 0, _lastPx = 0, _lastPy = 0;

      const queueRTCardMove = () => {
        const now = performance.now();
        if (now - _lastSend < 33) return; // ~30/s

        const pxLocal = parseFloat(element.style.left) || 0;
        const pyLocal = parseFloat(element.style.top)  || 0;

        const boardArea = document.querySelector('.board-area');
        const s = parseFloat(boardArea?.dataset.scale || '1') || 1;
        const stageRect  = boardArea.getBoundingClientRect();
        const parentRect = (element.parentElement || boardArea).getBoundingClientRect();

        // Parent→Stage-Offset addieren -> Stage-Pixel normalisieren
        const pxStage = ((parentRect.left - stageRect.left) / s) + pxLocal;
        const pyStage = ((parentRect.top  - stageRect.top ) / s) + pyLocal;

        _lastSend = now; _lastPx = pxLocal; _lastPy = pyLocal;

        if (_rtRaf) cancelAnimationFrame(_rtRaf);
        _rtRaf = requestAnimationFrame(() => {
          _rtRaf = null;
          const { nx, ny } = toNormCard(pxStage, pyStage);
          shouldApply(`move:${element.id}`, RT_PRI(), performance.now(), RT.uid);
          sendRT({ t:'card_move', id: element.id, nx, ny, z: element.style.zIndex || '', prio: RT_PRI(), ts: Date.now() });

        });
      };

      element.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        // Neue Drag-Session startet: alten Autosave abbrechen und Snapshots kurz pausieren
        try { clearTimeout(_saveTimer); } catch {}
        window.__pauseSnapshotUntil = Date.now() + 800; // ~0.8s Puffer gegen Race

        const s = parseFloat((document.querySelector('.board-area')?.dataset.scale) || '1') || 1;
        initialParent = element.parentNode;

        // Offsets unskaliert erfassen
        const parent = element.parentElement || getStage();
        if (!parent || !parent.getBoundingClientRect) return;
        const parentRect = parent.getBoundingClientRect();

        const left0 = parseFloat(element.style.left) || 0;
        const top0  = parseFloat(element.style.top)  || 0;
        offsetX = ( (e.clientX - parentRect.left) / s ) - left0;
        offsetY = ( (e.clientY - parentRect.top)  / s ) - top0;

        element.style.zIndex = Math.max(getHighestInteractiveZIndex() + 1, 1200);

        // Falls noch im Stapel → sofort ins Board umhängen und Position erhalten
        const cardStack = document.getElementById('card-stack');
        const boardArea = document.querySelector('.board-area');
        if (initialParent === cardStack && boardArea) {
          const rect = element.getBoundingClientRect();
          const boardRect = boardArea.getBoundingClientRect();

          // Startposition relativ zur Board-Area (mit Scale) setzen
          element.style.position = 'absolute';
          element.style.left = ((rect.left - boardRect.left) / s) + 'px';
          element.style.top  = ((rect.top  - boardRect.top ) / s) + 'px';
          try { cardStack.removeChild(element); } catch {}
          boardArea.appendChild(element);

          // Einmalig RT "card_move" direkt nach dem Umhängen
          const pxStage = (rect.left - boardRect.left) / s;
          const pyStage = (rect.top  - boardRect.top ) / s;
          const { nx, ny } = toNormCard(pxStage, pyStage);
          shouldApply(`move:${element.id}`, RT_PRI(), performance.now(), RT.uid);
          sendRT({ t:'card_move', id: element.id, nx, ny, z: element.style.zIndex || '', prio: RT_PRI(), ts: Date.now() });
        }

        element.classList.add('being-dragged');
        isDragging = true;

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });

      function onMouseMove(e){
        if (!isDragging) return;
        e.preventDefault();

        const s = parseFloat((document.querySelector('.board-area')?.dataset.scale) || '1') || 1;
        const parent = element.parentElement || getStage();
        if (!parent || !parent.getBoundingClientRect) return;
        const parentRect = parent.getBoundingClientRect();


        // Cursor relativ zur Bühne → UNSKALIERT
        const curXu = (e.clientX - parentRect.left) / s;
        const curYu = (e.clientY - parentRect.top)  / s;

        element.style.position = 'absolute';
        element.style.left = (curXu - offsetX) + 'px';
        element.style.top  = (curYu - offsetY) + 'px';

        queueRTCardMove();

        // Hover über Stapel (nur für visuelles Feedback)
        const cardStack = document.getElementById('card-stack');
        if (cardStack) {
          const cardRect  = element.getBoundingClientRect();
          const stackRect = cardStack.getBoundingClientRect();
          const isOver = (cardRect.right > stackRect.left &&
                          cardRect.left  < stackRect.right &&
                          cardRect.bottom> stackRect.top  &&
                          cardRect.top   < stackRect.bottom);
          if (isOver && !isHoveringOverStack) {
            isHoveringOverStack = true;
            cardStack.classList.add('stack-hover');
          } else if (!isOver && isHoveringOverStack) {
            isHoveringOverStack = false;
            cardStack.classList.remove('stack-hover');
          }
        }
      }

      function onMouseUp(){
        if (!isDragging) return;
        isDragging = false;
        element.classList.remove('being-dragged');

        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // NEU: Drop über Stapel? -> zurück zum Stapel + RT-Broadcast
        const cardStack = document.getElementById('card-stack');
        if (cardStack) {
          const cardRect  = element.getBoundingClientRect();
          const stackRect = cardStack.getBoundingClientRect();
          const isOver =
            cardRect.right  > stackRect.left  &&
            cardRect.left   < stackRect.right &&
            cardRect.bottom > stackRect.top   &&
            cardRect.top    < stackRect.bottom;

          if (isOver) {
            // visuelles Hover-Feedback zurücksetzen
            cardStack.classList.remove('stack-hover');

            // lokal zurücklegen (Animation/Flip/Einordnen)
            returnCardToStack(element);

            // Echo-Gate setzen + an alle senden (Clients rufen dann ebenfalls returnCardToStack auf)
            shouldApply(`sendback:${element.id}`, RT_PRI());
            sendRT({ t: 'card_sendback', id: element.id, prio: RT_PRI(), ts: Date.now() });

            // Zustand sichern und KEIN card_move mehr senden
            if (typeof saveCurrentBoardState === 'function') saveCurrentBoardState();
            return;
          }
        }

        // bestehend: finaler RT-Schnappschuss (nur wenn NICHT über Stapel gedroppt)
        if (_rtRaf) { cancelAnimationFrame(_rtRaf); _rtRaf = null; }
        _rtPending = false;
        const pxLocal = parseFloat(element.style.left) || 0;
        const pyLocal = parseFloat(element.style.top)  || 0;

        const boardArea = document.querySelector('.board-area');
        const s = parseFloat(boardArea?.dataset.scale || '1') || 1;
        const stageRect  = boardArea.getBoundingClientRect();
        const parentRect = (element.parentElement || boardArea).getBoundingClientRect();

        const pxStage = ((parentRect.left - stageRect.left) / s) + pxLocal;
        const pyStage = ((parentRect.top  - stageRect.top ) / s) + pyLocal;

        const { nx, ny } = toNormCard(pxStage, pyStage);
        shouldApply(`move:${element.id}`, RT_PRI(), performance.now(), RT.uid);
        sendRT({ t:'card_move', id: element.id, nx, ny, z: element.style.zIndex || '', prio: RT_PRI(), ts: Date.now() });


        if (!element.closest('#card-stack')) normalizeCardZIndex(element);
        if (typeof saveCurrentBoardState === 'function') saveCurrentBoardState();
      }

      return; // <- WICHTIG: für Karten NICHT die generische Drag-Logik darunter ausführen
    }

    
    // Bestehende Logik für andere Elemente beibehalten
    let startX, startY;
    let initialLeft, initialTop;

    element.onmousedown = function(e){
      if (e.button !== 0) return;
      if (e.target.isContentEditable) return;
      const trashCan = document.querySelector('.trash-container');
      if (trashCan && trashCan.classList.contains('deletion-mode')) return;

      e.preventDefault();
      element.style.zIndex = getHighestInteractiveZIndex() + 1;

      startX = e.clientX;
      startY = e.clientY;
      initialLeft = parseFloat(element.style.left) || 0;
      initialTop  = parseFloat(element.style.top)  || 0;

      document.addEventListener('mousemove', elementDrag);
      document.addEventListener('mouseup', closeDragElement);
    };

    function elementDrag(e){
      e.preventDefault();
      const s = parseFloat((document.querySelector('.board-area')?.dataset.scale) || '1') || 1;
      const dx = (e.clientX - startX) / s;
      const dy = (e.clientY - startY) / s;

      element.style.left = (initialLeft + dx) + 'px';
      element.style.top  = (initialTop  + dy) + 'px';

      queueRTCardMove();
    }
    
    function closeDragElement() {
      // Event-Handler entfernen
      // RT: card_move bei generischem Drag-Ende
      {
        if (_rtRaf) { cancelAnimationFrame(_rtRaf); _rtRaf = null; }
        _rtPending = false;

        const pxLocal = parseFloat(element.style.left) || 0;
        const pyLocal = parseFloat(element.style.top)  || 0;

        const boardArea = document.querySelector('.board-area');
        const s = parseFloat(boardArea?.dataset.scale || '1') || 1;
        const stageRect  = boardArea.getBoundingClientRect();
        const parentRect = (element.parentElement || boardArea).getBoundingClientRect();

        const pxStage = ((parentRect.left - stageRect.left) / s) + pxLocal;
        const pyStage = ((parentRect.top  - stageRect.top ) / s) + pyLocal;

        const { nx, ny } = toNormCard(pxStage, pyStage);
        shouldApply(`move:${element.id}`, RT_PRI(), performance.now(), RT.uid);
        sendRT({ t:'card_move', id: element.id, nx, ny, z: element.style.zIndex || '', prio: RT_PRI(), ts: Date.now() });}
      document.removeEventListener('mousemove', elementDrag);
      document.removeEventListener('mouseup', closeDragElement);
    }


  }

  // Hilfsfunktionen für den Stack-Hover-Tooltip
  function showStackHoverTooltip(message) {
    let tooltip = document.getElementById('stack-hover-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'stack-hover-tooltip';
      tooltip.className = 'stack-hover-tooltip';
      document.body.appendChild(tooltip);
      
      // Stil für den Tooltip hinzufügen, falls nicht vorhanden
      if (!document.getElementById('stack-hover-tooltip-style')) {
        const style = document.createElement('style');
        style.id = 'stack-hover-tooltip-style';
        style.textContent = `
          .stack-hover-tooltip {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background-color: rgba(0, 0, 0, 0.7);
            color: white;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 14px;
            z-index: 10000;
            pointer-events: none;
            animation: fadeIn 0.2s ease-in-out;
          }
          
          @keyframes fadeIn {
            from { opacity: 0; transform: translate(-50%, -10px); }
            to { opacity: 1; transform: translate(-50%, 0); }
          }
        `;
        document.head.appendChild(style);
      }
    }
    
    tooltip.textContent = message;
    tooltip.style.display = 'block';
  }

  function hideStackHoverTooltip() {
    const tooltip = document.getElementById('stack-hover-tooltip');
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  }

  // Diese Funktion erstellt einen benutzerfreundlichen Dialog zum Beenden der Sitzung
  function createEndSessionDialog() {
    // Vorhandenen Dialog entfernen, falls einer existiert
    const existingDialog = document.getElementById('end-session-dialog');
    if (existingDialog) {
      existingDialog.remove();
    }
    
    // Dialog-Container erstellen
    const dialogContainer = document.createElement('div');
    dialogContainer.id = 'end-session-dialog';
    dialogContainer.className = 'custom-dialog';
    
    // Dialog-Inhalt erstellen
    dialogContainer.innerHTML = `
      <div class="dialog-content">
        <div class="dialog-header">
          <h3>Sitzung beenden</h3>
        </div>
        <div class="dialog-body">
          <p>Sind Sie sicher, dass Sie die Sitzung beenden möchten?</p>
        </div>
        <div class="dialog-footer">
          <button id="dialog-cancel" class="dialog-button cancel-button">Abbrechen</button>
          <button id="dialog-confirm" class="dialog-button confirm-button">Sitzung beenden</button>
        </div>
      </div>
    `;
    
    // Dialog zum DOM hinzufügen
    document.body.appendChild(dialogContainer);
    
    // Dialog zeigen - mit Fade-in Animation
    setTimeout(() => {
      dialogContainer.classList.add('visible');
    }, 10);
    
    // Event-Listener für Buttons
    const cancelButton = document.getElementById('dialog-cancel');
    const confirmButton = document.getElementById('dialog-confirm');
    
    // Schließen-Funktion für den Dialog
    const closeDialog = () => {
      dialogContainer.classList.remove('visible');
      setTimeout(() => {
        dialogContainer.remove();
      }, 300); // Zeit für Fade-out Animation
    };
    
    // Abbrechen-Button
    cancelButton.addEventListener('click', closeDialog);
    
    // Sitzung-beenden-Button
    confirmButton.addEventListener('click', () => {
      closeDialog();

      // (optional) Zustand persistieren – nicht blockierend
      try {
        window.onOwnerEndSessionConfirmed && window.onOwnerEndSessionConfirmed();
      } catch {}

      // Wichtig: dem *Wrapper-Tab* sagen, dass er sich selbst schließen soll
      try {
        const sid = new URLSearchParams(location.search).get('id');
        if (window.top && window.top !== window) {
          window.top.postMessage({ type: 'END_SESSION', sessionId: sid }, '*');
        } else {
          window.postMessage({ type: 'END_SESSION', sessionId: sid }, '*');
        }
      } catch {}

      // KEINE eigene Navigation hier! Schließen übernimmt der Wrapper (server.js).
    });

  }

  // Funktion, um den "Sitzung beenden" Button zu aktualisieren
  function setupEndSessionButton() {
    const btn = document.getElementById('close-session-btn') || document.querySelector('.end-session-btn');
    if (!btn) return;
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', createEndSessionDialog);
  }

  // Funktionen zum Speichern und Laden des Board-Zustands
  // Holt den aktuellen Zustand des Boards
  function captureBoardState() {
    // Board-State-Objekt erstellen
    const boardState = {
      focusNote: captureFocusNote(),
      notes: captureAllNotes(),
      cards: captureAllCards(),
      timestamp: new Date().toISOString()
    };
    
    console.log("Erfasster Board-Zustand:", boardState);
    return boardState;
  }
  window.captureBoardState = captureBoardState;

  // Erfasst den Inhalt der Focus Note
  function captureFocusNote() {
    const focusNoteDisplay = document.getElementById('focus-note-display');
    if (!focusNoteDisplay) return "";
    
    const content = focusNoteDisplay.textContent;
    return content === 'Schreiben sie hier die Focus Note der Sitzung rein' ? "" : content;
  }

  // Erfasst alle Notizzettel und ihre Eigenschaften
  function captureAllNotes() {
    const world     = getWorldSize();
    const stageRect = getStageRect(); // ← fehlte vorher
    const s = parseFloat(document.querySelector('.board-area')?.dataset.scale || '1') || 1;

    const out = [];
    document.querySelectorAll('.notiz').forEach(notiz => {
      const rect = notiz.getBoundingClientRect();

      // relativ zur Bühne ent-skaliert
      const leftStage = (rect.left - stageRect.left) / s;
      const topStage  = (rect.top  - stageRect.top ) / s;

      // normierte Koordinaten für robuste Replays
      const nx = world.width  ? (leftStage / world.width)  : 0;
      const ny = world.height ? (topStage  / world.height) : 0;

      out.push({
        id: notiz.id,
        nx, ny,
        left: Math.round(leftStage) + 'px',
        top:  Math.round(topStage)  + 'px',
        width:  notiz.style.width  || '',
        height: notiz.style.height || '',
        zIndex: notiz.style.zIndex || '',
        backgroundColor: notiz.style.backgroundColor || '',
        rotation: notiz.style.getPropertyValue('--rotation') || '',
        // Text statt innerHTML – sicher gegen Markup
        content: getNoteText(notiz)
      });
    });

    return out;
  }


  // Erfasst alle Karten und ihre Eigenschaften
  function captureAllCards(){
    const cardsArray = [];
    const cardElements = document.querySelectorAll('.card');

    cardElements.forEach(card => {
      const rawId  = card.id || '';
      const cardNum = (rawId.match(/card-?(\d+)/)?.[1]) || card.dataset.cardId || '';
      const px = parseFloat(card.style.left) || 0;
      const py = parseFloat(card.style.top)  || 0;
      const { nx, ny } = toNormCard(px, py);

      cardsArray.push({
        id: rawId,
        cardId: cardNum,
        nx, ny,                   // ← statt left/top
        zIndex: card.style.zIndex,
        isFlipped: card.classList.contains('flipped'),
        inStack: !!(card.parentElement && card.parentElement.id === 'card-stack'),
        placedAt: card.dataset.placedAt || null
      });
    });

    return cardsArray;
  }


  // Stellt den Board-Zustand wieder her (mit optionalem Überspringen von Notizen)
  function restoreBoardState(boardState, opts = {}) {
    if (!boardState) return false;

    // Focus Note aktualisieren
    try { restoreFocusNote(boardState.focusNote); } catch(e){ console.warn('restoreFocusNote:', e); }

    // Notizen NUR aktualisieren, wenn wir nicht lokal tippen (oder nicht angewiesen, sie zu überspringen)
    try { restoreNotes(boardState.notes, opts); } catch(e){ console.warn('restoreNotes:', e); }

    // NEU: nur wenn nicht explizit übersprungen
    if (!(opts && opts.skipCards)) {
      try { restoreCards(boardState.cards); } catch(e){}
    }

    return true;
  }
  window.restoreBoardState = restoreBoardState;


  // Stellt die Focus Note wieder her
  function restoreFocusNote(focusNoteContent) {
    if (!focusNoteContent) return;
    
    const focusNoteDisplay = document.getElementById('focus-note-display');
    const focusNoteEditable = document.getElementById('focus-note-editable');
    
    if (focusNoteDisplay) {
      focusNoteDisplay.textContent = focusNoteContent;
      focusNoteDisplay.classList.add('has-content');
    }
    
    if (focusNoteEditable) {
      focusNoteEditable.textContent = focusNoteContent;
    }
  }

  // Stellt alle Notizzettel wieder her – respektiert laufende lokale Bearbeitung
  function restoreNotes(notes, opts = {}) {
    if (!Array.isArray(notes) || !notes.length) return;
    if (opts && opts.skipNotes) return;

    const seen = new Set();
    const stage = document.getElementById('notes-container')
          || document.querySelector('.notes-container')
          || document.getElementById('session-board')
          || document.querySelector('.board-area')
          || document.body;

    const s = parseFloat(document.querySelector('.board-area')?.dataset.scale || '1') || 1;
    const stageRect = getStageRect();

    notes.forEach(noteData => {
      const { el } = ensureNoteEl(noteData.id); // erzeugt + hängt Handler an
      el.style.position = 'absolute';

      // Position aus nx/ny (bevorzugt) oder Fallback left/top übernehmen
      let leftPx, topPx;
      if (typeof noteData.nx === 'number' && typeof noteData.ny === 'number') {
        const p = fromNorm(noteData.nx, noteData.ny); // Bühnen-Pixel (unskaliert)
        const parentRect = (el.parentElement || stage).getBoundingClientRect();
        leftPx = Math.round(p.x - ((parentRect.left - stageRect.left) / s));
        topPx  = Math.round(p.y - ((parentRect.top  - stageRect.top ) / s));
      } else {
        leftPx = parseFloat(noteData.left) || 0;
        topPx  = parseFloat(noteData.top)  || 0;
      }

      el.style.left = leftPx + 'px';
      el.style.top  = topPx  + 'px';

      if (noteData.zIndex !== undefined && noteData.zIndex !== '') el.style.zIndex = String(noteData.zIndex);
      if (noteData.backgroundColor) el.style.backgroundColor = noteData.backgroundColor;
      if (noteData.rotation) el.style.setProperty('--rotation', noteData.rotation);
      if (noteData.width)  el.style.width  = noteData.width;
      if (noteData.height) el.style.height = noteData.height;

      setNoteText(el, noteData.content || '');
      if (el.parentNode !== stage) stage.appendChild(el);
      seen.add(noteData.id);
    });

    // Verwaiste Notizen entfernen (wenn sie nicht mehr im State sind)
    document.querySelectorAll('.notiz').forEach(el => {
      if (!seen.has(el.id)) el.remove();
    });
  }
  window.restoreNotes = restoreNotes;



  // Stellt alle Karten wieder her – ohne Animationen, mit nx/ny-Unterstützung
  function restoreCards(cardsState) {
    if (!Array.isArray(cardsState) || !cardsState.length) return;

    const cardStack = document.getElementById('card-stack');
    const stage     = document.getElementById('cards-container') || document.querySelector('.board-area') || document.body;
    const total     = document.querySelectorAll('.card').length;

    const withoutAnimations = (el, fn) => {
      const prevT = el.style.transition, prevA = el.style.animation;
      const front = el.querySelector('.card-front');
      const back  = el.querySelector('.card-back');
      const pFT = front ? front.style.transition : '';
      const pFA = front ? front.style.animation  : '';
      const pBT = back  ? back.style.transition  : '';
      const pBA = back  ? back.style.animation   : '';
      try {
        el.style.transition = 'none';
        el.style.animation  = 'none';
        if (front) { front.style.transition = 'none'; front.style.animation = 'none'; }
        if (back)  { back.style.transition  = 'none'; back.style.animation  = 'none'; }
        fn();
        void el.offsetWidth; // Reflow
      } finally {
        el.style.transition = prevT || '';
        el.style.animation  = prevA || '';
        if (front) { front.style.transition = pFT || ''; front.style.animation = pFA || ''; }
        if (back)  { back.style.transition  = pBT || ''; back.style.animation  = pBA || ''; }
      }
    };

    const cleanPlaceholder = (el) => {
      if (el?.dataset?.placedAt) {
        const oldPh = document.getElementById(el.dataset.placedAt);
        if (oldPh) oldPh.classList.remove('filled');
        delete el.dataset.placedAt;
      }
    };

    cardsState.forEach((cardData) => {
      // Karte finden (per id oder cardId)
      const rawId = cardData.id || cardData.cardId || '';
      const el = document.getElementById(rawId) ||
                document.getElementById('card-' + (cardData.cardId || '')) ||
                document.querySelector(`.card[data-card-id="${cardData.cardId || ''}"]`);
      if (!el) { console.warn('Karte nicht gefunden:', rawId || cardData.cardId); return; }

      withoutAnimations(el, () => {
        // Animationsklassen sicher entfernen
        el.classList.remove('returning','flipping','shuffling','remote-dragging');

        // Während lokaler oder eingehender Remote-Drags keinerlei Positions-/Stack-Änderungen aus Snapshots
        const isActive = el.classList.contains('being-dragged') || el._remoteDragActive === true;
        if (isActive) {
          // Flip/Z-Index dürfen aktualisiert werden, aber keine Positions-/Parent-Änderungen
          if (typeof cardData.isFlipped === 'boolean') {
            el.classList.toggle('flipped', !!cardData.isFlipped);
          }
          if (cardData.zIndex !== undefined && cardData.zIndex !== '') {
            el.style.zIndex = String(cardData.zIndex);
          }
          return; // restlichen Restore für diese Karte überspringen
        }

        // Flip-Zustand hart setzen (keine Flip-Animation)
        if (typeof cardData.isFlipped === 'boolean') {
          el.classList.toggle('flipped', !!cardData.isFlipped);
        }

        if (cardData.inStack) {
          // → In den Stapel (ohne Flug/Flip)
          cleanPlaceholder(el);
          if (cardStack && !cardStack.contains(el)) cardStack.appendChild(el);

          // Z-Index respektieren
          if (cardData.zIndex !== undefined && cardData.zIndex !== '') {
            el.style.zIndex = String(parseInt(cardData.zIndex, 10));
          }

          // Leichter Versatz je Layer (wie beim Stapel)
          const zi = parseInt(el.style.zIndex || '1', 10) || 1;
          const offset = Math.max(0, (zi - 1) * 0.5);
          el.style.position = 'absolute';
          el.style.left = offset + 'px';
          el.style.top  = offset + 'px';

        } else {
          // → Auf der Bühne positionieren
          if (stage && !stage.contains(el)) stage.appendChild(el);
          el.style.position = 'absolute';

          // Primär: normierte Koordinaten → unskalierte px
          if (typeof cardData.nx === 'number' && typeof cardData.ny === 'number') {
            const pos = fromNormCard(cardData.nx, cardData.ny); // nutzt deine Helper
            el.style.left = Math.round(pos.x) + 'px';
            el.style.top  = Math.round(pos.y) + 'px';
          } else {
            // Fallback: alte px-Strings (Abwärtskompatibilität)
            if (cardData.left  !== undefined && cardData.left  !== '') el.style.left = cardData.left;
            if (cardData.top   !== undefined && cardData.top   !== '') el.style.top  = cardData.top;
          }

          if (cardData.zIndex !== undefined && cardData.zIndex !== '') {
            el.style.zIndex = String(cardData.zIndex);
          }

          // Platzhalter-Status (falls genutzt)
          if (cardData.placedAt) {
            el.dataset.placedAt = cardData.placedAt;
            const ph = document.getElementById(cardData.placedAt);
            if (ph) ph.classList.add('filled');
          } else {
            cleanPlaceholder(el);
          }
        }
      });
    });

    // Stapel im DOM nach z-index sortieren (unten→oben), ohne Animation
    if (cardStack) {
      Array.from(cardStack.querySelectorAll(':scope > .card'))
        .sort((a, b) => (parseInt(a.style.zIndex || '0', 10)) - (parseInt(b.style.zIndex || '0', 10)))
        .forEach(el => cardStack.appendChild(el));
    }

    document.dispatchEvent(new Event('boardStateUpdated'));
  }
  window.restoreCards = restoreCards;



  // Erweiterte Funktion für den "Sitzung beenden" Button
  function setupSaveAndCloseButton() {
    // Automatisches Speichern in regelmäßigen Abständen
    const autoSaveInterval = setInterval(() => {
      saveCurrentBoardState('interval'); // markiert NICHT als dirty
    }, 60000); // Alle 60 Sekunden
    
    // Speichern beim Beenden der Sitzung
    const closeSessionBtn = document.querySelector('.end-session-btn');
    if (closeSessionBtn) {
      // Vorhandene Event-Listener entfernen
      const newCloseSessionBtn = closeSessionBtn.cloneNode(true);
      closeSessionBtn.parentNode.replaceChild(newCloseSessionBtn, closeSessionBtn);
      
      // Neuen Event-Listener hinzufügen
      newCloseSessionBtn.addEventListener('click', () => {
        // Speichern und dann Dialog anzeigen
        if (saveCurrentBoardState()) {
          createEndSessionDialog();
        } else {
          // Bei Fehler Warnung anzeigen
          alert("Es gab ein Problem beim Speichern der Sitzung. Möchten Sie trotzdem fortfahren?");
        }
      });
    }
    
    // Speichern bei Verlassen der Seite
    window.addEventListener('beforeunload', (e) => {
      if (typeof isOwner === 'function' && isOwner() && window.__DIRTY__ === true) {
        try { flushSaveNow(); } catch {}
      }
    });
    
    // Speichern beim Drücken von Strg+S
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (saveCurrentBoardState()) {
          showSaveNotification();
        }
      }
    });
    
    return autoSaveInterval;
  }

  // Zeigt eine Benachrichtigung an, dass gespeichert wurde
  function showSaveNotification() {
    // Vorhandenen Toast entfernen
    const existingToast = document.getElementById('save-toast');
    if (existingToast) {
      existingToast.remove();
    }
    
    // Neuen Toast erstellen
    const toast = document.createElement('div');
    toast.id = 'save-toast';
    toast.className = 'save-toast';
    toast.textContent = 'Sitzung wurde gespeichert';
    
    // Zur Seite hinzufügen
    document.body.appendChild(toast);
    
    // Nach 2 Sekunden wieder entfernen
    setTimeout(() => {
      toast.classList.add('hide');
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 2000);
  }

  // CSS für den Save-Toast hinzufügen
  function addSaveToastStyles() {
    if (!document.getElementById('save-toast-styles')) {
      const style = document.createElement('style');
      style.id = 'save-toast-styles';
      style.textContent = `
        .save-toast {
          position: fixed;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          background-color: rgba(0, 0, 0, 0.7);
          color: white;
          padding: 10px 20px;
          border-radius: 4px;
          z-index: 9999;
          animation: fadeIn 0.3s ease;
        }
        
        .save-toast.hide {
          animation: fadeOut 0.3s ease forwards;
        }
        
        @keyframes fadeIn {
          from { opacity: 0; transform: translate(-50%, 20px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
        
        @keyframes fadeOut {
          from { opacity: 1; transform: translate(-50%, 0); }
          to { opacity: 0; transform: translate(-50%, 20px); }
        }
      `;
      document.head.appendChild(style);
    }
  }

  function ensureEndSessionButton() {
    // Styles nur einmal injizieren
    if (!document.getElementById('end-session-btn-styles')) {
      const style = document.createElement('style');
      style.id = 'end-session-btn-styles';
      style.textContent = `
        .end-session-btn{
          position: fixed;
          right: max(16px, env(safe-area-inset-right));
          bottom: max(16px, env(safe-area-inset-bottom));
          z-index: 10050;
          padding: 10px 14px;
          background: #ff6666;
          color: #fff;
          border: none;
          border-radius: 10px;
          font-weight: 600;
          box-shadow: 0 4px 10px rgba(0,0,0,.15);
          cursor: pointer;
          transition: transform .2s ease, filter .2s ease;
        }
        .end-session-btn:hover{ transform: translateY(-1px); filter: brightness(.97); }
        .end-session-btn:active{ transform: translateY(0); }
      `;
      document.head.appendChild(style);
    }

    // Button nur einmal sicherstellen
    let btn = document.querySelector('.end-session-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'end-session-btn';
      btn.type = 'button';
      btn.textContent = 'Sitzung beenden';
      document.body.appendChild(btn);
    }

    // Click-Handler (frisch binden)
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', createEndSessionDialog);
  }

  // Benachrichtigung anzeigen
  function showSaveNotification(message = "Sitzung wurde gespeichert") {
    // Vorhandenen Toast entfernen
    const existingToast = document.getElementById('save-toast');
    if (existingToast) {
      existingToast.remove();
    }
    
    // Neuen Toast erstellen
    const toast = document.createElement('div');
    toast.id = 'save-toast';
    toast.className = 'save-toast';
    toast.textContent = message;
    
    // Stil für Toast definieren, falls nicht vorhanden
    if (!document.getElementById('save-toast-styles')) {
      const style = document.createElement('style');
      style.id = 'save-toast-styles';
      style.textContent = `
        .save-toast {
          position: fixed;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          background-color: rgba(0, 0, 0, 0.7);
          color: white;
          padding: 10px 20px;
          border-radius: 4px;
          z-index: 9999;
          opacity: 0;
          transition: opacity 0.3s ease;
        }
        
        .save-toast.show {
          opacity: 1;
        }
      `;
      document.head.appendChild(style);
    }
    
    // Zur Seite hinzufügen
    document.body.appendChild(toast);
    
    // Animation einleiten
    setTimeout(() => {
      toast.classList.add('show');
    }, 10);
    
    // Nach 2 Sekunden wieder entfernen
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 2000);
  }

  // Fehlermeldung anzeigen
  const showError = (message) => {
    errorMessage.textContent = message;
    errorContainer.classList.remove('hidden');
  };

  // Sitzung laden (setzt u.a. window.sessionData)
  loadSession();

  // 1) Board/Deck ermitteln und Board aufbauen
  // Kurzes Warten auf CC_INIT (falls in Wrapper geöffnet) – sonst Timeout
  waitForBootConfig(800).then(() => {
    const resolved = resolveBoardAndDeck();
    window.boardType = resolved.board;
    window.deck      = resolved.deck;

    initializeBoard();
    // 2) Zustand aus DB wiederherstellen, sobald Karten existieren
    if (typeof waitForCards === 'function' && typeof loadSavedBoardState === 'function') {
      waitForCards().then(() => { try { loadSavedBoardState(); } catch(e) { console.warn(e); } });
    }
  });

  // 2) Zustand aus DB wiederherstellen, sobald Karten existieren
  if (typeof waitForCards === 'function' && typeof loadSavedBoardState === 'function') {
     waitForCards().then(() => { try { loadSavedBoardState(); } catch(e) { console.warn(e); } });
  }

  // UI-Helfer
  addSaveToastStyles();


  // (optional) Button-Handler neu setzen
  if (typeof setupEndSessionButton === 'function') setupEndSessionButton();

  // Join-/Passwort-Flow initialisieren (wie bisher)
  if (window.addPasswordPromptStyles) window.addPasswordPromptStyles();
  if (window.initializeParticipantJoin) window.initializeParticipantJoin();
  if (window.handleSessionJoin) window.handleSessionJoin();
    // CSS für Speicherbenachrichtigungen hinzufügen
    addSaveToastStyles(); 

  // Bestehende Notizen/Notes initial beobachten (AutoGrow + Resize)
  document.querySelectorAll('.notiz, .note').forEach(n => {
    attachNoteResizeObserver(n);
    attachNoteAutoGrow(n);
    setupNoteEditingHandlers?.(n);
    enhanceDraggableNote?.(n);
  });


  // Bei Fenstergrößenänderung Notizzettel ggf. auf Maximalgröße begrenzen
  window.addEventListener('resize', () => {
    const max = getMaxNoteSize();
    document.querySelectorAll('.notiz, .note').forEach(n => {
      if (typeof n._autoGrowRecalc === 'function') {
        n._autoGrowRecalc();
      } else {
        // Fallback: clampen
        const rect = n.getBoundingClientRect();
        const w = Math.min(Math.ceil(rect.width), max.width);
        const h = Math.min(Math.ceil(rect.height), max.height);
        n.style.width = w + 'px';
        n.style.height = h + 'px';
      }
    });
    debouncedSave();
  });


  window.addEventListener('beforeunload', function () {
    try {
      if (typeof isOwner === 'function' && isOwner() && window.__DIRTY__ === true) {
        if (typeof flushSaveNow === 'function') flushSaveNow(); // synchroner Versuch
      }
    } catch {}
    try { sessionStorage.setItem('dashboard_reload_requested', 'true'); } catch {}
  });


});

(function () {
  const area     = document.querySelector('.focus-note-area');           // Container
  const titleEl  = area?.querySelector('h2');                            // Überschrift
  const editable = document.getElementById('focus-note-editable')        // Edit-Feld
                || area?.querySelector('[contenteditable="true"]');

  if (!area || !editable) return;

  // --- Ausrichtung aus dem Builder übernehmen (wenn als data-* gesetzt) ---
  // Erwartete data-Attribute: data-align-title, data-align-body
  const alignTitle = area.dataset.alignTitle || editable.dataset.alignTitle;
  const alignBody  = area.dataset.alignBody  || editable.dataset.alignBody;
  if (alignTitle && titleEl) titleEl.style.textAlign = alignTitle;
  if (alignBody) editable.style.textAlign = alignBody;

  // --- Admin-Default-Text merken (Platzhalter/Starttext aus dem Builder) ---
  // Erwartete data-Attribute: data-default-title, data-default-text
  const defaultTitle = titleEl?.dataset.defaultTitle || '';
  const defaultBody  = editable.dataset.defaultText  || editable.getAttribute('data-default') || '';

  function sameText(a,b){ return (a||'').replace(/\s+/g,' ').trim() === (b||'').replace(/\s+/g,' ').trim(); }

  editable.addEventListener('focus', () => {
    const userEdited = editable.dataset.userEdited === '1';
    const looksDefault = defaultBody && sameText(editable.innerText, defaultBody);
    // Beim ersten Klick nur dann löschen, wenn noch der Admin-Starttext drin ist
    if (!userEdited && looksDefault) {
      editable.textContent = '';
    }
  });

  editable.addEventListener('input', () => {
    editable.dataset.userEdited = '1';
    autoSize();
  });

  // --- Auto-Grow: wächst bis zur maximal verfügbaren Höhe im Container ---
  function autoSize() {
    // verfügbare Höhe = Boxhöhe - (Höhe bis unter die Überschrift) - Innenabstände
    const areaRect   = area.getBoundingClientRect();
    const headBottom = titleEl ? titleEl.getBoundingClientRect().bottom - areaRect.top : 0;

    // Puffer (Abstand): passe bei Bedarf an dein Padding im CSS an
    const padding    = 16;
    const maxH       = Math.max(0, area.clientHeight - headBottom - padding);

    editable.style.height = 'auto';                 // zurücksetzen
    const need = editable.scrollHeight;             // gewünschte Höhe
    const H    = Math.min(need, maxH);

    editable.style.height    = H + 'px';
    editable.style.overflowY = (need > maxH) ? 'auto' : 'hidden';   // erst am Limit scrollen
  }

  // Beim Laden und bei Layout-Änderung neu berechnen
  window.addEventListener('resize', autoSize, { passive: true });
  try { new ResizeObserver(autoSize).observe(area); } catch {}
  // Erste Berechnung
  autoSize();
})();

window.handleSessionJoin              = window.handleSessionJoin              || handleSessionJoin;
window.showParticipantNamePrompt      = window.showParticipantNamePrompt      || showParticipantNamePrompt;
window.addParticipantNamePromptStyles = window.addParticipantNamePromptStyles || addParticipantNamePromptStyles;
window.joinSession                    = window.joinSession                    || joinSession;
// Nur eine sichere Fallback-Funktion setzen – NICHT auf eine lokale Variable referenzieren
if (typeof window.handleParticipantJoin !== 'function') {
  window.handleParticipantJoin = function(session){
    if (typeof window.addParticipantNamePromptStyles === 'function') window.addParticipantNamePromptStyles();
    if (typeof window.showParticipantNamePrompt === 'function') window.showParticipantNamePrompt(session);
    return true;
  };
}

// Fallback-Funktion für showError
window.showError = showError || function(message) {
  console.error(message);
  const errorContainer = document.createElement('div');
  errorContainer.style.position = 'fixed';
  errorContainer.style.top = '20px';
  errorContainer.style.left = '50%';
  errorContainer.style.transform = 'translateX(-50%)';
  errorContainer.style.backgroundColor = '#ffecec';
  errorContainer.style.color = '#d8000c';
  errorContainer.style.padding = '10px';
  errorContainer.style.borderRadius = '4px';
  errorContainer.style.zIndex = '9999';
  errorContainer.textContent = message;
  
  document.body.appendChild(errorContainer);
  
  setTimeout(() => {
    document.body.removeChild(errorContainer);
  }, 5000);
};


// Validierung des Board-Zustands
function isValidBoardState(boardState) {
  // Grundlegende Validierungen
  if (!boardState) return false;
  
  // Maximale Anzahl von Elementen begrenzen
  const MAX_NOTES = 50;
  const MAX_CARDS = 30;
  
  if (boardState.notes && boardState.notes.length > MAX_NOTES) {
    console.warn(`Zu viele Notizen (${boardState.notes.length}). Maximale Anzahl: ${MAX_NOTES}`);
    return false;
  }
  
  if (boardState.cards && boardState.cards.length > MAX_CARDS) {
    console.warn(`Zu viele Karten (${boardState.cards.length}). Maximale Anzahl: ${MAX_CARDS}`);
    return false;
  }
  
  return true;
}

function getSessionsUrl() {
  // a) Serverseitig gesetzt (empfohlen)
  if (window.ccsConfig && ccsConfig.sessionsUrl) return ccsConfig.sessionsUrl;

  // b) Optional per postMessage übergeben
  if (window.CC_BOOT && (window.CC_BOOT.sessionsUrl || window.CC_BOOT.returnUrl)) {
    return window.CC_BOOT.sessionsUrl || window.CC_BOOT.returnUrl;
  }

  // c) Wenn das Board aus "Meine Sessions" geöffnet wurde: komplette Referrer-URL inkl. Token nehmen
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref && /\/meine-sessions\//i.test(ref.pathname)) return ref.href;
  } catch {}

  // d) Fallback: "board." aus der Hostname entfernen und absolute URL bauen
  const host = location.hostname.replace(/^board\./, '');
  return `${location.protocol}//${host}/meine-sessions/`;
}


// Fehler-Benachrichtigungsfunktion
function showErrorNotification(message) {
  const notification = document.createElement('div');
  notification.style.position = 'fixed';
  notification.style.top = '20px';
  notification.style.left = '50%';
  notification.style.transform = 'translateX(-50%)';
  notification.style.backgroundColor = '#ffcccc';
  notification.style.color = '#d9534f';
  notification.style.padding = '10px';
  notification.style.borderRadius = '4px';
  notification.style.zIndex = '9999';
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    document.body.removeChild(notification);
  }, 3000);
}

/* === Load-Failure Overlay (Board/Kartenset) =============================== */
function ensureLoadFailureStyles(){
  if (document.getElementById('lf-styles')) return;
  const st = document.createElement('style');
  st.id = 'lf-styles';
  st.textContent = `
    .modal-open{ overflow:hidden; }
    #load-failure-overlay{ position:fixed; inset:0; z-index:2147483600; }
    #load-failure-overlay .lf-backdrop{ position:absolute; inset:0; background:rgba(0,0,0,.5); }
    #load-failure-overlay .lf-modal{
      position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
      background:#fff; border-radius:12px; padding:20px;
      width:min(560px, calc(100vw - 32px));
      box-shadow:0 20px 60px rgba(0,0,0,.25);
    }
    #load-failure-overlay h3{ margin:0 0 8px; font-size:20px; }
    #load-failure-overlay p{ margin:0 0 14px; line-height:1.4; }
    #load-failure-overlay .lf-actions{ display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
    #load-failure-overlay .lf-actions a,
    #load-failure-overlay .lf-actions button{
      border:0; background:#e8e8e8; padding:10px 14px; border-radius:10px;
      text-decoration:none; color:#222; cursor:pointer;
    }
    #load-failure-overlay .lf-actions button{ background:#ff6666; color:#fff; }
  `;
  document.head.appendChild(st);
}
function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
window.showLoadFailureOverlay = function(kind='board', slug=''){
  ensureLoadFailureStyles();
  if (document.getElementById('load-failure-overlay')) return;

  const backUrl = (typeof getSessionsUrl === 'function') ? getSessionsUrl() : '/meine-sessions/';
  const title   = (kind === 'cardset') ? 'Kartenset konnte nicht geladen werden' : 'Board konnte nicht geladen werden';
  const text    = (kind === 'cardset')
      ? `Das ausgewählte Kartenset <b>${escapeHtml(slug)}</b> konnte nicht geladen werden.`
      : `Das ausgewählte Board <b>${escapeHtml(slug)}</b> konnte nicht geladen werden.`;

  const wrap = document.createElement('div');
  wrap.id = 'load-failure-overlay';
  wrap.innerHTML = `
    <div class="lf-backdrop" aria-hidden="true"></div>
    <div class="lf-modal" role="dialog" aria-modal="true" aria-labelledby="lf-title">
      <h3 id="lf-title">${title}</h3>
      <p>${text}</p>
      <div class="lf-actions">
        <a href="${backUrl}">Zurück zu „Meine Sessions“</a>
        <button id="lf-close">Fenster schließen</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('modal-open');

  // Schließen (versucht, den Wrapper-Tab zu schließen; ansonsten nur Overlay weg)
  const closeAll = () => {
    try {
      const sid = new URLSearchParams(location.search).get('id') || null;
      if (window.top && window.top !== window) {
        window.top.postMessage({ type:'END_SESSION', sessionId: sid }, '*');
      }
      window.close();
    } catch {}
    try {
      wrap.remove();
      document.body.classList.remove('modal-open');
    } catch {}
  };

  document.getElementById('lf-close')?.addEventListener('click', closeAll);
  wrap.querySelector('.lf-backdrop')?.addEventListener('click', () => {
    // nur Overlay schließen (Soft-Close bei Klick neben das Modal)
    try { wrap.remove(); document.body.classList.remove('modal-open'); } catch {}
  });
};
/* ======================================================================== */


window.dumpNote = function(id){
  const el = document.getElementById(id);
  if (!el) return console.warn('dumpNote: not found', id);
  console.log('[NOTES] DUMP', {
    id,
    left: el.style.left, top: el.style.top, z: el.style.zIndex,
    locked: el.dataset.locked, by: el.dataset.lockedBy, until: el.dataset.lockedUntil,
    isEditingClass: el.classList.contains('is-editing'),
    contentEditable: !!el.querySelector('.notiz-content[contenteditable="true"]')
  });
};
window.forceUnlockNote = function(id){
  const el = document.getElementById(id);
  if (!el) return;
  delete el.dataset.locked; delete el.dataset.lockedBy; delete el.dataset.lockedUntil;
  el.classList.remove('is-editing');
  sendRT({ t:'note_unlock', id });
  console.log('[NOTES] FORCE_UNLOCK', id);
};