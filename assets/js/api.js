// API-Funktionen für die Kommunikation mit dem Backend
const API_URL = 'http://localhost:3000';

// Benutzerauthentifizierung
async function loginUser(email, password) {
  try {
    const response = await fetch(`${API_URL}/users?email=${email}`);
    const users = await response.json();
    
    if (users.length === 0) {
      return { success: false, message: 'Benutzer nicht gefunden' };
    }
    
    const user = users[0];
    if (user.password !== password) {
      return { success: false, message: 'Falsches Passwort' };
    }
    
    // Passwort aus den gespeicherten Daten entfernen
    const { password: _, ...userWithoutPassword } = user;
    
    return { 
      success: true, 
      user: userWithoutPassword 
    };
  } catch (error) {
    console.error('Login-Fehler:', error);
    return { success: false, message: 'Netzwerkfehler' };
  }
}

// Benutzerregistrierung
async function registerUser(name, email, password) {
  try {
    // Prüfen, ob die E-Mail bereits existiert
    const checkResponse = await fetch(`${API_URL}/users?email=${email}`);
    const existingUsers = await checkResponse.json();
    
    if (existingUsers.length > 0) {
      return { success: false, message: 'E-Mail wird bereits verwendet' };
    }
    
    // Neuen Benutzer erstellen
    const response = await fetch(`${API_URL}/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        email,
        password
      }),
    });
    
    const newUser = await response.json();
    
    // Passwort aus den zurückgegebenen Daten entfernen
    const { password: _, ...userWithoutPassword } = newUser;
    
    return { 
      success: true, 
      user: userWithoutPassword 
    };
  } catch (error) {
    console.error('Registrierungsfehler:', error);
    return { success: false, message: 'Netzwerkfehler' };
  }
}

// Sitzungen abrufen
async function getUserSessions(userId) {
  try {
    const response = await fetch(`${API_URL}/sessions?userId=${userId}`);
    const sessions = await response.json();
    
    // Details zu jedem Board abrufen
    const sessionsWithBoardDetails = await Promise.all(
      sessions.map(async (session) => {
        const boardResponse = await fetch(`${API_URL}/boards/${session.boardId}`);
        const board = await boardResponse.json();
        
        return {
          ...session,
          boardName: board.name,
          boardImage: board.image
        };
      })
    );
    
    // Daten auch im localStorage speichern für schnelleren Zugriff
    localStorage.setItem('kartensets_sessions', JSON.stringify(sessionsWithBoardDetails));
    
    return sessionsWithBoardDetails;
  } catch (error) {
    console.error('Fehler beim Abrufen der Sitzungen:', error);
    return [];
  }
}

// Boards abrufen
async function getBoards() {
  try {
    const response = await fetch(`${API_URL}/boards`);
    return await response.json();
  } catch (error) {
    console.error('Fehler beim Abrufen der Boards:', error);
    return [];
  }
}

// Neue Sitzung erstellen
async function createSession(sessionData) {
  try {
    const response = await fetch(`${API_URL}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...sessionData,
        created: new Date().toISOString(),
        lastOpened: new Date().toISOString()
      }),
    });
    
    const newSession = await response.json();
    
    // Aktualisiere auch den localStorage
    const existingSessions = JSON.parse(localStorage.getItem('kartensets_sessions') || '[]');
    existingSessions.push(newSession);
    localStorage.setItem('kartensets_sessions', JSON.stringify(existingSessions));
    
    return newSession;
  } catch (error) {
    console.error('Fehler beim Erstellen der Sitzung:', error);
    return null;
  }
}

// Sitzung aktualisieren
async function updateSession(sessionId, sessionData) {
  try {
    const response = await fetch(`${API_URL}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sessionData),
    });
    
    return await response.json();
  } catch (error) {
    console.error('Fehler beim Aktualisieren der Sitzung:', error);
    return null;
  }
}

// Sitzung löschen
async function deleteSession(sessionId) {
  try {
    await fetch(`${API_URL}/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    
    return true;
  } catch (error) {
    console.error('Fehler beim Löschen der Sitzung:', error);
    return false;
  }
}