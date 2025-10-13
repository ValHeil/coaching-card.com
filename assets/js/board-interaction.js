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
const RT_PRI = () => (isOwner() ? 2 : 1); // Owner gewinnt bei Kollisionen
const RT_LAST = new Map(); // objectId -> { prio, ts }

// 150ms-Fenster: wenn in diesem Fenster bereits etwas Höherwertiges passierte, ignorieren
function shouldApply(objId, incomingPrio, now = performance.now()) {
  const last = RT_LAST.get(objId);
  if (!last) { RT_LAST.set(objId, { prio: incomingPrio, ts: now }); return true; }
  const fresh = (now - last.ts) <= 150;
  const ok = !fresh || (incomingPrio > last.prio);
  if (ok) RT_LAST.set(objId, { prio: incomingPrio, ts: now });
  return ok;
}

// Board-Rechteck holen
function getStage(){
  return document.getElementById('session-board')
      || document.querySelector('.board-area')
      || document.body;
}
function getStageRect(){ return getStage().getBoundingClientRect(); }

// Pixel -> normiert (0..1) relativ zur Stage
function toNorm(px, py) {
  const r = getStageRect();
  return { nx: px / r.width, ny: py / r.height };
}
// normiert -> Pixel relativ zur Stage
function fromNorm(nx, ny) {
  const r = getStageRect();
  return { x: nx * r.width, y: ny * r.height };
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

  function move(id, x, y, color, label){
    const p = ensureCursorEl(id, color, label);
    const boardEl = document.querySelector('.board-area') || document.body;
    const r = boardEl.getBoundingClientRect();
    // x,y kommen RELATIV zur board-area:
    const absX = r.left + x;
    const absY = r.top  + y;
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

function cardStageRect(){
  const el = document.getElementById('cards-container') || document.querySelector('.cards-container') || document.getElementById('session-board');
  return el.getBoundingClientRect();
}
function toNormCard(px, py){
  const r = cardStageRect(); return { nx: px / r.width, ny: py / r.height };
}
function fromNormCard(nx, ny){
  const r = cardStageRect(); return { x: nx * r.width, y: ny * r.height };
}

// ---- Realtime Core (WS) -----------------------------------------------------
const RT = { ws:null, sid:null, uid:null, name:'', role:'participant' };

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
    console.log('[RT] open');

    const boardEl = document.querySelector('.board-area') || document.body;
    let last = 0;
    boardEl.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - last < 33) return; // ~30/s
      last = now;

      const r  = boardEl.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width;   // 0..1
      const ny = (e.clientY - r.top)  / r.height;  // 0..1

      sendRT({ t: 'cursor', nx, ny });
    }, { passive: true });
  };

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
          if (typeof waitForCards === 'function') { await waitForCards(); }
          restoreBoardState(state);
          document.dispatchEvent(new Event('boardStateUpdated')); // ok
          window.__HAS_BOOTSTRAPPED__ = true; // Merker: Initialstate kam über WS
        } catch (e) { console.warn('[RT] state_full apply failed', e); }
      })();
      return;
    }
    if (m.t === 'cursor') {
      const boardEl = document.querySelector('.board-area') || document.body;
      const r = boardEl.getBoundingClientRect();
      const px = (typeof m.nx === 'number') ? (m.nx * r.width)  : m.x;
      const py = (typeof m.ny === 'number') ? (m.ny * r.height) : m.y;
      Presence.move(m.id, px, py, m.color, m.label);
      return;
    }
    if (m.t === 'leave') {
      Presence.remove(m.id);
      return;
    }
    
    if (m.t === 'focus_update') {
      const focusEl = document.getElementById('focus-note-editable');
      if (!focusEl) return;

      // Owner-Vorrang: Wenn ich gerade tippe UND ich kein Owner bin,
      // aber die Nachricht vom Owner kommt -> Owner gewinnt, sonst lokale Eingabe bevorzugen.
      const iAmOwner = isOwner && typeof isOwner === 'function' ? isOwner() : false;
      const isEditingLocally = (document.activeElement === focusEl);
      const msgFromOwner = (m.role === 'owner');

      if (isEditingLocally && !iAmOwner && !msgFromOwner) {
        // Ich (Gast) tippe grade selbst; ignorier Teilnehmer-Updates
        return;
      }
      // Wenn ich (Gast) tippe, aber Owner schickt Update -> anwenden
      // Wenn ich Owner bin -> einfach anwenden

      const txt = (typeof m.content === 'string') ? m.content : '';
      if (typeof window.__ccSetFocusNote === 'function') {
        window.__ccSetFocusNote(txt);  // setzt ohne Echo
      } else {
        if ('value' in focusEl) focusEl.value = txt;
        else focusEl.innerText = txt;
      }
      return;
    }

    
    if (m.t === 'card_move') {
      if (!shouldApply(m.id, m.prio || 1)) return;
      const el = document.getElementById(m.id);
      if (!el) return;
      const { x, y } = (typeof m.nx === 'number')
        ? fromNormCard(m.nx, m.ny)  // <<< wichtig: Karten-Bühne
        : { x: m.x, y: m.y };
      el.style.left = (x|0) + 'px';
      el.style.top  = (y|0) + 'px';
      if (m.z !== undefined && m.z !== '') el.style.zIndex = m.z;
      return;
    }

    if (m.t === 'card_flip') {
      // WICHTIG: flips nicht vom letzten MOVE blockieren lassen → eigener Key
      const gateKey = `flip:${m.id}`;
      if (!shouldApply(gateKey, m.prio || 1)) return;

      const el = document.getElementById(m.id);
      if (!el) return;

      const want = !!m.flipped;
      const has  = el.classList.contains('flipped');
      if (want !== has) {
        el.classList.toggle('flipped', want);

        // optional: Flip-Sound auch bei Remote-Flip abspielen
        try {
          if (typeof cardFlipSound !== 'undefined' && cardFlipSound) {
            cardFlipSound.currentTime = 0;
            cardFlipSound.play().catch(()=>{});
          }
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
      const { x, y } = (typeof m.nx === 'number') ? fromNorm(m.nx, m.ny) : { x: m.x, y: m.y };
      el.style.left = Math.round(x) + 'px';
      el.style.top  = Math.round(y) + 'px';
      if (m.z !== undefined && m.z !== '') el.style.zIndex = m.z;
      if (m.w) el.style.width  = Math.round(m.w) + 'px';
      if (m.h) el.style.height = Math.round(m.h) + 'px';
      if (m.color) { el.dataset.color = m.color; el.style.backgroundColor = m.color; }
      if (typeof m.content === 'string') setNoteText(el, m.content);
      return;
    }

    if (m.t === 'note_move') {
      if (!shouldApply(m.id, m.prio || 1)) return;
      const { el } = ensureNoteEl(m.id);
      const { x, y } = (typeof m.nx === 'number') ? fromNorm(m.nx, m.ny) : { x: m.x, y: m.y };
      el.style.left = Math.round(x) + 'px';
      el.style.top  = Math.round(y) + 'px';
      if (m.z !== undefined && m.z !== '') el.style.zIndex = m.z;
      return;
    }

    if (m.t === 'note_update') {
      if (!shouldApply(m.id, m.prio || 1)) return;
      const { el, content } = ensureNoteEl(m.id);
      if (typeof m.content === 'string') setNoteText(el, m.content);
      if (m.color) { el.dataset.color = m.color; el.style.backgroundColor = m.color; }
      if (m.w) el.style.width  = Math.round(m.w) + 'px';
      if (m.h) el.style.height = Math.round(m.h) + 'px';
      return;
    }

    if (m.t === 'note_delete') {
      if (!shouldApply(m.id, m.prio || 1)) return;
      const note = document.getElementById(m.id);
      if (note) note.remove();
      return;
    }

    if (m.t === 'note_lock') {
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

  RT.ws.onclose = () => {
    console.log('[RT] close');
    Presence.clearAll();
  };

  RT.ws.onerror = (e) => console.warn('[RT] error', e);
}

function hashState(state) {
  try { return JSON.stringify(state); } catch { return String(Date.now()); }
}
function isOwner() {
  return document.documentElement.getAttribute('data-ccs-owner') === '1';
}

async function _doSave(reason = 'auto') {
  if (!isOwner()) return false; // nur der Owner persistiert
  if (_saveInFlight) return false;
  const sid = new URLSearchParams(location.search).get('id');
  if (!sid) return false;

  // ← WICHTIG: erst speichern, wenn die Funktion existiert
  if (typeof captureBoardState !== 'function') {
    console.warn('[Autosave] captureBoardState fehlt (noch)');
    return false;
  }

  const state = captureBoardState();
  const h = hashState(state);
  if (h === _lastStateHash && reason !== 'force') return false; // nichts geändert

  _lastStateHash = h;
  _saveInFlight = true;
  try {
    await persistStateToServer(state);

    // ← NEU: Autoritativen Snapshot an alle Teilnehmer schicken
    sendRT({ t: 'state_full', state, prio: 3, ts: Date.now() });

    return true;
  } finally { _saveInFlight = false; }
}

// Sammelpunkt für alle Save-Auslöser
function saveCurrentBoardState(reason = 'auto') {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _doSave(reason); }, 400);
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
  if (sess.name) {
    const h = document.getElementById('board-title');
    if (h) h.textContent = sess.name;
  }
  if (sess.board) window.boardType = (typeof canonBoardSlug === 'function') ? canonBoardSlug(sess.board) : (sess.board||'board1');
  if (sess.deck)  window.deck      = (typeof canonDeckSlug  === 'function') ? canonDeckSlug(sess.deck)  : (sess.deck||'deck1');
  
  try { initRealtime(d.config); } catch(e) { console.warn('[RT] init failed', e); }

});

