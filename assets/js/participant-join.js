// Handled die Beitrittslogik, wenn jemand über einen Teilnahmelink beitritt
function handleSessionJoin() {
  // URL-Parameter auslesen
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('id');
  const isJoining = urlParams.get('join') === 'true';
  
  if (!sessionId) {
    showError("Ungültiger Link: Keine Sitzungs-ID gefunden.");
    return false;
  }
  
  // Sitzungsdaten laden
  const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
  const session = sessions.find(s => s.id === sessionId);
  
  if (!session) {
    showError("Die angeforderte Sitzung existiert nicht.");
    return false;
  }
  
  // Wenn es ein Beitritt ist (über einen Teilnehmerlink)
  if (isJoining) {
    return handleParticipantJoin(session);
  }
  
  // Normale Sitzungsöffnung (eigene Sitzung)
  return true;
}

// Handled den Beitritt eines Teilnehmers
function handleParticipantJoin(session) {
  // Prüfen, ob ein Passwort erforderlich ist
  if (session.password) {
    showPasswordPrompt(session);
    return false; // Verzögerte Verarbeitung nach Passworteingabe
  }
  
  // Kein Passwort erforderlich, Teilnehmer-Namen abfragen
  showParticipantNamePrompt(session);
  return false; // Verzögerte Verarbeitung
}

// Zeigt eine Eingabeaufforderung für den Teilnehmernamen an
function showParticipantNamePrompt(session) {
  // Vorhandene Abfrage entfernen
  const existingPrompt = document.getElementById('participant-name-prompt');
  if (existingPrompt) {
    existingPrompt.remove();
  }
  
  // Namenseingabe-Prompt erstellen
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
  
  // Fokus auf das Namenseingabefeld setzen
  const nameInput = document.getElementById('participant-name-input');
  nameInput.focus();
  
  // Event-Listener für den Submit-Button
  document.getElementById('submit-name').addEventListener('click', () => {
    const name = nameInput.value.trim();
    
    if (!name) {
      const nameError = document.getElementById('name-error');
      nameError.textContent = "Bitte geben Sie einen Namen ein.";
      return;
    }
    
    // Einen temporären Benutzer erstellen
    const tempUser = {
      id: 'participant-' + Date.now() + Math.random().toString(36).substr(2, 5),
      name: name
    };
    
    // Temporären Benutzer im localStorage speichern
    localStorage.setItem('currentUser', JSON.stringify(tempUser));
    
    // Prompt entfernen
    promptContainer.remove();
    
    // Der Sitzung beitreten
    joinSession(session);
  });
  
  // Namen mit Enter bestätigen
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('submit-name').click();
    }
  });
}

// Tritt einer Sitzung bei
function joinSession(session) {
  try {
    // Aktuellen Benutzer holen (der soeben erstellte temporäre Benutzer)
    let currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
    
    // Prüfen, ob der Benutzer bereits Teilnehmer ist
    const existingParticipant = session.participants?.find(p => p.id === currentUser.id);
    if (!existingParticipant) {
      // Benutzer zur Teilnehmerliste hinzufügen
      const participants = session.participants || [];
      participants.push({
        id: currentUser.id,
        name: currentUser.name,
        role: 'participant',
        joined: new Date().toISOString()
      });
      
      // Sitzung aktualisieren
      const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
      const updatedSessions = sessions.map(s => {
        if (s.id === session.id) {
          return { ...s, participants, lastEdited: new Date().toISOString() };
        }
        return s;
      });
      
      localStorage.setItem('kartensets_sessions', JSON.stringify(updatedSessions));
    }
    
    // Beitritt erfolgreich
    console.log(`Benutzer ${currentUser.name} (${currentUser.id}) ist der Sitzung beigetreten`);
    return true;
  } catch (error) {
    console.error("Fehler beim Beitritt zur Sitzung:", error);
    return false;
  }
}

