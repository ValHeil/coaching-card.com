// participant-join.js — owner-aware
// Signatur für Debug
// OWNER KILL SWITCH – läuft sofort beim Laden dieser Datei
(function () {
  var p = new URLSearchParams(location.search);
  var isOwner = p.get('owner') === '1';
  document.documentElement.setAttribute('data-ccs-owner', isOwner ? '1' : '0');
  if (!isOwner) return;
  var st = document.createElement('style');
  st.id = 'owner-hide-style';
  st.textContent =
    '[data-ccs-owner="1"] #participant-name-prompt,' +
    '[data-ccs-owner="1"] .participant-name-prompt-overlay,' +
    '[data-ccs-owner="1"] #session-password-prompt' +
    '{display:none!important;visibility:hidden!important}';
  document.head.appendChild(st);
})();

window.__PJ_VERSION__ = 'owner-aware-2';

// --------- kleine Helfer ---------
function qs() { return new URLSearchParams(window.location.search); }
function getOwnerFlag() { return qs().get('owner') === '1'; }
function getOwnerName() { return qs().get('n') || qs().get('name') || ''; }
function hideAllPrompts() {
  // Alle evtl. offenen Overlays entfernen
  ['participant-name-prompt', 'session-password-prompt'].forEach(id => {
    const el = document.getElementById(id);
    if (el) try { el.remove(); } catch {}
  });
  // safety: CSS-Regel setzen, falls ein älteres Script nachrendert
  if (!document.getElementById('owner-hide-style')) {
    const st = document.createElement('style');
    st.id = 'owner-hide-style';
    st.textContent = `
      [data-ccs-owner="1"] #participant-name-prompt,
      [data-ccs-owner="1"] .participant-name-prompt-overlay,
      [data-ccs-owner="1"] #session-password-prompt { display:none !important; visibility:hidden !important; }
    `;
    document.head.appendChild(st);
  }
  document.documentElement.setAttribute('data-ccs-owner', getOwnerFlag() ? '1' : '0');
}

function ensureOwnerUserInLocalStorage(name) {
  try {
    const cur = JSON.parse(localStorage.getItem('currentUser') || '{}');
    const finalName = name || cur.name || 'Owner';
    const id = cur && cur.id ? cur.id : ('owner-' + Math.random().toString(36).slice(2));
    const user = { id, name: finalName, role: 'owner' };
    localStorage.setItem('currentUser', JSON.stringify(user));
    return user;
  } catch { return null; }
}

function ensureOwnerInSessionParticipants(sessionId, ownerUser) {
  try {
    const key = 'kartensets_sessions';
    const sessions = JSON.parse(localStorage.getItem(key) || '[]');
    const idx = sessions.findIndex(s => String(s.id) === String(sessionId));
    if (idx < 0) return;
    const p = sessions[idx].participants || [];
    if (!p.find(x => x.role === 'owner')) {
      p.push({
        id: ownerUser.id,
        name: ownerUser.name,
        role: 'owner',
        joined: new Date().toISOString()
      });
      sessions[idx].participants = p;
      localStorage.setItem(key, JSON.stringify(sessions));
    }
  } catch {}
}

// ---------------- Passwort-Flow (bestehend) ----------------
function showPasswordPrompt(session) {
  // ... (dein bestehender Code bleibt hier unverändert)
}

// ---------------- Teilnehmer-Flow (bestehend) ----------------
function showParticipantNamePrompt(session) {
  var isOwner = new URLSearchParams(location.search).get('owner') === '1';
  if (isOwner) { return true; }
  // Vorhandene Abfrage entfernen
  const existingPrompt = document.getElementById('participant-name-prompt');
  if (existingPrompt) existingPrompt.remove();

  const promptContainer = document.createElement('div');
  promptContainer.id = 'participant-name-prompt';
  promptContainer.className = 'participant-name-prompt-overlay';
  promptContainer.innerHTML = `
    <div class="participant-name-prompt-dialog">
      <h2>Namen für die Sitzung eingeben</h2>
      <p>Bitte geben Sie Ihren Namen ein, unter dem Sie an der Sitzung teilnehmen möchten:</p>
      <div class="name-input-container">
        <input type="text" id="participant-name-input" placeholder="Ihr Name" required>
        <span id="name-error" class="name-error"></span>
      </div>
      <div class="participant-name-buttons">
        <button id="submit-name" class="submit-button">Beitreten</button>
      </div>
    </div>
  `;
  document.body.appendChild(promptContainer);

  const input = document.getElementById('participant-name-input');
  input.focus();
  document.getElementById('submit-name').addEventListener('click', () => {
    const name = input.value.trim();
    if (!name) {
      document.getElementById('name-error').textContent = "Bitte geben Sie einen Namen ein.";
      return;
    }
    const tempUser = {
      id: 'participant-' + Date.now() + Math.random().toString(36).substr(2, 5),
      name
    };
    localStorage.setItem('currentUser', JSON.stringify(tempUser));
    promptContainer.remove();
    joinSession(session);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('submit-name').click(); });
}