// Kanonische Slugs -> interne Keys
function canonBoardSlug(s='') {
  s = (s || '').toString().toLowerCase();
  if (['problem-lösung','problem-loesung','problemlösung','problem','problem_loesung','board_problem_loesung'].includes(s)) return 'board1';
  if (['boardtest','testboard','board_test'].includes(s)) return 'boardTest';
  return s || 'board1';
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

    const { state_b64 } = await res.json();
    if (!state_b64) {
      console.log('[DEBUG] Kein Zustand in der DB vorhanden.');
      return false;
    }

    const state = base64ToJSONUTF8(state_b64); // UTF-8 sicher
    return restoreBoardState(state);
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
  const rawBoard = url.get('board') || (window.CC_BOOT && window.CC_BOOT.board) || (window.sessionData && window.sessionData.boardId) || 'board1';
  const rawDeck  = url.get('deck')  || (window.CC_BOOT && window.CC_BOOT.deck)  || 'deck1';

  let b = canonBoardSlug(rawBoard);
  let d = canonDeckSlug(rawDeck);

  // Fallbacks: wenn trotzdem etwas Exotisches reinrutscht -> board1/deck1
  if (!['board1','boardTest'].includes(b)) b = 'board1';
  if (!d) d = 'deck1';

  return { board: b, deck: d };
}


/* Kompat: wird vom Token/Join-Flow ggf. gesetzt */
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
    (window.CC_BOOT && window.CC_BOOT.board) ||
    boot.board ||
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

