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

function hashState(state) {
  try { return JSON.stringify(state); } catch { return String(Date.now()); }
}

async function _doSave(reason = 'auto') {
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
    return true;
  } finally {
    _saveInFlight = false;
  }
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

// wartet bis der Stapel und mind. 1 Karte existiert
async function waitForCards(maxMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (document.getElementById('card-stack') &&
        document.querySelectorAll('.card').length) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
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

/* --- REPLACE: handleSessionJoin (alte Version komplett ersetzen) -------- */
function handleSessionJoin() {
  const url = new URLSearchParams(location.search);
  const sid = url.get('id');
  if (!sid) { showError('Ungültiger Link: Keine Sitzungs-ID gefunden.'); return false; }

  const sess = (window.CC_BOOT && window.CC_BOOT.session) || {};
  const effectiveBoard = canonBoardSlug(url.get('board') || window.CC_BOOT?.board || sess.board || 'board1');

  window.sessionData = {
    id: sid,
    name: sess.name || 'Sitzung',
    boardId: effectiveBoard,
    participants: [] // optional, wenn du später per REST nachlädst
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
      name: window.CC_BOOT?.session?.name || 'Sitzung'
    };
    window.boardType = effBoard;

    // Titel setzen
    if (boardTitle) boardTitle.textContent = window.CC_BOOT?.session?.name || window.sessionData.name || 'Sitzung';
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
      
      document.querySelector('.board-footer').appendChild(newEndSessionBtn);
      
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
  function returnCardToStack(card) {
    if (!card) return;
  
    // Karte zum Stapel zurückbewegen
    const cardStack = document.getElementById('card-stack');
    const boardArea = document.querySelector('.board-area');
  
    if (cardStack) {
      // Falls die Karte aufgedeckt war, wieder umdrehen
      if (card.classList.contains('flipped')) {
        // Kurze Animation für das Umdrehen
        card.classList.add('flipping');
        setTimeout(() => {
          card.classList.remove('flipping');
          card.classList.remove('flipped');
        }, 500);
      }
      
      // WICHTIG: Wenn die Karte nicht bereits im Stapel ist, füge sie hinzu
      if (!cardStack.contains(card)) {
        console.log(`Karte ${card.id} wird zum Stapel zurückgelegt`);
        // Vom aktuellen Elternelement entfernen
        if (card.parentNode) {
          card.parentNode.removeChild(card);
        }
        
        // Karte UNTEN auf den Stapel legen (als erstes Kind einfügen)
        if (cardStack.firstChild) {
          cardStack.insertBefore(card, cardStack.firstChild);
        } else {
          cardStack.appendChild(card);
        }
      }
      
      // Alle Karten im Stapel zählen
      const stackCards = cardStack.querySelectorAll(':scope > .card');
      
      // Alle Karten neu positionieren und Z-Indices aktualisieren
      stackCards.forEach((stackCard, index) => {
        const offset = index * 0.5;
        stackCard.style.left = `${offset}px`;
        stackCard.style.top = `${offset}px`;
        stackCard.style.zIndex = index + 1; // Z-Index basierend auf Position im Stapel
      });
    }
    
    // Board-Zustand speichern
    if (typeof saveCurrentBoardState === 'function') {
      saveCurrentBoardState();
    }
  }

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
          shuffleCards();
        }
        return;
      }

      // B: nur Karte direkt unter dem Cursor zurück zum Stapel
      if (key === 'b') {
        e.stopImmediatePropagation();
        if (window.hoveredCard) {
          returnCardToStack(window.hoveredCard);
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
    document.addEventListener('click', (e) => {
      if (!notiz.contains(e.target) && content.getAttribute('contenteditable') === 'true') {
        content.setAttribute('contenteditable', 'false');
        
        // Visuelle Rückmeldung entfernen
        content.classList.remove('editing');
        content.classList.remove('blinking-cursor');
        notiz.classList.remove('is-editing');
        
        // Bearbeitungsindikator entfernen
        const indicator = notiz.querySelector('.editing-indicator');
        if (indicator) {
          indicator.remove();
        }
        
        // Wenn der Inhalt nach dem Bearbeiten leer ist, entferne den Notizzettel
        if (content.textContent.trim() === '') {
          notiz.remove();
          notes = notes.filter(n => n !== notiz);
        } else{
          saveCurrentBoardState();
        }
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
    
    note.addEventListener('mousedown', function(e) {
      // Nur mit linker Maustaste
      if (e.button !== 0) return;
      
      // Wenn im Bearbeitungsmodus oder im Löschmodus, nicht ziehen
      if (e.target.isContentEditable) return;
      const trashCan = document.querySelector('.trash-container');
      if (trashCan && trashCan.classList.contains('deletion-mode')) return;
      
      // Speichere die Zeit des mousedown Events um später zu erkennen,
      // ob es ein Doppelklick war oder ein Drag
      mouseDownTime = Date.now();
      hasMoved = false;
      
      // WICHTIG: NICHT e.stopPropagation() aufrufen, damit
      // der Doppelklick durchkommt!
      e.preventDefault(); // Nur preventDefault ist OK
      
      // Exakten Offset vom Klickpunkt zur Notizecke berechnen
      const rect = note.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      
      // Startposition speichern für möglichen Mülleimer-Check später
      initialX = rect.left;
      initialY = rect.top;
      
      // Notiz nach vorne bringen
      note.style.zIndex = Math.max(getHighestInteractiveZIndex() + 1, 1200);
      
      // Ziehen noch NICHT starten - warten, ob es ein Doppelklick ist
      
      // Event-Listener zum Dokument hinzufügen
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
    
    function onMouseMove(e) {
      // Erst wenn etwas Bewegung stattgefunden hat, das Dragging starten
      if (!hasMoved) {
        hasMoved = true;
        isDragging = true;
        // Jetzt erst visuelles Feedback hinzufügen
        note.classList.add('being-dragged');
      }
      
      if (!isDragging) return;
      e.preventDefault();
      
      // Neue Position relativ zum Elternelement berechnen
      const parentRect = note.parentNode.getBoundingClientRect();
      // Positionen auf ganze Pixel runden, um subpixeliges Rendering zu vermeiden
      const newX = Math.round(e.clientX - parentRect.left - offsetX);
      const newY = Math.round(e.clientY - parentRect.top - offsetY);
      
      // Neue Position setzen
      note.style.position = 'absolute';
      note.style.left = newX + 'px';
      note.style.top = newY + 'px';
      
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
          
          // Board-Zustand speichern
          if (typeof saveCurrentBoardState === 'function') {
            saveCurrentBoardState();
          }
        }, 300);
        
        isDraggingForTrash = false;
        return;
      }
      
      // Board-Zustand nach dem Verschieben speichern
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
  const shuffleCards = () => {
    // Den Kartenstapel Element finden
    const cardStack = document.getElementById('card-stack');
    if (!cardStack) return;
    
    // Nur Karten direkt im Stapel selektieren
    const stackCardElements = cardStack.querySelectorAll(':scope > .card');
    
    // Wenn keine Karten im Stapel sind, beenden
    if (stackCardElements.length === 0) {
      console.log("Keine Karten zum Mischen im Stapel vorhanden");
      return;
    }
    
    // Konvertiere NodeList zu Array für bessere Handhabung
    const stackCards = Array.from(stackCardElements);
    console.log(`${stackCards.length} Karten im Stapel zum Mischen gefunden`);
    
    // Kurze Animation für jede Karte hinzufügen
    stackCards.forEach(card => {
      card.classList.add('shuffling');
      setTimeout(() => card.classList.remove('shuffling'), 500);
    });
    
    // Sound abspielen
    if (shuffleSound) {
      shuffleSound.currentTime = 0;
      shuffleSound.play().catch(e => console.log('Audio konnte nicht abgespielt werden:', e));
    }
  
    // WICHTIG: Alle Karten vom Stack entfernen, damit wir sie in neuer Reihenfolge hinzufügen können
    stackCards.forEach(card => cardStack.removeChild(card));
    
    // Fisher-Yates Shuffle-Algorithmus
    for (let i = stackCards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [stackCards[i], stackCards[j]] = [stackCards[j], stackCards[i]];
    }
    
    // Karten in der gemischten Reihenfolge wieder hinzufügen
    stackCards.forEach((card, index) => {
      // Umgedrehte Karten zurückdrehen
      if (card.classList.contains('flipped')) {
        card.classList.remove('flipped');
      }
      
      // Karte zum Stapel hinzufügen
      cardStack.appendChild(card);
      
      // Position im Stapel mit leichtem Versatz
      const offset = index * 0.5;
      card.style.position = 'absolute';
      card.style.left = `${offset}px`;
      card.style.top = `${offset}px`;
      card.style.zIndex = index + 1;
    });
    
    // Speichern des Board-Zustands nach dem Mischen
    saveCurrentBoardState();
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
    contextMenu.style.top = `${event.clientY}px`;
    
    // Menü für Karten
    contextMenu.innerHTML = `
      <ul>
        <li class="flip-card">Karte umdrehen (F)</li>
        <li class="reset-card">Zurück zum Stapel (B)</li>
        <li class="shuffle-cards">Karten mischen (M)</li>
      </ul>
    `;
    
    document.body.appendChild(contextMenu);
    
    // Event-Listener für Menüaktionen
    contextMenu.querySelector('.flip-card').addEventListener('click', () => {
      flipCard(card);
      contextMenu.remove();
    });
    
    contextMenu.querySelector('.reset-card').addEventListener('click', () => {
      returnCardToStack(card);
      contextMenu.remove();
    });
    
    contextMenu.querySelector('.shuffle-cards').addEventListener('click', () => {
      shuffleCards();
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
        target.remove();
        notes = notes.filter(n => n !== target);
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
        if (initialParent === cardStack && boardArea) {
          const globalLeft = rect.left;
          const globalTop = rect.top;
          // Aus dem Stapel entfernen und dem Board hinzufügen
          try { cardStack.removeChild(element); } catch (_) {}
          boardArea.appendChild(element);
          // Position relativ zum Board setzen, um keine "Sprünge" zu erzeugen
          const boardRect = boardArea.getBoundingClientRect();
          element.style.position = 'absolute';
          element.style.left = (globalLeft - boardRect.left) + 'px';
          element.style.top = (globalTop - boardRect.top) + 'px';
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
          
          // Hover-Status zurücksetzen
          isHoveringOverStack = false;
          return;
        }

        // Ursprüngliche Funktionalität für Bewegung vom Stapel zum Board behalten
        const boardArea = document.querySelector('.board-area');
        if (initialParent === cardStack && cardStack.contains(element)) {
          // Berechnen, ob Karte weit genug vom Stapel weggezogen wurde
          const stackRect = cardStack.getBoundingClientRect();
          const cardRect = element.getBoundingClientRect();
          
          const distanceX = Math.abs(cardRect.left - stackRect.left);
          const distanceY = Math.abs(cardRect.top - stackRect.top);
          
          if (distanceX > element.offsetWidth / 2 || distanceY > element.offsetHeight / 2) {
            // WICHTIG: Globale Position berechnen, bevor das Elternelement geändert wird
            const globalLeft = cardRect.left;
            const globalTop = cardRect.top;
            
            // Karte vom Stapel entfernen
            cardStack.removeChild(element);
            
            // Zum Board hinzufügen
            boardArea.appendChild(element);
            
            // Board-Position abrufen
            const boardRect = boardArea.getBoundingClientRect();
            
            // Position relativ zum neuen Elternelement berechnen und sofort anwenden
            element.style.position = 'absolute';
            element.style.left = (globalLeft - boardRect.left) + 'px';
            element.style.top = (globalTop - boardRect.top) + 'px';
            
            // Browser-Repaint erzwingen, um Flackern zu vermeiden
            element.offsetHeight;
          }
        }

        // Nach dem Loslassen: z-index der Karte normalisieren, damit Notizzettel
        // beim Ziehen vorne liegen, Karten aber weiterhin über Fokus-/Notizzettelblock stehen.
        // Nicht normalisieren, wenn die Karte im Stapel liegt.
        if (!element.closest('#card-stack')) {
          normalizeCardZIndex(element);
        }

        // Board-Zustand speichern
        if (typeof saveCurrentBoardState === 'function') {
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
      
      // Neue Position basierend auf Startpunkt und Bewegung berechnen
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      
      // Neue Position direkt setzen
      element.style.left = (initialLeft + dx) + "px";
      element.style.top = (initialTop + dy) + "px";
    }
    
    function closeDragElement() {
      // Event-Handler entfernen
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

        // 1) Speichern "fire-and-forget"
      try {
        const sid = new URLSearchParams(location.search).get('id');
        const state = (typeof captureBoardState === 'function') ? captureBoardState() : null;
        if (sid && state) {
          if (navigator.sendBeacon) {
            const payload = new Blob([JSON.stringify({ session_id: Number(sid), state })], { type: 'application/json' });
            navigator.sendBeacon('/api/state', payload);
          } else {
            fetch('/api/state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session_id: Number(sid), state }),
              keepalive: true
            }).catch(()=>{});
          }
        }

        // 2) Opener & Broadcast sofort informieren
        try { new BroadcastChannel('cc-close').postMessage({ t: 'CC_REQUEST_CLOSE', sid }); } catch {}
        try { if (window.opener && !window.opener.closed) window.opener.postMessage({ t: 'CC_REQUEST_CLOSE', sid }, '*'); } catch {}

        // 3) Entscheidend: direkt schließen (noch im User-Click-Stack)
        let closed = false;
        try { window.close(); closed = window.closed; } catch {}
        if (!closed) {
          try { window.open('', '_self'); window.close(); closed = window.closed; } catch {}
        }
      } catch (_) {}
    });

  }

  // Funktion, um den "Sitzung beenden" Button zu aktualisieren
  function setupEndSessionButton() {
    const newCloseSessionBtn = closeSessionBtn.cloneNode(true);
    closeSessionBtn.parentNode.replaceChild(newCloseSessionBtn, closeSessionBtn);

    newCloseSessionBtn.addEventListener('click', () => {
        if (saveCurrentBoardState()){
          createEndSessionDialog();
        } else {
          alert("Es gab ein Problem beim Speichern der SItzung. Möchten sie trotzdem fortfahren?")
        }
    });
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

  // Stellt alle Karten wieder her
  function restoreCards(cardsState) {
    if (!Array.isArray(cardsState) || !cardsState.length) return;

    const cardStack = document.getElementById('card-stack');
    const boardArea = document.querySelector('.board-area');
    const total = document.querySelectorAll('.card').length;

    cardsState.forEach((cardData) => {
      const num = normalizeCardId(cardData.id || cardData.cardId);
      if (!num || (total && num > total)) {
        console.warn('Karte existiert in diesem Deck nicht:', cardData.id || cardData.cardId);
        return;
      }

      const el = resolveCardElement(cardData);
      if (!el) {
        console.warn('Karte nicht gefunden:', cardData.id || cardData.cardId);
        return; // forEach → return überspringt nur dieses Element
      }

      // Position/Z-Index
      if (cardData.left)   el.style.left   = cardData.left;
      if (cardData.top)    el.style.top    = cardData.top;
      if (cardData.zIndex) el.style.zIndex = cardData.zIndex;

      // Flip anpassen
      if (typeof cardData.isFlipped === 'boolean') {
        const isFlipped = el.classList.contains('flipped');
        if (cardData.isFlipped !== isFlipped && typeof flipCard === 'function') {
          flipCard(el);
        }
      }

      // Zwischen Stapel ↔ Board umhängen
      if (cardData.inStack === false && cardStack?.contains(el)) {
        cardStack.removeChild(el);
        boardArea?.appendChild(el);
      } else if (cardData.inStack === true && boardArea?.contains(el)) {
        returnCardToStack?.(el);
      }

      // Platzhalter-Status
      if (cardData.placedAt) {
        el.dataset.placedAt = cardData.placedAt;
        const ph = document.getElementById(cardData.placedAt);
        if (ph) ph.classList.add('filled');
      }
    });

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

  function setupAutoSave() {
    const autoSaveInterval = setInterval(async () => {
      try {
        const sid = new URLSearchParams(location.search).get('id');
        if (!sid) return;
        await persistStateToServer(captureBoardState());
        console.log('[Autosave] Zustand in DB gespeichert');
      } catch(e) {
        console.warn('[Autosave] Fehler:', e);
      }
    }, 60000); // alle 60s

    // Verlassen der Seite: möglichst zuverlässig speichern
    window.addEventListener('beforeunload', () => {
      try {
        const sid = new URLSearchParams(location.search).get('id');
        if (!sid || !navigator.sendBeacon) return;
        const payload = new Blob(
          [JSON.stringify({ session_id: Number(sid), state: captureBoardState() })],
          { type: 'application/json' }
        );
        navigator.sendBeacon('/api/state', payload);
      } catch {}
    });

    // Ctrl/Cmd+S
    document.addEventListener('keydown', async (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const sid = new URLSearchParams(location.search).get('id');
        if (!sid) return;
        const ok = await persistStateToServer(captureBoardState());
        if (ok) showSaveNotification('Board in DB gespeichert');
      }
    });

    return autoSaveInterval;
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
    waitForCards().then(() => { try { loadSavedBoardState(); } catch(e) { console.warn(e); } });
  }

  // UI-Helfer
  addSaveToastStyles();

  // 3) Autosave NACH dem Aufbau starten (sonst speicherst du leere Zustände)
  const autoSaveInterval = setupAutoSave();

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
});

// Am Ende der Datei hinzufügen
window.handleSessionJoin = handleSessionJoin;
window.handleParticipantJoin = handleParticipantJoin;
window.showParticipantNamePrompt = showParticipantNamePrompt;
window.showPasswordPrompt = showPasswordPrompt;
window.addPasswordPromptStyles = addPasswordPromptStyles;
window.addParticipantNamePromptStyles = addParticipantNamePromptStyles;
window.joinSession = joinSession;

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