// CSS für die Teilnehmer-Namenseingabe hinzufügen
function addParticipantNamePromptStyles() {
  if (!document.getElementById('participant-name-prompt-styles')) {
    const style = document.createElement('style');
    style.id = 'participant-name-prompt-styles';
    style.textContent = `
      .participant-name-prompt-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(0, 0, 0, 0.7);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 2000;
        animation: fade-in 0.3s ease;
      }
      
      .participant-name-prompt-dialog {
        background-color: white;
        border-radius: 10px;
        padding: 25px;
        width: 90%;
        max-width: 400px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
        animation: slide-up 0.3s ease;
      }
      
      .participant-name-prompt-dialog h2 {
        margin-top: 0;
        margin-bottom: 15px;
        color: #333;
        font-size: 22px;
        text-align: center;
      }
      
      .participant-name-prompt-dialog p {
        margin-bottom: 20px;
        color: #555;
        line-height: 1.5;
        text-align: center;
      }
      
      .name-input-container {
        margin-bottom: 20px;
      }
      
      #participant-name-input {
        width: 100%;
        padding: 12px;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 16px;
        margin-bottom: 8px;
      }
      
      #participant-name-input:focus {
        border-color: #ff8581;
        outline: none;
        box-shadow: 0 0 0 3px rgba(255, 133, 129, 0.2);
      }
      
      .name-error {
        color: #d9534f;
        font-size: 14px;
        display: block;
        min-height: 20px;
        text-align: center;
      }
      
      .participant-name-buttons {
        display: flex;
        justify-content: center;
      }
      
      .submit-button {
        padding: 10px 20px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 15px;
        border: none;
        background-color: #ff8581;
        color: white;
        font-weight: bold;
        transition: all 0.2s ease;
      }
      
      .submit-button:hover {
        background-color: #ff6b66;
        transform: translateY(-2px);
        box-shadow: 0 3px 8px rgba(255, 133, 129, 0.3);
      }
      
      @keyframes fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      
      @keyframes slide-up {
        from { transform: translateY(30px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }
}

function addPasswordPromptStyles() {
  if (!document.getElementById('password-prompt-styles')) {
    const style = document.createElement('style');
    style.id = 'password-prompt-styles';
    style.textContent = `
      .password-prompt-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(0, 0, 0, 0.7);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 2000;
        animation: fade-in 0.3s ease;
      }
      
      .password-prompt-dialog {
        background-color: white;
        border-radius: 10px;
        padding: 25px;
        width: 90%;
        max-width: 400px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
        animation: slide-up 0.3s ease;
      }
      
      .password-prompt-dialog h2 {
        margin-top: 0;
        margin-bottom: 15px;
        color: #333;
        font-size: 22px;
        text-align: center;
      }
      
      .password-prompt-dialog p {
        margin-bottom: 20px;
        color: #555;
        line-height: 1.5;
        text-align: center;
      }
      
      .password-input-container {
        margin-bottom: 20px;
      }
      
      #session-password-input {
        width: 100%;
        padding: 12px;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 16px;
        margin-bottom: 8px;
      }
      
      #session-password-input:focus {
        border-color: #ff8581;
        outline: none;
        box-shadow: 0 0 0 3px rgba(255, 133, 129, 0.2);
      }
      
      .password-error {
        color: #d9534f;
        font-size: 14px;
        display: block;
        min-height: 20px;
        text-align: center;
      }
      
      .password-buttons {
        display: flex;
        justify-content: center;
        gap: 10px;
      }
      
      .submit-button, .cancel-button {
        padding: 10px 20px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 15px;
        border: none;
        transition: all 0.2s ease;
      }
      
      .submit-button {
        background-color: #ff8581;
        color: white;
        font-weight: bold;
      }
      
      .cancel-button {
        background-color: #f0f0f0;
        color: #333;
      }
      
      .submit-button:hover {
        background-color: #ff6b66;
        transform: translateY(-2px);
        box-shadow: 0 3px 8px rgba(255, 133, 129, 0.3);
      }
      
      .cancel-button:hover {
        background-color: #e0e0e0;
      }
      
      @keyframes fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      
      @keyframes slide-up {
        from { transform: translateY(30px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }
}

// Funktion zum Anzeigen des Passwort-Prompts
function showPasswordPrompt(session) {
  // Vorhandene Abfrage entfernen
  const existingPrompt = document.getElementById('password-prompt');
  if (existingPrompt) {
    existingPrompt.remove();
  }
  
  // Passwort-Prompt erstellen
  const promptContainer = document.createElement('div');
  promptContainer.id = 'password-prompt';
  promptContainer.className = 'password-prompt-overlay';
  
  promptContainer.innerHTML = `
    <div class="password-prompt-dialog">
      <h2>Sitzungspasswort erforderlich</h2>
      <p>Diese Sitzung ist passwortgeschützt. Bitte geben Sie das Passwort ein:</p>
      <div class="password-input-container">
        <input type="password" id="session-password-input" placeholder="Passwort" required>
        <span id="password-error" class="password-error"></span>
      </div>
      <div class="password-buttons">
        <button id="cancel-password" class="cancel-button">Abbrechen</button>
        <button id="submit-password" class="submit-button">Beitreten</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(promptContainer);
  
  // Fokus auf das Passwort-Eingabefeld setzen
  const passwordInput = document.getElementById('session-password-input');
  passwordInput.focus();
  
  // Event-Listener für den Abbrechen-Button
  document.getElementById('cancel-password').addEventListener('click', () => {
    promptContainer.remove();
    // Optional: Zurück zur vorherigen Seite oder Startseite
    window.location.href = '/kartensets/dashboard/';
  });
  
  // Event-Listener für den Submit-Button
  document.getElementById('submit-password').addEventListener('click', () => {
    const passwordInput = document.getElementById('session-password-input');
    const passwordError = document.getElementById('password-error');
    const password = passwordInput.value.trim();
    
    // Passwort validieren
    if (!password) {
      passwordError.textContent = "Bitte geben Sie das Passwort ein.";
      return;
    }
    
    // Passwort überprüfen
    if (session.password === password) {
      // Passwort korrekt
      promptContainer.remove();
      
      // Teilnehmer-Namen abfragen
      showParticipantNamePrompt(session);
    } else {
      // Falsches Passwort
      passwordError.textContent = "Falsches Passwort. Bitte versuchen Sie es erneut.";
      passwordInput.value = '';
      passwordInput.focus();
    }
  });
  
  // Passwort mit Enter bestätigen
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('submit-password').click();
    }
  });
}

// Handled die Beitrittslogik, wenn jemand über einen Teilnahmelink beitritt
function handleSessionJoin() {
  // URL-Parameter auslesen
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('id');
  const isJoining = urlParams.get('join') === 'true';
  
  if (!sessionId) {
    // Prüfen, ob eine Funktion zum Anzeigen von Fehlern existiert
    if (typeof showError === 'function') {
      showError("Ungültiger Link: Keine Sitzungs-ID gefunden.");
    } else {
      console.error("Ungültiger Link: Keine Sitzungs-ID gefunden.");
    }
    return false;
  }
  
  // Sitzungsdaten laden
  const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
  const session = sessions.find(s => s.id === sessionId);
  
  if (!session) {
    // Prüfen, ob eine Funktion zum Anzeigen von Fehlern existiert
    if (typeof showError === 'function') {
      showError("Die angeforderte Sitzung existiert nicht.");
    } else {
      console.error("Die angeforderte Sitzung existiert nicht.");
    }
    return false;
  }
  
  // Wenn es ein Beitritt ist (über einen Teilnehmerlink)
  if (isJoining) {
    return handleParticipantJoin(session);
  }
  
  // Normale Sitzungsöffnung (eigene Sitzung)
  return true;
}

// Fallback-Funktionen, falls sie nicht anderweitig definiert sind
function showError(message) {
  console.error(message);
  
  // Fallback: Erstelle ein Fehler-Element
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
  
  // Fehler nach 5 Sekunden entfernen
  setTimeout(() => {
    document.body.removeChild(errorContainer);
  }, 5000);
}