document.addEventListener('DOMContentLoaded', function() {
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
        const currentW = Math.ceil(noteEl.getBoundingClientRect().width);
        if (Math.abs(currentW - targetW) > 1) {
          noteEl.style.width = targetW + 'px';
        }

        // Höhe: Inhaltshöhe bei gesetzter Breite
        let targetH = Math.ceil(content.scrollHeight + padY);
        targetH = Math.max(targetH, minH);
        if (targetH > max.height) targetH = max.height;
        const currentH = Math.ceil(noteEl.getBoundingClientRect().height);
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
    if (!['board1','boardTest'].includes(effBoard)) effBoard = 'board1';
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
    // Basiseinstellungen für das Board (Hintergrund etc.) basierend auf dem Board-Typ
    document.querySelector('.board-area').classList.add(`board-type-${boardType}`);

    // Ablageplätze für Karten erstellen
    createCardPlaceholders();

    // Focus Note erstellen
    createFocusNote();

    // Karten erstellen (abhängig vom Board-Typ)
    createCards();

    // Vorhandene Notizen laden (falls vorhanden)
    //loadNotes();

    // Teilnehmerliste initialisieren
    initializeParticipants();

    // Mülleimer hinzufügen
    addTrashContainer();

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
      
      // Get the ID of the dragged element
      const id = e.dataTransfer.getData('text/plain');
      const draggedElement = document.getElementById(id);
      
      if (!draggedElement) return;
      
      // Calculate position relative to board
      const boardRect = boardArea.getBoundingClientRect();
      const scale = parseFloat(boardArea.dataset.scale || '1'); // <-- wichtig!

      // Mausposition in unskalierten Pixeln
      const rawX = (e.clientX - boardRect.left) / scale;
      const rawY = (e.clientY - boardRect.top)  / scale;

      // so platzieren, dass die Karte/Notiz vollständig sichtbar bleibt
      const halfW = draggedElement.offsetWidth  / 2;
      const halfH = draggedElement.offsetHeight / 2;
      const maxX  = boardArea.scrollWidth  - halfW;
      const maxY  = boardArea.scrollHeight - halfH;

      const x = Math.max(halfW, Math.min(rawX, maxX));
      const y = Math.max(halfH, Math.min(rawY, maxY));

      draggedElement.style.left = Math.round(x - halfW) + 'px';
      draggedElement.style.top  = Math.round(y - halfH) + 'px';
      
      // If it's a card from the stack, move it to the board
      if (draggedElement.classList.contains('card')) {
        const cardStack = document.getElementById('card-stack');
        if (cardStack && cardStack.contains(draggedElement)) {
          cardStack.removeChild(draggedElement);
          boardArea.appendChild(draggedElement);
        }
      }
      
      // Save board state after movement
      saveCurrentBoardState();
    });

    // Setup Focus Note Editable Field
    setupFocusNoteEditable();

    // Event-Listener für Aktionen einrichten
    setupEventListeners();

    // skaliert das Board so, dass alles in den Viewport passt (nie größer als 1.0)
    function fitBoardToViewport(){
      const area = document.querySelector('.board-area');
      if (!area) return;

      // kurz zurücksetzen zum Messen
      const prev = area.style.transform;
      area.style.transform = 'none';

      const naturalW = Math.max(area.scrollWidth,  area.getBoundingClientRect().width);
      const naturalH = Math.max(area.scrollHeight, area.getBoundingClientRect().height);

      const availW = window.innerWidth;
      const availH = window.innerHeight;

      const scale = Math.min(availW / naturalW, availH / naturalH, 1);

      area.style.transformOrigin = 'top center';
      area.style.transform = `scale(${scale})`;
      area.dataset.scale = String(scale);   // <-- Faktor merken
    }

    // beim Start & bei Resize anwenden
    window.addEventListener('resize', (() => {
      let t; 
      return () => { clearTimeout(t); t = setTimeout(fitBoardToViewport, 120); };
    })());

    fitBoardToViewport();
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
      const endSessionBtn = document.querySelector('.end-session-btn');
      const newEndSessionBtn = document.createElement('button');
      newEndSessionBtn.className = 'end-session-btn';
      newEndSessionBtn.textContent = 'Sitzung beenden';
      
      document.body.appendChild(newEndSessionBtn);
      
      // Direkt nach dem Hinzufügen den Event-Listener setzen:
      newEndSessionBtn.addEventListener('click', () => {
        createEndSessionDialog();
      });
    

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

  // Karten erstellen und als Stapel anordnen
  // Kartenstapel für board1/boardTest erzeugen (Decks robust auflösen)
  function createCards() {
    // Nur unsere Board-Typen haben den Kartenstapel
    if (window.boardType !== 'board1' && window.boardType !== 'boardTest') return;

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
    const infoBox = document.querySelector('.board-info-box') || document.getElementById('board-info-box');
    if (!infoBox) { console.warn('createCards(): .board-info-box nicht gefunden'); return; }

    // Container vorbereiten
    infoBox.textContent = '';
    infoBox.style.position = 'relative';

    // Kartenstapel-Element
    const stack = document.createElement('div');
    stack.className = 'card-stack';
    stack.id = 'card-stack';
    infoBox.appendChild(stack);

    // Globale Arrays initialisieren
    window.cards = [];
    const deckSlug = resolveDeck();
    const deckPath = `assets/cards/${deckSlug}`;

    // Anzahl Karten feststellen und Stapel aufbauen
    if (typeof detectCardCount !== 'function') {
      console.warn('detectCardCount() fehlt – Karten können nicht geladen werden.');
      return;
    }

    detectCardCount(deckPath).then((total) => {
      if (!total || total < 1) {
        console.warn('Keine Kartenbilder gefunden unter', deckPath);
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
          <div class="card-back"><div class="card-back-design"></div></div>
        `;

        // Interaktionen
        if (typeof flipCard === 'function') card.addEventListener('dblclick', () => flipCard(card));
        if (typeof makeDraggable === 'function') makeDraggable(card);

        stack.appendChild(card);
        window.cards.push(card);
      }

      // kurz warten, dann mischen + gespeicherten Zustand versuchen
      setTimeout(() => { if (typeof shuffleCards === 'function') shuffleCards(); }, 300);
      try { if (typeof loadSavedBoardState === 'function') loadSavedBoardState(); } catch(e) { console.warn('Zustand konnte nicht geladen werden:', e); }
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
      window._hoverMoveHandler = function(e) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const stackEl = el ? el.closest('#card-stack') : null;
        const cardEl = el ? el.closest('.card') : null;

        if (stackEl) {
          // Cursor über dem Kartenstapel: M erlaubt, F/B deaktiviert
          window.isHoveringStack = true;
          window.isHoveringCard = false;
          window.hoveredCard = null;
        } else if (cardEl) {
          // Nur Karten außerhalb des Stapels zählen für F/B
          const insideStack = !!cardEl.closest('#card-stack');
          window.isHoveringStack = false;
          window.isHoveringCard = !insideStack;
          window.hoveredCard = insideStack ? null : cardEl;
        } else {
          window.isHoveringStack = false;
          window.isHoveringCard = false;
          window.hoveredCard = null;
        }
      };
      document.addEventListener('mousemove', window._hoverMoveHandler);

      console.log("[DEBUG] Hover-Tracking Setup abgeschlossen");
    }
    
    // Initial einrichten
    setupCardHoverTracking();
    
    // Bei Änderung des Board-Status (neue Karten) Tracking erneuern
    document.addEventListener('boardStateUpdated', setupCardHoverTracking);

    // Jede Board-Änderung (lokal/remote) -> speichern (Owner-gated + debounced)
    document.addEventListener('boardStateUpdated', () => saveCurrentBoardState('user'));

    
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
    // Nur mit linker Maustaste
    if (e.button !== 0) return;
    
    e.preventDefault();
    console.log("Erstelle neue Notiz...");
    
    const notizId = 'note-' + Date.now();
    console.log("Neue Notiz-ID:", notizId);
    
    const notiz = document.createElement('div');
    notiz.className = 'notiz';
    notiz.id = notizId;
    
    // WICHTIG: Notiz sofort als draggable markieren für Drag-and-Drop
    notiz.setAttribute('draggable', 'true');
    
    // Zufällige leichte Rotation für natürlicheren Look
    const rotation = Math.random() * 6 - 3; // -3 bis +3 Grad
    notiz.style.setProperty('--rotation', `${rotation}deg`);
    
    // Position am Mauszeiger
    notiz.style.left = `${e.clientX - 90}px`;
    notiz.style.top = `${e.clientY - 90}px`;
    notiz.style.zIndex = Math.max(getHighestInteractiveZIndex() + 1, 1200);
    
    // Inhalt mit leerem editierbarem Textfeld
    notiz.innerHTML = `
      <div class="notiz-content" contenteditable="false"></div>
    `;
    
    // Notizzettel zum DOM hinzufügen
    document.body.appendChild(notiz);
    attachNoteResizeObserver(notiz);
    attachNoteAutoGrow(notiz);
    
    // WICHTIG: Drag-Funktionalität hinzufügen
    enhanceDraggableNote(notiz);
    
    // Event-Listener für das Ziehen des neuen Notizzettels
    const moveHandler = (moveEvent) => {
      notiz.style.left = `${moveEvent.clientX - 90}px`;
      notiz.style.top = `${moveEvent.clientY - 90}px`;
    };
    
    const upHandler = () => {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      
      // Doppelklick-Handler für Bearbeitung
      setupNoteEditingHandlers(notiz);
      
      // Den Notizzettel dem notes-Array hinzufügen
      if (typeof notes !== 'undefined') {
        notes.push(notiz);
      }
      
      {
      const px = parseFloat(notiz.style.left) || 0;
      const py = parseFloat(notiz.style.top)  || 0;
      const { nx, ny } = toNorm(px, py);
      const content = notiz.querySelector('.notiz-content')?.textContent || '';
      const rect = notiz.getBoundingClientRect();
      sendRT({
        t: 'note_create',
        id: notiz.id,
        nx, ny,
        z: notiz.style.zIndex || '',
        content,
        color: notiz.style.backgroundColor || (notiz.dataset.color || ''),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        prio: RT_PRI(),
        ts: Date.now()
      });
     }

      // Speichern des Board-Zustands nach dem Erstellen einer neuen Notiz
      if (typeof saveCurrentBoardState === 'function') {
        saveCurrentBoardState();
      }
    };
    
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
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
    const content = notiz.querySelector('.notiz-content');
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
      // Content-Element auf editierbar setzen
      content.setAttribute('contenteditable', 'true');
      
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
    });
    
    // Event-Listener für Tastendrücke im Textfeld
    content.addEventListener('keydown', (keyEvent) => {
      // Wenn das Textfeld leer ist und der erste Buchstabe eingegeben wird
      if (content.textContent.trim() === '' && 
          keyEvent.key.length === 1 && 
          !keyEvent.ctrlKey && 
          !keyEvent.altKey && 
          !keyEvent.metaKey) {
        // Verhindere die Standard-Eingabe
        keyEvent.preventDefault();
        
        // Füge einen Bulletpoint und dann den Buchstaben ein
        document.execCommand('insertText', false, '• ' + keyEvent.key);
      }
      // Wenn Enter gedrückt wird
      else if (keyEvent.key === 'Enter') {
        keyEvent.preventDefault();
        
        // Füge einen neuen Bulletpoint ein
        document.execCommand('insertText', false, '\n• ');
      }
    });
    
    // Bearbeitung beenden, wenn außerhalb geklickt wird
    function endEditing() {
      if (content.getAttribute('contenteditable') !== 'true') return;
      content.setAttribute('contenteditable', 'false');
      content.classList.remove('editing','blinking-cursor');
      notiz.classList.remove('is-editing');
      const indicator = notiz.querySelector('.editing-indicator');
      if (indicator) indicator.remove();

      // Lock-erneuerung stoppen
      clearInterval(notiz._lockRenew);
      notiz._lockRenew = null;

      // lokal entsperren
      delete notiz.dataset.locked;
      delete notiz.dataset.lockedBy;
      delete notiz.dataset.lockedUntil;

      // Unlock Broadcast
      sendRT({ t: 'note_unlock', id: notiz.id });

      // Finalen Text broadcasten
      const finalText = (typeof getNoteText === 'function')
        ? getNoteText(notiz)
        : (content.innerText || content.textContent || '');

      sendRT({ t: 'note_update', id: notiz.id, content: finalText, prio: RT_PRI(), ts: Date.now() });

      if ((finalText || '').trim() === '') {
        sendRT({ t: 'note_delete', id: notiz.id, prio: RT_PRI(), ts: Date.now() });
        notiz.remove();
        notes = (Array.isArray(notes) ? notes.filter(n => n !== notiz) : notes);
      } else {
        saveCurrentBoardState?.();
      }
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

  function enhanceDraggableNote(note) {
    if (!note) return;
    
    // Entferne das alte draggable-Attribut und die alten Event-Listener
    note.removeAttribute('draggable');
    note.removeEventListener('dragstart', note._dragStart);
    note.removeEventListener('dragend', note._dragEnd);
    
    // Einrichtung für benutzerdefinierte Drag-Funktionalität
    let isDragging = false;
    let isDraggingForTrash = false;
    let offsetX, offsetY;
    let initialX, initialY;
    let trashItem = document.querySelector('.trash-container');
    let mouseDownTime = 0;
    let hasMoved = false;
    
    // <<< NEU: Taktung für Live-RT (~30 FPS) oben in enhanceDraggableNote:
    let _rtNoteDragTick = 0;

    note.addEventListener('mousedown', function(e) {
      // Nicht ziehen, wenn gelockt (jemand editiert gerade) – mit Lease/TTL
      // (Nur wenn tatsächlich in den Text geklickt wurde, nicht ziehen)
      if (e.target && e.target.isContentEditable) return;
      // kein early return mehr bei data-locked

      // Nur linke Maustaste
      if (e.button !== 0) return;

      // Im Editiermodus/Löschmodus nicht ziehen
      if (e.target && e.target.isContentEditable) return;
      const trashCan = document.querySelector('.trash-container');
      if (trashCan && trashCan.classList.contains('deletion-mode')) return;

      // Zeit & State für Doppelklick/Drag
      mouseDownTime = Date.now();
      hasMoved = false;

      e.preventDefault();

      // Exakter Klick-Offset relativ zur Notiz
      const rect = note.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;

      // Startposition (für Trash-Check etc.)
      initialX = rect.left;
      initialY = rect.top;

      // nach vorne bringen
      note.style.zIndex = Math.max(getHighestInteractiveZIndex() + 1, 1200);

      // Dokument-Listener binden
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    
    function onMouseMove(e) {
      // Erst ab erster Bewegung Drag starten
      if (!hasMoved) {
        hasMoved = true;
        isDragging = true;
        note.classList.add('being-dragged');
      }
      if (!isDragging) return;
      e.preventDefault();

      const parentRect = note.parentNode.getBoundingClientRect();
      const newX = Math.round(e.clientX - parentRect.left - offsetX);
      const newY = Math.round(e.clientY - parentRect.top  - offsetY);

      note.style.position = 'absolute';
      note.style.left = newX + 'px';
      note.style.top  = newY + 'px';

      // <<< NEU: alle ~33ms Position relativ zur STAGE senden
      const now = performance.now();
      if (now - _rtNoteDragTick >= 33) {
        _rtNoteDragTick = now;

        const stageRect = getStageRect();        // #session-board / .board-area / body
        const pxStage = parentRect.left + newX - stageRect.left;
        const pyStage = parentRect.top  + newY - stageRect.top;
        const { nx, ny } = toNorm(pxStage, pyStage);

        sendRT({
          t: 'note_move',
          id: note.id,
          nx, ny,
          prio: RT_PRI(),
          ts: Date.now()
        });
      }
      
      // Prüfen, ob die Notiz über dem Mülleimer ist
      if (trashItem) {
        const trashRect = trashItem.getBoundingClientRect();
        const noteRect = note.getBoundingClientRect();
        
        // Wenn über dem Mülleimer
        if (noteRect.right > trashRect.left && 
            noteRect.left < trashRect.right &&
            noteRect.bottom > trashRect.top && 
            noteRect.top < trashRect.bottom) {
          
          if (!isDraggingForTrash) {
            // Visuelles Feedback für den Mülleimer
            trashItem.classList.add('drag-over');
            trashItem.style.transform = 'scale(1.2)';
            trashItem.style.backgroundColor = '#ffcccc';
            isDraggingForTrash = true;
          }
        } else if (isDraggingForTrash) {
          // Visuelles Feedback entfernen
          trashItem.classList.remove('drag-over');
          trashItem.style.transform = '';
          trashItem.style.backgroundColor = '';
          isDraggingForTrash = false;
        }
      }
    }
    
    function onMouseUp(e) {
      // Wenn nicht wirklich gezogen wurde und wenig Zeit vergangen ist,
      // könnte es Teil eines Doppelklicks sein, also nichts machen
      const clickDuration = Date.now() - mouseDownTime;
      
      // Event-Listener entfernen
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      
      // Wenn nicht bewegt (kein Drag) und kurze Zeit (könnte Teil eines Doppelklicks sein)
      if (!hasMoved && clickDuration < 300) {
        note.classList.remove('being-dragged');
        isDragging = false;
        return; // Nichts tun, könnte ein Doppelklick sein
      }
      
      if (!isDragging) return;
      
      // Ziehen beenden
      isDragging = false;
      note.classList.remove('being-dragged');
      
      // Prüfen, ob über dem Mülleimer losgelassen
      if (isDraggingForTrash && trashItem) {
        // Visuelles Feedback für Mülleimer zurücksetzen
        trashItem.classList.remove('drag-over');
        trashItem.style.transform = '';
        trashItem.style.backgroundColor = '';
        
        // Animation für das Löschen und Löschen der Notiz
        note.style.transition = 'all 0.3s ease';
        note.style.transform = 'scale(0.1) rotate(5deg)';
        note.style.opacity = '0';
        
        setTimeout(() => {
          note.remove();
          
          // Array aktualisieren, falls vorhanden
          if (typeof notes !== 'undefined' && Array.isArray(notes)) {
            notes = notes.filter(n => {
              if (n instanceof Element) {
                return n.id !== note.id;
              } else if (n && n.id) {
                return n.id !== note.id;
              }
              return true;
            });
          }
          
          console.log("Notiz erfolgreich gelöscht!");
          
          // Feedback-Effekt für Mülleimer
          trashItem.classList.add('note-deleted');
          setTimeout(() => {
            trashItem.classList.remove('note-deleted');
          }, 500);
          
          {
          const px = parseFloat(note.style.left) || 0;
          const py = parseFloat(note.style.top)  || 0;
          const { nx, ny } = toNorm(px, py);
          sendRT({
            t: 'note_delete',
            id: note.id,
            prio: RT_PRI(),
            ts: Date.now()
          });
          }

          // Board-Zustand speichern
          if (typeof saveCurrentBoardState === 'function') {
            saveCurrentBoardState();
          }
        }, 300);
        
        isDraggingForTrash = false;
        return;
       }
      
        const rect = note.getBoundingClientRect();
        const stageRect = getStageRect();
        const pxStage = Math.round(rect.left - stageRect.left);
        const pyStage = Math.round(rect.top  - stageRect.top);
        const { nx, ny } = toNorm(pxStage, pyStage);

        sendRT({
          t: 'note_move',
          id: note.id,
          nx, ny,
          prio: RT_PRI(),
          ts: Date.now()
        });

        if (typeof saveCurrentBoardState === 'function') {
          saveCurrentBoardState();
        }
      }
    
    // Stil für die Notizzettel anpassen
    note.style.cursor = 'grab';
  }

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
            returnCardToStack(card);
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

      const area = document.querySelector('.board-area');
      const boardRect = area.getBoundingClientRect();
      const scale = parseFloat(area?.dataset.scale || '1');

      // Position in „unskalierten“ Pixeln berechnen
      const x = Math.round((e.clientX - boardRect.left) / scale);
      const y = Math.round((e.clientY - boardRect.top)  / scale);

      draggedElement.style.left = `${Math.round(x - (draggedElement.offsetWidth  / 2))}px`;
      draggedElement.style.top  = `${Math.round(y - (draggedElement.offsetHeight / 2))}px`;

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
    console.log("Mache Element draggable:", element.id || "Unbekanntes Element");
    
    // Für Notizen die bestehende Logik verwenden
    if (element.classList.contains('notiz')) {
      enhanceDraggableNote(element);
      return;
    }

    let _rtRaf = null;
    let _rtPending = false;

    function queueRTCardMove(){
      _rtPending = true;
      if (_rtRaf) return;
      _rtRaf = requestAnimationFrame(() => {
        _rtRaf = null;
        if (!_rtPending) return;
        _rtPending = false;

        // Position relativ zur Karten-Bühne ermitteln
        const elRect    = element.getBoundingClientRect();
        const stageRect = cardStageRect(); // nutzt #cards-container/#session-board
        const px = Math.round(elRect.left - stageRect.left);
        const py = Math.round(elRect.top  - stageRect.top);
        const { nx, ny } = toNormCard(px, py);

        // Gate setzen, damit Echo-Messages <150ms ignoriert werden
        shouldApply(element.id, RT_PRI());

        sendRT({
          t: 'card_move',
          id: element.id,
          nx, ny,
          z: element.style.zIndex || '',
          prio: RT_PRI(),
          ts: Date.now()
        });
      });
    }

    
    // Für Karten, benutzerdefiniertes Drag-and-Drop implementieren
    if (element.classList.contains('card')) {
      // Standard Drag-Attribute entfernen
      element.removeAttribute('draggable');
      
      let isDragging = false;
      let offsetX, offsetY;
      let initialParent;
      let isHoveringOverStack = false; // Neuer Status für Hover über Stapel
      
      element.addEventListener('mousedown', function(e) {
        // Nur mit linker Maustaste
        if (e.button !== 0) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        // Initialen Elternelement speichern
        initialParent = element.parentNode;
        
        // Exakten Offset vom Klickpunkt zur Kartenecke berechnen
        const rect = element.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;

        // Karte nach vorne bringen – immer vor Focus Note/Notizzettel
        // Nutze den höchsten bekannten z-index oder mindestens 10001
        element.style.zIndex = Math.max(getHighestInteractiveZIndex() + 1, 1200);

        // WICHTIG: Wenn die Karte noch im Stapel ist, sofort ins Board umhängen,
        // damit sie nicht hinter Focus Note/Notizzettel verschwindet
        const cardStack = document.getElementById('card-stack');
        const boardArea = document.querySelector('.board-area');
        // ... im mousedown-Handler:
        if (initialParent === cardStack && boardArea) {
          const globalLeft = rect.left;
          const globalTop = rect.top;
          // Aus dem Stapel entfernen und dem Board hinzufügen
          try { cardStack.removeChild(element); } catch (_) {}
          boardArea.appendChild(element);
          // Position relativ zum Board setzen
          const boardRect = boardArea.getBoundingClientRect();
          element.style.position = 'absolute';
          element.style.left = (globalLeft - boardRect.left) + 'px';
          element.style.top  = (globalTop  - boardRect.top)  + 'px';

          // <<< 2d) RT einmalig senden – direkt nach dem Umhängen
          {
            const rect      = element.getBoundingClientRect();
            const stageRect = cardStageRect();
            const px = Math.round(rect.left - stageRect.left);
            const py = Math.round(rect.top  - stageRect.top);
            const { nx, ny } = toNormCard(px, py);
            shouldApply(element.id, RT_PRI());
            sendRT({
              t: 'card_move',
              id: element.id,
              nx, ny,
              z: element.style.zIndex || '',
              prio: RT_PRI(),
              ts: Date.now()
            });
          }
        }

        
        // Visuelles Feedback dass Karte gezogen wird
        element.classList.add('being-dragged');
        
        // Drag-Status aktivieren
        isDragging = true;
        
        // Event-Listener zum Dokument hinzufügen
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
      
      function onMouseMove(e) {
        if (!isDragging) return;
        e.preventDefault();
        
        // Elternelement-Grenzen abrufen
        const parentElement = element.parentNode;
        const parentRect = parentElement.getBoundingClientRect();
        
        // Neue Position relativ zum Elternelement berechnen
        const newX = e.clientX - parentRect.left - offsetX;
        const newY = e.clientY - parentRect.top - offsetY;
        
        // Neue Position setzen
        element.style.position = 'absolute';
        element.style.left = newX + 'px';
        element.style.top = newY + 'px';

        // pro Frame senden (~60fps)
        queueRTCardMove();
        
        // NEUE FUNKTIONALITÄT: Überprüfen, ob Karte über dem Stapel schwebt
        const cardStack = document.getElementById('card-stack');
        if (cardStack) {
          const cardRect = element.getBoundingClientRect();
          const stackRect = cardStack.getBoundingClientRect();
          
          // Prüfen, ob sich die Karte über dem Stapel befindet
          const isOverStack = (
            cardRect.right > stackRect.left &&
            cardRect.left < stackRect.right &&
            cardRect.bottom > stackRect.top &&
            cardRect.top < stackRect.bottom
          );
          
          // Status-Update und visuelles Feedback
          if (isOverStack && !isHoveringOverStack) {
            isHoveringOverStack = true;
            
            // Visuelles Feedback für den Stapel
            cardStack.classList.add('stack-hover');
            cardStack.style.boxShadow = '0 0 10px rgba(0, 255, 0, 0.5)';
            cardStack.style.transform = 'scale(1.05)';
            
            // Hinweis für den Nutzer
            showStackHoverTooltip("Loslassen, um Karte zum Stapel zurückzulegen");
          } 
          else if (!isOverStack && isHoveringOverStack) {
            isHoveringOverStack = false;
            
            // Visuelles Feedback entfernen
            cardStack.classList.remove('stack-hover');
            cardStack.style.boxShadow = '';
            cardStack.style.transform = '';
            
            // Tooltip entfernen
            hideStackHoverTooltip();
          }
        }
      }
      
      function onMouseUp(e) {
        if (!isDragging) return;
        
        // Drag-Status zurücksetzen
        isDragging = false;
        element.classList.remove('being-dragged');
        
        // Event-Listener entfernen
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        
        // NEUE FUNKTIONALITÄT: Wenn Karte über dem Stapel losgelassen wird
        const cardStack = document.getElementById('card-stack');
        if (cardStack && isHoveringOverStack) {
          // Visuelles Feedback entfernen
          cardStack.classList.remove('stack-hover');
          cardStack.style.boxShadow = '';
          cardStack.style.transform = '';
          hideStackHoverTooltip();
          
          // Karte zum Stapel zurücklegen
          console.log("Karte wird per Drag-and-Drop zum Stapel zurückgelegt");
          returnCardToStack(element);
          // Gate + Broadcast "sendback", damit alle den Rückleger sehen
          shouldApply(`sendback:${element.id}`, RT_PRI());
          sendRT({
            t: 'card_sendback',
            id: element.id,
            prio: RT_PRI(),
            ts: Date.now()
          });
          
          // Hover-Status zurücksetzen
          isHoveringOverStack = false;
          return;
        }

        // Ursprüngliche Funktionalität für Bewegung vom Stapel zum Board behalten
        const boardArea = document.querySelector('.board-area');
        if (initialParent === cardStack && cardStack.contains(element)) {
          // ... globalLeft/globalTop holen, umhängen, dann:
          element.style.position = 'absolute';
          element.style.left = (globalLeft - boardRect.left) + 'px';
          element.style.top  = (globalTop  - boardRect.top)  + 'px';

          // <<< 2d) RT einmalig senden – direkt nach dem Setzen der Board-Position
          {
            const rect      = element.getBoundingClientRect();
            const stageRect = cardStageRect();
            const px = Math.round(rect.left - stageRect.left);
            const py = Math.round(rect.top  - stageRect.top);
            const { nx, ny } = toNormCard(px, py);
            shouldApply(element.id, RT_PRI());
            sendRT({
              t: 'card_move',
              id: element.id,
              nx, ny,
              z: element.style.zIndex || '',
              prio: RT_PRI(),
              ts: Date.now()
            });
          }

          // Repaint
          element.offsetHeight;
        }

        // Nach dem Loslassen: z-index der Karte normalisieren, damit Notizzettel
        // beim Ziehen vorne liegen, Karten aber weiterhin über Fokus-/Notizzettelblock stehen.
        // Nicht normalisieren, wenn die Karte im Stapel liegt.
        if (!element.closest('#card-stack')) {
          normalizeCardZIndex(element);
        }

        // Board-Zustand speichern
        if (typeof saveCurrentBoardState === 'function') {
          {
          const px = parseFloat(element.style.left) || 0;
          const py = parseFloat(element.style.top)  || 0;
          const { nx, ny } = toNormCard(px, py);
          sendRT({
            t: 'card_move',
            id: element.id,
            nx, ny,
            z: element.style.zIndex || '',
            prio: RT_PRI(),
            ts: Date.now()
          });
        }
          saveCurrentBoardState();
        }
      }
      
      return;
    }
    
    // Bestehende Logik für andere Elemente beibehalten
    let startX, startY;
    let initialLeft, initialTop;
    
    element.onmousedown = function(e) {
      // Nur mit linker Maustaste
      if (e.button !== 0) return;
      
      // Wenn Element editierbar ist, nicht ziehen
      if (e.target.isContentEditable) {
        return;
      }
      
      // Bei aktivem Löschmodus nicht ziehen
      const trashCan = document.querySelector('.trash-container');
      if (trashCan && trashCan.classList.contains('deletion-mode')) {
        return;
      }
      
      e.preventDefault();
      
      // Element nach vorne bringen
      element.style.zIndex = getHighestInteractiveZIndex() + 1;
      
      // Startpositionen speichern
      startX = e.clientX;
      startY = e.clientY;
      
      // Aktuelle Element-Position
      initialLeft = parseInt(element.style.left) || 0;
      initialTop = parseInt(element.style.top) || 0;
      
      // Event-Handler hinzufügen
      document.addEventListener('mousemove', elementDrag);
      document.addEventListener('mouseup', closeDragElement);
    };
    
    function elementDrag(e) {
      e.preventDefault();

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Lokal bewegen
      element.style.left = (initialLeft + dx) + "px";
      element.style.top  = (initialTop  + dy) + "px";

      // Pro Frame (max ~60 FPS) RT senden
      queueRTCardMove();
    }
    
    function closeDragElement() {
      // Event-Handler entfernen
      // RT: card_move bei generischem Drag-Ende
      {
        if (_rtRaf) { cancelAnimationFrame(_rtRaf); _rtRaf = null; }
        _rtPending = false;

        const px = parseFloat(element.style.left) || 0;
        const py = parseFloat(element.style.top)  || 0;
        const { nx, ny } = toNormCard(px, py); // <<< Karten-Koordinaten!
        shouldApply(element.id, RT_PRI());      // Gate für Echos setzen
        sendRT({
          t: 'card_move',
          id: element.id,
          nx, ny,
          z: element.style.zIndex || '',
          prio: RT_PRI(),
          ts: Date.now()
        });
      }
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
        const sid = new URLSearchParams(location.search).get('id');
        if (sid && typeof captureBoardState === 'function' && navigator.sendBeacon) {
          const state = captureBoardState();
          const blob = new Blob([JSON.stringify({ session_id: Number(sid), state })], { type: 'application/json' });
          navigator.sendBeacon('/api/state', blob);
        }
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
    const notesArray = [];
    const notizElements = document.querySelectorAll('.notiz');
    
    notizElements.forEach(notiz => {
      // Modified to capture innerHTML and size
      const rect = notiz.getBoundingClientRect();
      const noteData = {
        id: notiz.id || 'note-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        content: notiz.querySelector('.notiz-content')?.innerHTML || '', // Changed from textContent to innerHTML
        left: notiz.style.left,
        top: notiz.style.top,
        zIndex: notiz.style.zIndex,
        backgroundColor: notiz.style.backgroundColor || '#ffff99',
        rotation: getComputedStyle(notiz).getPropertyValue('--rotation') || '0deg',
        width: (notiz.style.width && notiz.style.width.trim() !== '') ? notiz.style.width : Math.round(rect.width) + 'px',
        height: (notiz.style.height && notiz.style.height.trim() !== '') ? notiz.style.height : Math.round(rect.height) + 'px'
      };
      
      notesArray.push(noteData);
    });
    
    return notesArray;
  }   

  // Erfasst alle Karten und ihre Eigenschaften
  function captureAllCards(){
    const cardsArray = [];
    const cardElements = document.querySelectorAll('.card');

    cardElements.forEach(card => {
      const rawId  = card.id || '';
      const cardNum = (rawId.match(/card-?(\d+)/)?.[1]) || card.dataset.cardId || '';

      cardsArray.push({
        id: rawId,
        cardId: cardNum,
        left: card.style.left,
        top: card.style.top,
        zIndex: card.style.zIndex,
        isFlipped: card.classList.contains('flipped'),
        inStack: card.closest('#card-stack') !== null,
        placedAt: card.dataset.placedAt || null
      });
    });

    return cardsArray;
  }


  // Stellt den Board-Zustand wieder her
  function restoreBoardState(boardState) {
    if (!boardState) return false;
    
    console.log("Stelle Board-Zustand wieder her:", boardState);
    
    // Focus Note wiederherstellen
    restoreFocusNote(boardState.focusNote);
    
    // Notizen wiederherstellen
    restoreNotes(boardState.notes);
    
    // Karten wiederherstellen
    restoreCards(boardState.cards);
    
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

  // Stellt alle Notizzettel wieder her
  function restoreNotes(notes) {
    if (!notes || !notes.length) return;
    
    // Vorhandene Notizen entfernen
    document.querySelectorAll('.notiz').forEach(notiz => notiz.remove());
    
    // Neue Notizen erstellen
    notes.forEach(noteData => {
      const notiz = document.createElement('div');
      notiz.className = 'notiz';
      notiz.id = noteData.id;
      
      // Eigenschaften wiederherstellen
      notiz.style.left = noteData.left;
      notiz.style.top = noteData.top;
      notiz.style.zIndex = noteData.zIndex;
      notiz.style.backgroundColor = noteData.backgroundColor;
      notiz.style.setProperty('--rotation', noteData.rotation);
      if (noteData.width) notiz.style.width = noteData.width;
      if (noteData.height) notiz.style.height = noteData.height;
      
      // Inhalt wiederherstellen
      notiz.innerHTML = `
        <div class="notiz-content" contenteditable="false">${noteData.content}</div>
      `;
      
      // Zum Board hinzufügen
      document.body.appendChild(notiz);
      attachNoteResizeObserver(notiz);
      attachNoteAutoGrow(notiz);
      
      // Drag-and-Drop und Bearbeitungs-Handler hinzufügen
      makeDraggable(notiz);
      setupNoteEditingHandlers(notiz);
      enhanceDraggableNote(notiz);
    });
  }
  window.restoreNotes = restoreNotes;


  // Stellt alle Karten wieder her – ohne Animationen/Shuffle/Flip
  function restoreCards(cardsState) {
    if (!Array.isArray(cardsState) || !cardsState.length) return;

    const cardStack = document.getElementById('card-stack');
    const boardArea = document.querySelector('.board-area') || document.body;
    const total     = document.querySelectorAll('.card').length;

    // Mini-Helfer: kurzzeitig alle Transitions/Animationen deaktivieren
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
        fn();                  // Änderungen anwenden (ohne visuelle Effekte)
        void el.offsetWidth;   // Reflow erzwingen
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
      const num = normalizeCardId(cardData.id || cardData.cardId);
      if (!num || (total && num > total)) {
        console.warn('Karte existiert in diesem Deck nicht:', cardData.id || cardData.cardId);
        return;
      }

      const el = resolveCardElement(cardData);
      if (!el) {
        console.warn('Karte nicht gefunden:', cardData.id || cardData.cardId);
        return;
      }

      withoutAnimations(el, () => {
        // evtl. alte Animationsklassen entfernen
        el.classList.remove('returning', 'flipping', 'shuffling', 'remote-dragging', 'being-dragged');

        // Flip-Zustand stumpf setzen (keine Flip-Animation)
        if (typeof cardData.isFlipped === 'boolean') {
          el.classList.toggle('flipped', !!cardData.isFlipped);
        }

        if (cardData.inStack) {
          // → Karte gehört in den Stapel (sofort, ohne returnCardToStack)
          cleanPlaceholder(el);
          if (cardStack && !cardStack.contains(el)) {
            cardStack.appendChild(el);
          }

          // Z-Index aus Zustand respektieren (fällt zurück auf bestehenden)
          const zi = (cardData.zIndex !== undefined && cardData.zIndex !== '')
            ? parseInt(cardData.zIndex, 10)
            : parseInt(el.style.zIndex || '0', 10);

          if (!isNaN(zi)) el.style.zIndex = String(zi);

          // Versatz im Stapel (wie beim Erzeugen: 0.5px je Layer)
          const offset = Math.max(0, ((parseInt(el.style.zIndex || '1', 10) || 1) - 1) * 0.5);
          el.style.position = 'absolute';
          el.style.left = offset + 'px';
          el.style.top  = offset + 'px';

        } else {
          // → Karte liegt auf dem Board
          if (boardArea && !boardArea.contains(el)) {
            boardArea.appendChild(el);
          }

          if (cardData.left !== undefined && cardData.left !== '') el.style.left = cardData.left;
          if (cardData.top  !== undefined && cardData.top  !== '') el.style.top  = cardData.top;
          if (cardData.zIndex !== undefined && cardData.zIndex !== '') el.style.zIndex = cardData.zIndex;

          // Platzhalter-Status setzen/entfernen
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

    // Stapel im DOM optional nach Z-Index sortieren (unten→oben), ohne Animation
    if (cardStack) {
      const stackCards = Array.from(cardStack.querySelectorAll(':scope > .card'));
      stackCards
        .sort((a, b) => (parseInt(a.style.zIndex || '0', 10)) - (parseInt(b.style.zIndex || '0', 10)))
        .forEach(el => cardStack.appendChild(el));
    }

    // Signal für nachgelagerte UI-Aktualisierungen
    document.dispatchEvent(new Event('boardStateUpdated'));
  }
  window.restoreCards = restoreCards;


  // Erweiterte Funktion für den "Sitzung beenden" Button
  function setupSaveAndCloseButton() {
    // Automatisches Speichern in regelmäßigen Abständen
    const autoSaveInterval = setInterval(() => {
      saveCurrentBoardState();
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
      saveCurrentBoardState();
      // Kein Dialog nötig, da automatisch gespeichert wird
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
  const resolved = (typeof resolveBoardAndDeck === 'function')
    ? resolveBoardAndDeck()
    : { board: (window.boardType || 'board1'), deck: (window.deck || 'deck1') };

  window.boardType = resolved.board;
  window.deck      = resolved.deck;

  initializeBoard();     // <— fehlte, baut Stapel, Notizblock, Layout etc.

  // 2) Zustand aus DB wiederherstellen, sobald Karten existieren
  if (typeof waitForCards === 'function' && typeof loadSavedBoardState === 'function') {
    //waitForCards().then(() => { try { loadSavedBoardState(); } catch(e) { console.warn(e); } });
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

    // In board-interaction.js am Ende der DOMContentLoaded-Funktion
    window.addEventListener('beforeunload', function() {
    // Aktuellen Zustand speichern
    saveCurrentBoardState();
    
    // Markieren, dass das Dashboard neu geladen werden soll
    sessionStorage.setItem('dashboard_reload_requested', 'true');
  });


  // ---- Focus Note: Senden ------------------------------------------
  (function initFocusNoteSend(){
    // Das Eingabefeld der Focus-Note (id kann bei dir ein <textarea> ODER ein contenteditable sein)
    const focusEl = document.getElementById('focus-note-editable');
    if (!focusEl) return;

    // Echo-Schutz: Wenn wir programmgesteuert setzen, nicht erneut senden
    let _focusSetByRemote = false;
    function setFocusTextSilently(txt){
      _focusSetByRemote = true;
      if ('value' in focusEl) focusEl.value = txt;
      else focusEl.innerText = txt;
      // nach dem Setzen Flag in der nächsten Task wieder löschen
      queueMicrotask(()=>{ _focusSetByRemote = false; });
    }

    // Merke diese Setter-Funktion global (wir nutzen sie im Receiver)
    window.__ccSetFocusNote = setFocusTextSilently;
 
    let _deb = null;
    const handler = () => {
      if (_focusSetByRemote) return; // kein Echo
      clearTimeout(_deb);
      _deb = setTimeout(() => {
        const txt = ('value' in focusEl) ? focusEl.value : focusEl.innerText;
        sendRT({ t: 'focus_update', content: txt, prio: RT_PRI(), ts: Date.now() });
      }, 120);
    };

    // robust: auf mehreren Events lauschen
    ['input','keyup','change'].forEach(evt => {
      focusEl.addEventListener(evt, handler);
    });
  })();


});

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

