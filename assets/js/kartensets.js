// kartensets.js - Hauptfunktionen für die Kartensets-Verwaltung

// Funktion zum Kopieren des Teilnahmelinks
function copyParticipantLink(sessionId) {
  try {
    // Link generieren
    const currentUrl = window.location.origin;
    const participantLink = `${currentUrl}/kartensets/session-board.html?id=${sessionId}&join=true`;
    
    // In die Zwischenablage kopieren
    navigator.clipboard.writeText(participantLink)
      .then(() => {
        // Visuelles Feedback für den Nutzer
        showNotification("Link wurde in die Zwischenablage kopiert", "success");
      })
      .catch(err => {
        console.error('Fehler beim Kopieren in die Zwischenablage:', err);
        // Fallback-Methode mit temporärem Textfeld
        fallbackCopyToClipboard(participantLink);
      });
  } catch (error) {
    console.error('Fehler beim Kopieren des Links:', error);
    showNotification("Fehler beim Kopieren des Links", "error");
  }
}

// Fallback-Methode zum Kopieren in die Zwischenablage
function fallbackCopyToClipboard(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  
  // Den Text außerhalb des sichtbaren Bereichs platzieren
  textArea.style.position = "fixed";
  textArea.style.top = "-999999px";
  textArea.style.left = "-999999px";
  document.body.appendChild(textArea);
  
  // Text auswählen und kopieren
  textArea.focus();
  textArea.select();
  
  let successful = false;
  try {
    successful = document.execCommand('copy');
  } catch (err) {
    console.error('Fehler beim Ausführen von execCommand:', err);
  }
  
  document.body.removeChild(textArea);
  
  if (successful) {
    showNotification("Link wurde in die Zwischenablage kopiert", "success");
  } else {
    promptUserToCopyManually(text);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  // Selektoren für UI-Elemente
  const newSessionBtn = document.getElementById('new-session-btn');
  const profileBtn = document.getElementById('profile-btn');
  const loginBtn = document.getElementById('login-btn');
  const registerBtn = document.getElementById('register-btn');
  const createSessionModal = document.getElementById('create-session-modal');
  const loginModal = document.getElementById('login-modal');
  const sessionsList = document.querySelector('.sessions-list');
  const sessionsPlaceholder = document.getElementById('sessions-placeholder');
  const createSessionForm = document.getElementById('create-session-form');
  const loginForm = document.getElementById('login-form');
  const closeModalButtons = document.querySelectorAll('.close-modal');
  const sessionsFilter = document.getElementById('sessions-filter'); 

  // Simuliere Login für Testzwecke
  if (!localStorage.getItem('kartensets_login')) {
  localStorage.setItem('kartensets_login', 'true');
  // Dummy-Benutzer erstellen, falls keiner existiert
  if (!localStorage.getItem('currentUser')) {
    localStorage.setItem('currentUser', JSON.stringify({id: 'test-user', name: 'Test User'}));
  }
}

    // Ausgabe zum Debugging
    console.log("DOM Elements:", {
      newSessionBtn,
      profileBtn,
      createSessionModal,
      sessionsList,
      sessionsPlaceholder,
      createSessionForm
    });

  // Beispiel-Sitzungsdaten (später durch echte Daten aus der Datenbank ersetzen)
  const exampleSessions = [
    {
      id: '1',
      name: 'Teammeeting',
      boardId: 'board1',
      boardName: 'Problem-Lösung',
      boardImage: '/assets/images/boards/board1.jpg',
      created: '2025-03-10T12:00:00',
      lastOpened: '2025-03-12T14:30:00'
    },
    {
      id: '2',
      name: 'Coaching-Session',
      boardId: 'board2',
      boardName: 'Kartenset 2',
      boardImage: '/assets/images/boards/board2.jpg',
      created: '2025-03-08T09:00:00',
      lastOpened: '2025-03-13T16:15:00'
    }
  ];

  // Prüft, ob der Benutzer eingeloggt ist (später durch echte Authentifizierung ersetzen)
  const isLoggedIn = () => {
    return localStorage.getItem('kartensets_login') === 'true';
  };

  // Setzt den Login-Status
  const setLoginStatus = (status) => {
    localStorage.setItem('kartensets_login', status);
    updateUIBasedOnLoginStatus();
  };

  // Aktualisiert die UI basierend auf dem Login-Status
  const updateUIBasedOnLoginStatus = () => {
    const loginRequired = document.getElementById('login-required-message');
    const sessionsContainer = document.getElementById('sessions-container');
    
    if (isLoggedIn()) {
      if (loginRequired) loginRequired.classList.add('hidden');
      if (sessionsContainer) sessionsContainer.classList.remove('hidden');
      loadSessions();
    } else {
      if (loginRequired) loginRequired.classList.remove('hidden');
      if (sessionsContainer) sessionsContainer.classList.add('hidden');
    }
  };

 // Lädt und zeigt die Sitzungen des Benutzers
 const loadSessions = async () => {
  try {
    console.log("Lade Sitzungen...");
    console.log("Session List Element:", sessionsList);
    
    // Aktuellen Benutzer holen
    const currentUser = JSON.parse(localStorage.getItem('currentUser'));
    if (!currentUser || !currentUser.id) {
      console.error("Kein Benutzer angemeldet");
      renderSessions([]); // Leere Liste rendern, wenn kein Benutzer angemeldet ist
      return;
    }
    
    // Sitzungen aus dem LocalStorage laden
    const allSessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
    
    // Nur Sitzungen dieses Benutzers filtern
    const userSessions = allSessions.filter(session => {
      // Prüfe, ob der Benutzer der Besitzer ist
      if (session.userId === currentUser.id) {
        return true;
      }
      
      // Prüfe, ob der Benutzer Teilnehmer ist
      const isParticipant = session.participants && 
        session.participants.some(p => p.id === currentUser.id);
      
      return isParticipant;
    });
    
    console.log("Geladene Sitzungen:", userSessions);
    
    // Gefilterte Sitzungen rendern
    renderSessions(userSessions);
  } catch (error) {
    console.error("Fehler beim Laden der Sitzungen:", error);
    renderSessions([]); // Im Fehlerfall leere Liste rendern
  }
  };

  const renderSessions = (sessions) => {
    console.log("Rendere Sitzungen:", sessions);
    
    if (!sessionsList) {
      console.error("Sessions-Liste nicht gefunden");
      return;
    }
    
    // Immer zuerst den Container leeren
    sessionsList.innerHTML = '';
    
    // Prüfen, ob Sessions leer sind
    if (!sessions || sessions.length === 0) {
      console.log("Keine Sitzungen zum Anzeigen");
      
      // Platzhalter für leere Liste anzeigen
      if (sessionsPlaceholder) {
        sessionsPlaceholder.classList.remove('hidden');
      } else {
        // Falls kein Platzhalter existiert, einen erstellen
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'empty-sessions-message';
        emptyMessage.textContent = 'Keine Sitzungen vorhanden. Erstellen Sie eine neue Sitzung mit dem "+ Neue Sitzung erstellen" Button.';
        emptyMessage.style.textAlign = 'center';
        emptyMessage.style.padding = '30px';
        emptyMessage.style.color = '#666';
        sessionsList.appendChild(emptyMessage);
      }
      return;
    }
    
    // Platzhalter ausblenden, wenn es Sitzungen gibt
    if (sessionsPlaceholder) {
      sessionsPlaceholder.classList.add('hidden');
    }
    
    // Sitzungen direkt als HTML hinzufügen
    sessions.forEach(session => {
      const created = new Date(session.created);
      const lastOpened = new Date(session.lastOpened);
      const lastEdited = new Date(session.lastEdited || session.created);
      
      const sessionCard = document.createElement('div');
      sessionCard.className = 'session-card';
      
      // HTML-Struktur angepasst an das neue Layout
      sessionCard.innerHTML = `
        <div class="session-info">
          <h3 class="session-name">${session.name}</h3>
          
          <div class="session-board">
            <img src="${session.boardImage}" alt="${session.boardName}" class="board-preview">
            <span class="board-name">${session.boardName}</span>
          </div>
          
          <div class="session-metadata">
            <span class="creation-date">erstellt am: ${formatDate(created)}</span>
            <span class="last-opend">zuletzt genutzt: ${formatDate(lastOpened)}</span>
            <span class="last-edited">zuletzt bearbeitet: ${formatDate(lastEdited)}</span>
          </div>
        </div>
        
        <div class="session-actions">
          <button class="open-board-btn action-button">Brett öffnen</button>
          <button class="copy-link-btn action-button">Beitritts-Link</button>
          <button class="password-btn action-button">Passwort setzen/ändern</button>
        </div>
        
        <div class="options-menu">
          <button class="dropdown-toggle">⋮</button>
          <div class="dropdown-menu" style="display: none;">
            <button class="edit-board-btn">Brett bearbeiten</button>
            <button class="delete-board-btn">Brett löschen</button>
          </div>
        </div>
      `;
      
      // Event-Listener für Aktionen
      sessionCard.querySelector('.open-board-btn').addEventListener('click', () => {
        openBoard(session.id);
      });
      
      sessionCard.querySelector('.copy-link-btn').addEventListener('click', () => {
        copyParticipantLink(session.id);
      });
      
      sessionCard.querySelector('.password-btn').addEventListener('click', () => {
        setPassword(session.id);
      });
      
      const dropdown = sessionCard.querySelector('.options-menu');
      const dropdownToggle = dropdown.querySelector('.dropdown-toggle');
      const dropdownMenu = dropdown.querySelector('.dropdown-menu');
      
      dropdownToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownMenu.style.display = dropdownMenu.style.display === 'block' ? 'none' : 'block';
      });
      
      document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target)) {
          dropdownMenu.style.display = 'none';
        }
      });
      
      sessionCard.querySelector('.edit-board-btn').addEventListener('click', () => {
        editBoard(session.id);
      });
      
      sessionCard.querySelector('.delete-board-btn').addEventListener('click', () => {
        deleteBoard(session.id);
      });
      
      // Karte zur Liste hinzufügen
      sessionsList.appendChild(sessionCard);
    });
  };

  // Öffnet ein Brett/eine Sitzung
  const openBoard = (sessionId) => {
    // Zuerst sicherstellen, dass die Sitzung existiert
    const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
    const session = sessions.find(s => s.id === sessionId);
    
    if (!session) {
      alert('Sitzung nicht gefunden.');
      return;
    }
    
    // Neuen Tab mit dem Board öffnen
    // Die session-board.html Seite wird mit der Sitzungs-ID als Parameter geladen
    const url = `/kartensets/session-board.html?id=${sessionId}`;
    window.open(url, '_blank');
    
    // Letzten Zugriff aktualisieren
    updateLastAccess(sessionId);
  };

  // Hilfsfunktion zum Aktualisieren des letzten Zugriffszeitpunkts
  const updateLastAccess = (sessionId) => {
    const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
  
    const updatedSessions = sessions.map(session => {
      if (session.id === sessionId) {
        return {
         ...session,
         lastOpened: new Date().toISOString()
        };
      }
      return session;
    });
  
    localStorage.setItem('kartensets_sessions', JSON.stringify(updatedSessions));
  };

  // Bearbeitet ein Brett/eine Sitzung
  const editBoard = (sessionId) => {
    // Bestehende Sitzungen aus dem localStorage abrufen
    const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
  
   // Sitzung mit der angegebenen ID finden
    const session = sessions.find(s => s.id === sessionId);
  
   if (!session) {
     alert('Sitzung nicht gefunden.');
     return;
   }
  
    // Modal-Titel ändern
    const modalTitle = createSessionModal.querySelector('.modal-header h2');
    if (modalTitle) {
      modalTitle.textContent = 'Sitzung bearbeiten';
    }
  
    // Submit-Button Text ändern
   const submitButton = createSessionModal.querySelector('.submit-button');
    if (submitButton) {
     submitButton.textContent = 'Änderungen speichern';
    }
  
   // Formular mit bestehenden Daten füllen
   document.getElementById('session-name').value = session.name;
  
   // Das richtige Board auswählen
    const boardRadio = document.querySelector(`input[name="board-selection"][value="${session.boardId}"]`);
   if (boardRadio) {
     boardRadio.checked = true;
    
     // Visuelle Rückmeldung aktualisieren (falls verwendet)
     document.querySelectorAll('.board-option').forEach(option => {
        option.classList.remove('selected');
     });
    
     const selectedOption = boardRadio.closest('.board-option');
     if (selectedOption) {
       selectedOption.classList.add('selected');
     }
   }
  
   // Passwort füllen, falls vorhanden
   const passwordInput = document.getElementById('session-password');
   if (passwordInput) {
     passwordInput.value = session.password || '';
    }
  
   // Session-ID als Datenattribut speichern, um zu wissen, welche Sitzung bearbeitet wird
   const form = document.getElementById('create-session-form');
   if (form) {
     form.dataset.editSessionId = sessionId;
   }
  
   // Modal öffnen
   openModal(createSessionModal);
  
   // Vorübergehende Anpassung der Form-Submission, um zwischen Erstellen und Bearbeiten zu unterscheiden
   const originalSubmitHandler = form.onsubmit;
  
   form.onsubmit = async (event) => {
     event.preventDefault();
    
     const sessionName = document.getElementById('session-name').value;
     const boardSelection = document.querySelector('input[name="board-selection"]:checked');
      const sessionPassword = document.getElementById('session-password').value;
    
      if (!boardSelection) {
        alert('Bitte wählen Sie ein Board aus.');
       return;
      }
    
      // Sitzung aktualisieren
      const existingSessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
    
      const updatedSessions = existingSessions.map(s => {
       if (s.id === sessionId) {
          return {
            ...s,
           name: sessionName,
           boardId: boardSelection.value,
           boardName: getBoardName(boardSelection.value),
           boardImage: getBoardImage(boardSelection.value),
           password: sessionPassword || null,
           lastEdited: new Date().toISOString()
          };
        }
       return s;
     });
    
     // Aktualisierte Sitzungsliste speichern
     localStorage.setItem('kartensets_sessions', JSON.stringify(updatedSessions));
    
      // Modal schließen
      closeModal(createSessionModal);
    
     // Erfolgsbenachrichtigung
     alert(`Sitzung "${sessionName}" wurde aktualisiert.`);
    
     // Sitzungsliste aktualisieren
     loadSessions();
    
     // Formular zurücksetzen und Modal-Titel wiederherstellen
     form.reset();
      if (modalTitle) {
        modalTitle.textContent = 'Erstellen Sie eine neue Sitzung';
      }
     if (submitButton) {
       submitButton.textContent = 'Sitzung erstellen';
     }
    
     // Editier-Modus aufheben
     delete form.dataset.editSessionId;
    
     // Original-Handler wiederherstellen (für neue Sitzungen)
     form.onsubmit = originalSubmitHandler;
   };
  };

  // Löscht ein Brett/eine Sitzung
  const deleteBoard = (sessionId) => {
    // Erstelle ein Pop-up zur Bestätigung
    const confirmModal = document.createElement('div');
    confirmModal.className = 'modal';
    confirmModal.style.display = 'block';
  
    confirmModal.innerHTML = `
      <div class="modal-content" style="max-width: 400px;">
        <div class="modal-header">
          <h2>Brett löschen</h2>
         <button class="close-modal">&times;</button>
       </div>
       <div class="modal-body">
         <p>Sind Sie sicher, dass Sie diese Sitzung löschen möchten?</p>
         <p>Diese Aktion kann nicht rückgängig gemacht werden.</p>
          <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
            <button id="cancel-delete" class="secondary-button">Abbrechen</button>
            <button id="confirm-delete" style="background-color: #d9534f; color: white; border: none; border-radius: 4px; padding: 10px 16px; cursor: pointer;">Sitzung löschen</button>
         </div>
       </div>
      </div>
    `;
  
   document.body.appendChild(confirmModal);
  
   // Event-Listener für die Schaltflächen im Pop-up
   const closeButton = confirmModal.querySelector('.close-modal');
    const cancelButton = confirmModal.querySelector('#cancel-delete');
   const confirmButton = confirmModal.querySelector('#confirm-delete');
  
   const closeConfirmModal = () => {
     confirmModal.style.display = 'none';
     document.body.removeChild(confirmModal);
   };
  
    closeButton.addEventListener('click', closeConfirmModal);
    cancelButton.addEventListener('click', closeConfirmModal);
  
   confirmButton.addEventListener('click', async () => {
     try {
       // Vorhandene Sitzungen aus dem localStorage abrufen
        const existingSessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
      
       // Sitzung mit der angegebenen ID entfernen
        const updatedSessions = existingSessions.filter(session => session.id !== sessionId);
      
        // Aktualisierte Sitzungsliste speichern
        localStorage.setItem('kartensets_sessions', JSON.stringify(updatedSessions));
      
        // Pop-up schließen
       closeConfirmModal();
      
        // Erfolgsbenachrichtigung anzeigen
       alert('Sitzung wurde erfolgreich gelöscht.');
      
        // Sitzungsliste aktualisieren
       loadSessions();
     } catch (error) {
        console.error('Fehler beim Löschen der Sitzung:', error);
        alert('Fehler beim Löschen der Sitzung: ' + error.message);
        closeConfirmModal();
      }
   });
  
    // Schließen des Pop-ups bei Klick außerhalb
   window.addEventListener('click', (event) => {
     if (event.target === confirmModal) {
       closeConfirmModal();
      }
    });
  };

  // Setzt oder ändert ein Passwort für eine Sitzung
  const setPassword = (sessionId) => {
    // Erstelle ein Pop-up für die Passworteingabe
    const passwordModal = document.createElement('div');
   passwordModal.className = 'modal';
   passwordModal.style.display = 'block';
  
    passwordModal.innerHTML = `
      <div class="modal-content" style="max-width: 450px;">
       <div class="modal-header">
          <h2>Passwort setzen/ändern</h2>
          <button class="close-modal">&times;</button>
       </div>
        <div class="modal-body">
          <p>Geben Sie ein Passwort für diese Sitzung ein. Teilnehmer benötigen dieses Passwort, um der Sitzung beizutreten.</p>
          <div class="form-group">
            <label for="session-password">Passwort:</label>
            <input type="text" id="session-password" placeholder="Passwort eingeben" class="password-input">
            <p class="hint">Lassen Sie das Feld leer, um das Passwort zu entfernen.</p>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
            <button id="cancel-password" class="secondary-button">Abbrechen</button>
            <button id="save-password" class="primary-button" style="background-color: #f0ad4e;">Passwort speichern</button>
          </div>
        </div>
      </div>
    `;
  
   document.body.appendChild(passwordModal);
  
   // Referenzen zu den Elementen im Modal
   const closeButton = passwordModal.querySelector('.close-modal');
   const cancelButton = passwordModal.querySelector('#cancel-password');
   const saveButton = passwordModal.querySelector('#save-password');
    const passwordInput = passwordModal.querySelector('#session-password');
  
   // Aktuelles Passwort laden und in das Eingabefeld setzen
   const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
   const session = sessions.find(s => s.id === sessionId);
  
    if (session && session.password) {
      passwordInput.value = session.password;
   }
  
   // Funktion zum Schließen des Modals
   const closePasswordModal = () => {
      passwordModal.style.display = 'none';
      document.body.removeChild(passwordModal);
   };
  
   // Event-Listener für die Schaltflächen
   closeButton.addEventListener('click', closePasswordModal);
   cancelButton.addEventListener('click', closePasswordModal);
  
   saveButton.addEventListener('click', () => {
     const newPassword = passwordInput.value;
    
     // Sitzungen aus dem localStorage abrufen
      const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
    
     // Sitzung mit der angegebenen ID finden und Passwort aktualisieren
      const updatedSessions = sessions.map(session => {
        if (session.id === sessionId) {
         return {
            ...session,
            password: newPassword || null, // Wenn leer, dann null setzen
            lastEdited: new Date().toISOString() // Datum der letzten Bearbeitung aktualisieren
         };
        }
        return session;
     });
    
     // Aktualisierte Sitzungsliste speichern
     localStorage.setItem('kartensets_sessions', JSON.stringify(updatedSessions));
    
     // Modal schließen
      closePasswordModal();
    
     // Erfolgsbenachrichtigung
     if (!newPassword) {
       alert('Passwort wurde entfernt.');
     } else {
       alert('Passwort wurde gespeichert.');
      }
    
     // Sitzungsliste aktualisieren
     loadSessions();
   });
  
   // Schließen des Modals bei Klick außerhalb
   window.addEventListener('click', (event) => {
     if (event.target === passwordModal) {
       closePasswordModal();
      }
   });
  
    // Fokus auf das Passwort-Eingabefeld setzen
    passwordInput.focus();
  };

  // Hilfsfunktion zum Generieren einer eindeutigen ID
  function generateUniqueId() {
    return Date.now().toString() + Math.random().toString(36).substr(2, 9);
  }

  // Funktion zum Erstellen einer Sitzung (lokal)
  // Funktion zum Erstellen einer Sitzung (via SessionStorage)
  async function createSession(sessionData) {
    try {
      const currentUser = JSON.parse(localStorage.getItem('currentUser'));
      if (!currentUser || !currentUser.id) {
        alert('Sie müssen angemeldet sein, um eine Sitzung zu erstellen.');
        return null;
      }
      
      // Eindeutige ID generieren
      const sessionId = generateUniqueId();
      
      // Timestamp für die Erstellung hinzufügen
      const timestamp = new Date().toISOString();
      
      // Vollständige Sitzungsdaten erstellen
      const newSession = {
        id: sessionId,
        name: sessionData.name,
        userId: currentUser.id, // Wir verwenden die ID des aktuellen Benutzers
        boardId: sessionData.boardId,
        boardName: getBoardName(sessionData.boardId),
        boardImage: getBoardImage(sessionData.boardId),
        password: sessionData.password || null,
        created: timestamp,
        lastOpened: timestamp,
        lastEdited: timestamp,
        // Anfangszustand als leer initialisieren
        boardState: {
          focusNote: "",
          notes: [],
          cards: []
        },
        participants: [{ 
          id: currentUser.id,
          name: currentUser.name,
          role: "owner"
        }]
      };
      
      // Sitzungen aus dem lokalen Speicher abrufen
      const existingSessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
      
      // Neue Sitzung hinzufügen
      existingSessions.push(newSession);
      
      // Aktualisierte Sitzungen speichern
      localStorage.setItem('kartensets_sessions', JSON.stringify(existingSessions));
      
      console.log("Neue Sitzung erstellt:", newSession);
      
      return newSession;
    } catch (error) {
      console.error('Fehler beim Erstellen der Sitzung:', error);
      return null;
    }
  }


  // Hilfsfunktionen für Board-Informationen
  function getBoardName(boardId) {
    const boardNames = {
      'board1': 'Problem-Lösung',
      'board2': 'Kartenset 2',
      'board3': 'Freies Feld'
    };
    return boardNames[boardId] || 'Unbekanntes Board';
  }

  function getBoardImage(boardId) {
    const boardImages = {
      'board1': '/assets/images/boards/board1.jpg',
      'board2': '/assets/images/boards/board2.jpg',
      'board3': '/assets/images/boards/board3.jpg'
    };
    return boardImages[boardId] || '/assets/images/boards/default.jpg';
  }

  // Die getUserSessions Funktion, um lokale Sitzungen zu laden
  async function getUserSessions(userId) {
    try {
      // Alle Sitzungen aus dem lokalen Speicher abrufen
      const allSessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
      
      // In einer echten Anwendung würden wir nach userId filtern
      // Für lokale Tests geben wir einfach alle Sitzungen zurück
      return allSessions;
    } catch (error) {
      console.error('Fehler beim Laden der Sitzungen:', error);
      return [];
    }
  }

  // Hilfsfunktion zum Formatieren des Datums
  function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('de-DE') + ' ' + 
           date.toLocaleTimeString('de-DE', {hour: '2-digit', minute:'2-digit'});
  }

  

  // Aufforderung zum manuellen Kopieren, wenn alles andere fehlschlägt
  function promptUserToCopyManually(text) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'block';
    
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 500px;">
        <div class="modal-header">
          <h2>Link kopieren</h2>
          <button class="close-modal">&times;</button>
        </div>
        <div class="modal-body">
          <p>Der Link konnte nicht automatisch kopiert werden. Bitte kopieren Sie den folgenden Link manuell:</p>
          <input type="text" value="${text}" style="width: 100%; padding: 10px; margin: 10px 0;" readonly onclick="this.select();">
          <p style="font-size: 12px; color: #666;">Klicken Sie auf den Link, um ihn zu markieren, und drücken Sie dann Strg+C (oder ⌘+C auf Mac).</p>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    const input = modal.querySelector('input');
    input.select();
    
    const closeBtn = modal.querySelector('.close-modal');
    closeBtn.addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    window.addEventListener('click', (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal);
      }
    });
  }

  // Zeigt eine Benachrichtigung an
  function showNotification(message, type = "info") {
    // Vorhandene Benachrichtigung entfernen
    const existingNotification = document.querySelector('.notification-popup');
    if (existingNotification) {
      existingNotification.remove();
    }
    
    // Neue Benachrichtigung erstellen
    const notification = document.createElement('div');
    notification.className = `notification-popup ${type}`;
    notification.textContent = message;
    
    // Zur Seite hinzufügen
    document.body.appendChild(notification);
    
    // Animation einleiten
    setTimeout(() => {
      notification.classList.add('show');
    }, 10);
    
    // Nach 3 Sekunden ausblenden
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => {
        notification.remove();
      }, 300);
    }, 3000);
    
    return notification;
  }

  // CSS für Benachrichtigungen hinzufügen
  function addNotificationStyles() {
    if (!document.getElementById('notification-styles')) {
      const style = document.createElement('style');
      style.id = 'notification-styles';
      style.textContent = `
        .notification-popup {
          position: fixed;
          top: 20px;
          right: 20px;
          padding: 12px 20px;
          background-color: #fff;
          border-left: 4px solid #4CAF50;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          border-radius: 4px;
          z-index: 9999;
          font-size: 14px;
          transform: translateX(120%);
          transition: transform 0.3s ease;
          max-width: 300px;
        }
        
        .notification-popup.show {
          transform: translateX(0);
        }
        
        .notification-popup.success {
          border-left-color: #4CAF50;
        }
        
        .notification-popup.error {
          border-left-color: #F44336;
        }
        
        .notification-popup.warning {
          border-left-color: #FF9800;
        }
        
        .notification-popup.info {
          border-left-color: #2196F3;
        }
      `;
      document.head.appendChild(style);
    }
  }

  // Öffnet ein Modal
  const openModal = (modal) => {
    modal.style.display = 'block';
  };

  // Schließt ein Modal
  const closeModal = (modal) => {
    modal.style.display = 'none';
  };

  // Event-Listener für Buttons
  if (newSessionBtn) {
    newSessionBtn.addEventListener('click', () => {
      // Formular zurücksetzen
      if (createSessionForm) createSessionForm.reset();
      openModal(createSessionModal);
    });
  }

  if (profileBtn) {
    profileBtn.addEventListener('click', () => {
      if (isLoggedIn()) {
        // Profil-Seite öffnen
        window.location.href = '/profile';
      } else {
        openModal(loginModal);
      }
    });
  }

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault(); // Verhindert das standardmäßige Link-Verhalten
      
      // Benutzerdaten aus dem lokalen Speicher entfernen
      localStorage.removeItem('currentUser');
      localStorage.removeItem('kartensets_login');
      
      // Zur Login-Seite zurückkehren
      window.location.href = '/kartensets/login/';
    });
  }
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      openModal(loginModal);
    });
  }

  if (registerBtn) {
    registerBtn.addEventListener('click', () => {
      // Registrierung-Modal öffnen oder zur Registrierungsseite navigieren
      window.location.href = '/register';
    });
  }

  // Schließen-Buttons für Modals
  closeModalButtons.forEach(button => {
    button.addEventListener('click', () => {
      const modal = button.closest('.modal');
      closeModal(modal);
    });
  });

  // Schließen der Modals bei Klick außerhalb
  window.addEventListener('click', (event) => {
    if (event.target.classList.contains('modal')) {
      closeModal(event.target);
    }
  });

  // Formular-Submissions
  if (createSessionForm) {
    createSessionForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      console.log('Formular wurde abgesendet');
    
      const sessionName = document.getElementById('session-name').value;
      const boardSelection = document.querySelector('input[name="board-selection"]:checked');
      const sessionPassword = document.getElementById('session-password').value;
    
      if (!boardSelection) {
        alert('Bitte wählen Sie ein Board aus.');
        return;
      }
    
      // Prüfen, ob wir im Bearbeitungsmodus sind
      const editSessionId = createSessionForm.dataset.editSessionId;
    
      if (editSessionId) {
        // Im Bearbeitungsmodus - hier sollte nichts passieren, da dies durch die editBoard-Funktion behandelt wird
        return;
      }
    
      // Im Erstellungsmodus - neue Sitzung erstellen
      const sessionData = {
        name: sessionName,
        boardId: boardSelection.value,
        password: sessionPassword || null
      };
    
      console.log('Erstelle Sitzung mit Daten:', sessionData);
    
      const newSession = await createSession(sessionData);
    
      if (newSession) {
        alert(`Sitzung "${sessionName}" wurde erstellt.`);
        closeModal(createSessionModal);
        loadSessions(); // Sitzungsliste aktualisieren
      } else {
        alert('Fehler beim Erstellen der Sitzung.');
      }
    });
  }

  document.querySelectorAll('.board-option label').forEach(label => {
    label.addEventListener('click', function() {
      // Die Auswahl wird automatisch durch das CSS gehandhabt
      // Wir könnten hier zusätzliche Funktionalität hinzufügen, falls nötig
    });
  });

  // Zusätzliche Event-Listener für die neuen Elemente
  const helpBtn = document.getElementById('help-btn');
  const helpModal = document.getElementById('help-modal');

  // Hilfefunktion
  if (helpBtn && helpModal) {
    helpBtn.addEventListener('click', () => {
      openModal(helpModal);
    });
  }

  // Zusätzlicher Sitzung erstellen Button im Header
  const headerNewSessionBtn = document.getElementById('header-new-session-btn');
  if (headerNewSessionBtn && createSessionForm) {
    headerNewSessionBtn.addEventListener('click', () => {
      // Formular zurücksetzen
      createSessionForm.reset();
      openModal(createSessionModal);
    });
  }

  const ourBoardsBtn = document.getElementById('our-boards-btn');
  const ourBoardsModal = document.getElementById('our-boards-modal');

  if (ourBoardsBtn && ourBoardsModal) {
    ourBoardsBtn.addEventListener('click', () => {
      openModal(ourBoardsModal);
    });
  }

  // Initialisierung
  updateUIBasedOnLoginStatus();

  // Füge hier den neuen Code ein:
  // Event-Listener für den Filter hinzufügen
  if (sessionsFilter) {
    sessionsFilter.addEventListener('change', function() {
      // Sitzungen aus dem LocalStorage laden
      const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
      
      // Gefilterte/sortierte Sitzungen basierend auf dem ausgewählten Filter erstellen
      const filteredSessions = filterSessions(sessions, this.value);
      
      // Sitzungen mit dem angewendeten Filter neu rendern
      renderSessions(filteredSessions);
    });
  }

  // Funktion zum Filtern und Sortieren der Sitzungen
  function filterSessions(sessions, filterType) {
    // Wenn kein Filter ausgewählt ist oder keine Sitzungen vorhanden sind
    if (filterType === 'none' || !sessions || sessions.length === 0) {
      return sessions;
    }
    
    let filteredSessions = [...sessions]; // Kopie erstellen, um das Original nicht zu verändern
    
    switch (filterType) {
      case 'recent':
        // Nach Datum der letzten Bearbeitung sortieren (neueste zuerst)
        filteredSessions.sort((a, b) => {
          const dateA = new Date(a.lastEdited || a.lastOpened || a.created);
          const dateB = new Date(b.lastEdited || b.lastOpened || b.created);
          return dateB - dateA; // Absteigend sortieren (neueste zuerst)
        });
        break;

      case 'last-opened':
        // Nach Datum des letzten Öffnens sortieren (neueste zuerst)
        filteredSessions.sort((a, b) => {
          const dateA = new Date(a.lastOpened || a.created);
          const dateB = new Date(b.lastOpened || b.created);
          return dateB - dateA; // Absteigend sortieren (neueste zuerst)
        });
        break;
        
      case 'name':
        // Alphabetisch nach Namen sortieren
        filteredSessions.sort((a, b) => {
          return a.name.localeCompare(b.name, 'de'); // Deutschsprachige Sortierung
        });
        break;
        
      case 'board-type':
        // Nach Board-Typ gruppieren und innerhalb der Gruppen alphabetisch sortieren
        filteredSessions.sort((a, b) => {
          // Zuerst nach Board-Typ
          const typeComparison = a.boardName.localeCompare(b.boardName, 'de');
          if (typeComparison !== 0) {
            return typeComparison;
          }
          // Bei gleichem Board-Typ nach Namen sortieren
          return a.name.localeCompare(b.name, 'de');
        });
        break;
    }
    
    return filteredSessions;
  }

  if (localStorage.getItem('dashboard_reload_requested') === 'true') {
    // Markierung entfernen
    localStorage.removeItem('dashboard_reload_requested');
    
    // Sitzungen neu laden
    loadSessions();
  }
  
  // Event-Listener für localStorage-Änderungen
  window.addEventListener('storage', function(e) {
    // Nur auf spezifische Änderungen reagieren
    if (e.key === 'dashboard_reload_requested' && e.newValue === 'true') {
      // Markierung entfernen
      localStorage.removeItem('dashboard_reload_requested');
      
      // Sitzungen neu laden
      loadSessions();
    }
    
    // Auch auf Änderungen an den Sessions selbst reagieren
    if (e.key === 'kartensets_sessions') {
      loadSessions();
    }
  });
}); // Hier fehlte das schließende `}` für den document.addEventListener-Block
