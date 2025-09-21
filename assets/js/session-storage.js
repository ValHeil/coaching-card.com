// Funktionen für Sitzungsspeicherung und Wiederherstellung

// Erweiterte Speicherverwaltung
const StorageManager = {
  // Maximale Speichergröße in Bytes
  MAX_STORAGE_SIZE: 5 * 1024 * 1024, // 5 MB

  // Speichern mit Größenüberprüfung
  saveWithSizeCheck(key, data) {
    try {
      const serializedData = JSON.stringify(data);
      
      // Größenüberprüfung
      if (serializedData.length > this.MAX_STORAGE_SIZE) {
        console.warn('Speichergröße überschritten. Ältere Daten werden bereinigt.');
        this.cleanupOldData(key, data);
      }

      localStorage.setItem(key, serializedData);
      return true;
    } catch (error) {
      if (error instanceof DOMException && 
          (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
        console.error('localStorage Quota überschritten');
        this.handleQuotaExceeded(key, data);
      } else {
        console.error('Fehler beim Speichern:', error);
      }
      return false;
    }
  },

  // Bereinigung alter Daten
  cleanupOldData(key, newData) {
    const allSessions = JSON.parse(localStorage.getItem(key) || '[]');
    
    // Sortieren nach Zeitstempel und älteste Sitzungen entfernen
    const sortedSessions = allSessions.sort((a, b) => 
      new Date(a.created) - new Date(b.created)
    );

    // Neue Sitzung hinzufügen
    sortedSessions.push(newData);

    // Entferne älteste Sitzungen, bis Speichergröße passt
    while (sortedSessions.length > 0) {
      const reducedData = JSON.stringify(sortedSessions);
      if (reducedData.length <= this.MAX_STORAGE_SIZE) {
        localStorage.setItem(key, reducedData);
        break;
      }
      sortedSessions.shift(); // Älteste Sitzung entfernen
    }
  },

  // Behandlung von Speicherüberlauf
  handleQuotaExceeded(key, data) {
    try {
      // Versuchen, Daten zu komprimieren
      const compressedData = this.compressData(data);
      localStorage.setItem(key, compressedData);
    } catch (compressionError) {
      // Letzter Ausweg: Alte Daten löschen
      console.warn('Daten konnten nicht komprimiert werden. Lösche alte Daten.');
      localStorage.removeItem(key);
    }
  },

  // Einfache Datenkompression
  compressData(data) {
    return JSON.stringify(data)
      .replace(/\s+/g, ' ')  // Whitespace reduzieren
      .substring(0, this.MAX_STORAGE_SIZE); // Kürzen
  }
};

// Hauptobjekt für Sitzungsspeicherung
const SessionStorage = {
  // Speichert eine neue Sitzung in der localStorage-Datenbank
  createSession: function(sessionData) {
    // Eindeutige ID generieren
    const sessionId = this.generateUniqueId();
    
    // Timestamp für die Erstellung hinzufügen
    const timestamp = new Date().toISOString();
    
    // Vollständige Sitzungsdaten erstellen
    const newSession = {
      id: sessionId,
      name: sessionData.name,
      boardId: sessionData.boardId,
      boardName: sessionData.boardName || this.getBoardName(sessionData.boardId),
      boardImage: sessionData.boardImage || this.getBoardImage(sessionData.boardId),
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
        id: this.getCurrentUserId(),
        name: this.getCurrentUserName(),
        role: "owner"
      }]
    };
    
    // Sitzungen aus dem lokalen Speicher abrufen
    const existingSessions = this.getAllSessions();
    
    // Neue Sitzung hinzufügen
    existingSessions.push(newSession);
    
    // Aktualisierte Sitzungen speichern
    this.saveSessions(existingSessions);
    
    console.log("Neue Sitzung erstellt:", newSession);
    
    return newSession;
  },
  
  // Lädt eine bestimmte Sitzung
  getSession: function(sessionId) {
    const sessions = this.getAllSessions();
    return sessions.find(session => session.id === sessionId) || null;
  },
  
  // Lädt eigene Sitzung aus LokalStorage
  getAllSessions: function() {
    const sessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
    const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
    
    // Filtere nur Sitzungen, bei denen der Benutzer Besitzer ist oder Teilnehmer
    if (currentUser && currentUser.id) {
      return sessions.filter(session => {
        // Prüfe, ob der Benutzer der Besitzer ist
        if (session.userId === currentUser.id) {
          return true;
        }
        
        // Prüfe, ob der Benutzer Teilnehmer ist
        const isParticipant = session.participants && 
          session.participants.some(p => p.id === currentUser.id);
        
        return isParticipant;
      });
    }
    
    return []; // Wenn kein Benutzer angemeldet ist, leere Liste zurückgeben
  },
  
  // Speichert Sitzungen mit Größenüberprüfung
  saveSessions: function(sessions) {
    StorageManager.saveWithSizeCheck('kartensets_sessions', sessions);
  },

  // Zusätzliche Debugging-Methode zur Speicherplatz-Überwachung
  checkStorageHealth: function() {
    try {
      const sessions = this.getAllSessions();
      const storageSize = JSON.stringify(sessions).length;
      console.log(`Aktuelle Speichergröße: ${storageSize} Bytes`);
      
      if (storageSize > StorageManager.MAX_STORAGE_SIZE * 0.8) {
        console.warn('Speicher fast voll. Empfehlung: Alte Sitzungen aufräumen.');
      }
    } catch (error) {
      console.error('Fehler bei der Speicherüberprüfung:', error);
    }
  },
  
  // Aktualisiert eine bestehende Sitzung
  updateSession: function(sessionId, updateData) {
    const sessions = this.getAllSessions();
    const updatedSessions = sessions.map(session => {
      if (session.id === sessionId) {
        // Vorhandene Daten mit neuen Daten aktualisieren
        return { ...session, ...updateData, lastEdited: new Date().toISOString() };
      }
      return session;
    });
    
    this.saveSessions(updatedSessions);
    return this.getSession(sessionId);
  },
  
  // Speichert den Zustand eines Boards (Karten, Notizen, etc.)
  saveBoardState: function(sessionId, boardState) {
    const sessions = this.getAllSessions();
    const updatedSessions = sessions.map(session => {
      if (session.id === sessionId) {
        return {
          ...session,
          boardState: boardState,
          lastEdited: new Date().toISOString()
        };
      }
      return session;
    });
    
    this.saveSessions(updatedSessions);
    console.log("Boardzustand gespeichert für Sitzung:", sessionId);
  },
  
  // Lädt den Zustand eines Boards
  loadBoardState: function(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    
    // Aktualisiert lastOpened
    this.updateLastAccess(sessionId);
    
    return session.boardState;
  },
  
  // Fügt einen Teilnehmer zu einer Sitzung hinzu
  addParticipant: function(sessionId, participantData) {
    const session = this.getSession(sessionId);
    if (!session) return false;
    
    // Prüfen, ob der Teilnehmer bereits existiert
    const existingParticipant = session.participants.find(p => p.id === participantData.id);
    if (existingParticipant) return true; // Teilnehmer existiert bereits
    
    // Neuen Teilnehmer hinzufügen
    const participants = [...session.participants, {
      id: participantData.id,
      name: participantData.name,
      role: participantData.role || "participant", // Standard-Rolle
      joined: new Date().toISOString()
    }];
    
    this.updateSession(sessionId, { participants });
    console.log("Teilnehmer hinzugefügt:", participantData.name);
    return true;
  },
  
  // Generiert einen Teilnahmelink für eine Sitzung
  generateParticipantLink: function(sessionId) {
    const currentUrl = window.location.origin;
    return `${currentUrl}/kartensets/session-board.html?id=${sessionId}&join=true`;
  },
  
  // Prüft, ob ein Passwort für eine Sitzung korrekt ist
  checkSessionPassword: function(sessionId, password) {
    const session = this.getSession(sessionId);
    if (!session) return false;
    
    // Wenn kein Passwort gesetzt ist, ist der Zugriff erlaubt
    if (!session.password) return true;
    
    // Passwörter vergleichen
    return session.password === password;
  },
  
  // Hilfsfunktion: Generiert eine eindeutige ID
  generateUniqueId: function() {
    return Date.now().toString() + Math.random().toString(36).substr(2, 9);
  },
  
  // Hilfsfunktion: Aktualisiert den letzten Zugriffszeitpunkt
  updateLastAccess: function(sessionId) {
    const sessions = this.getAllSessions();
    const updatedSessions = sessions.map(session => {
      if (session.id === sessionId) {
        return {
          ...session,
          lastOpened: new Date().toISOString()
        };
      }
      return session;
    });
    
    this.saveSessions(updatedSessions);
  },
  
  // Hilfsfunktion: Holt die aktuelle Benutzer-ID
  getCurrentUserId: function() {
    const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
    return currentUser.id || 'anonymous-' + this.generateUniqueId();
  },
  
  // Hilfsfunktion: Holt den aktuellen Benutzernamen
  getCurrentUserName: function() {
    const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
    return currentUser.name || 'Anonymer Benutzer';
  },
  
  // Hilfsfunktion: Holt den Namen eines Boards basierend auf der ID
  getBoardName: function(boardId) {
    const boardNames = {
      'board1': 'Problem-Lösung',
      'boardTest': 'TestBoard',
      'Problem-Lösung': board1,
      'board2': 'Kartenset 2',
      'board3': 'Freies Feld'
    };
    return boardNames[boardId] || 'Unbekanntes Board';
  },
  
  // Hilfsfunktion: Holt die Bild-URL eines Boards basierend auf der ID
  getBoardImage: function(boardId) {
    const boardImages = {
      'board1': '/assets/images/boards/board1.jpg',
      'boardTest': '/assets/images/boards/board1.jpg',
      'Problem-Lösung': '/assets/images/boards/board1.jpg',
      'board2': '/assets/images/boards/board2.jpg',
      'board3': '/assets/images/boards/board3.jpg'
    };
    return boardImages[boardId] || '/assets/images/boards/default.jpg';
  }
};

// Exportieren des Moduls für die Verwendung in anderen Dateien
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SessionStorage;
}