function joinSession(session) {
  try {
    let currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
    const exists = session.participants?.find(p => p.id === currentUser.id);
    if (!exists) {
      const participants = session.participants || [];
      participants.push({ id: currentUser.id, name: currentUser.name, role: 'participant', joined: new Date().toISOString() });
      const key = 'kartensets_sessions';
      const sessions = JSON.parse(localStorage.getItem(key) || '[]');
      const updated = sessions.map(s => String(s.id) === String(session.id)
        ? { ...s, participants, lastEdited: new Date().toISOString() }
        : s
      );
      localStorage.setItem(key, JSON.stringify(updated));
    }
    console.log(`Benutzer ${currentUser.name} (${currentUser.id}) ist der Sitzung beigetreten`);
    return true;
  } catch (err) {
    console.error("Fehler beim Beitritt zur Sitzung:", err);
    return false;
  }
}

function addParticipantNamePromptStyles() {
  if (!document.getElementById('participant-name-prompt-styles')) {
    const style = document.createElement('style');
    style.id = 'participant-name-prompt-styles';
    style.textContent = `
      .participant-name-prompt-overlay { position:fixed; inset:0; background:rgba(0,0,0,.7); display:flex; justify-content:center; align-items:center; z-index:2000; }
      .participant-name-prompt-dialog { background:#fff; border-radius:10px; padding:25px; width:90%; max-width:400px; box-shadow:0 10px 25px rgba(0,0,0,.2); }
      .participant-name-buttons { display:flex; justify-content:center; }
      .submit-button { padding:10px 20px; border-radius:4px; cursor:pointer; border:0; background:#ff8581; color:#fff; font-weight:700; }
    `;
    document.head.appendChild(style);
  }
}

// ---------------- zentrale Steuerung ----------------
// WICHTIG: Diese Funktion wird von board-interaction.js beim Laden aufgerufen.
// Teilnehmer-Join: zeigt einfach den Namens-Prompt und lässt das Board weiterladen
function handleParticipantJoin(session) {
  try {
    if (typeof addParticipantNamePromptStyles === 'function') addParticipantNamePromptStyles();
    if (typeof showParticipantNamePrompt === 'function') showParticipantNamePrompt(session);
  } catch (e) { console.error(e); }
  return true; // Board darf weiter initialisieren, Overlay liegt oben drüber
}

function handleSessionJoin() {
  const url = qs();
  const owner = getOwnerFlag();
  const ownerName = getOwnerName();

  // Session-ID: aus ?id=... oder (wenn dein Token-Host sowas setzt) aus CC_BOOT
  const sid = url.get('id') || (window.CC_BOOT && window.CC_BOOT.session && window.CC_BOOT.session.id);
  if (!sid) {
    if (typeof showError === 'function') showError("Ungültiger Link: Keine Sitzungs-ID gefunden.");
    else alert("Ungültiger Link: Keine Sitzungs-ID gefunden.");
    return false;
  }

  // --- OWNER-PFAD: kein Prompt, Name aus n=
  if (owner) {
    hideAllPrompts();
    const user = ensureOwnerUserInLocalStorage(ownerName);
    ensureOwnerInSessionParticipants(sid, user || { id: 'owner', name: ownerName || 'Owner', role: 'owner' });
    // für CSS/Debug
    document.documentElement.setAttribute('data-ccs-owner', '1');
    return true; // sofort durchwinken
  }

  // --- GAST-PFAD (alter Flow bleibt)
  const isJoining = url.get('join') === 'true';
  // Sitzungsdaten aus localStorage (wie bisher)
  const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
  const session  = sessions.find(s => String(s.id) === String(sid));
  if (!session) {
    if (typeof showError === 'function') showError("Die angeforderte Sitzung existiert nicht.");
    else console.error("Die angeforderte Sitzung existiert nicht.");
    return false;
  }

  if (isJoining) return handleParticipantJoin(session);
  return true; // normales Öffnen ohne Prompt
}

// Exporte ins Window (wie gehabt)
window.handleSessionJoin = handleSessionJoin;
window.handleParticipantJoin = handleParticipantJoin;
window.showParticipantNamePrompt = showParticipantNamePrompt;
window.addParticipantNamePromptStyles = addParticipantNamePromptStyles;
window.joinSession = joinSession;
window.handleSessionJoinOwnerAware = handleSessionJoin;
// Fallback showError
window.showError = window.showError || function(msg){ console.error(msg); };
