(function(){
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  let Catalog = { boards: [], cardsets: [] };
  let Sessions = [];

  async function api(path, method='GET', body){
    const res = await fetch(ccsConfig.apiBase + path, {
      method,
      headers: { 'X-WP-Nonce': ccsConfig.nonce, 'Content-Type':'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if(!res.ok){
      const t = await res.text();
      throw new Error(t || (res.status + ' ' + res.statusText));
    }
    return res.json();
  }

  // ---------- Modal helpers ----------
  function openModal(){ $('#ccs-modal')?.classList.add('open'); }
  function closeModal(){
    $('#ccs-modal')?.classList.remove('open');
    $('#ccs-f-name').value=''; $('#ccs-f-pass').value='';
  }

  // ---------- Card actions ----------
  async function renameSession(item){
    const newName = prompt('Neuer Name für die Sitzung:', item.name);
    if(!newName || newName.trim()===item.name) return;
    await api(`sessions/${item.id}`, 'PATCH', { name: newName.trim() });
    await load();
  }

  async function deleteSession(item){
    if(!confirm('Sitzung wirklich löschen? Dieser Vorgang kann nicht rückgängig gemacht werden.')) return;
    await api(`sessions/${item.id}`, 'DELETE');
    await load();
  }

  function renderCard(item, boardMap){
    const b = boardMap[item.board_key] || {name:item.board_key, image:''};
    const c = (Catalog.cardsets || []).find(cs => cs.key === item.cardset_key) || { name: item.cardset_key };
    const el = document.createElement('div'); el.className='ccs-card';

    el.innerHTML = `
      <button class="ccs-kebab" title="Menü öffnen" aria-label="Menü öffnen">⋮</button>
      <div class="ccs-menu" role="menu">
        <button data-rename>Umbenennen</button>
        <button data-delete style="color:#b42318;">Sitzung löschen</button>
      </div>
      <img src="${b.image || ''}" alt="board"/>
      <div>
        <div class="ccs-title">${item.name}</div>
        <div class="ccs-sub">Board: ${b.name || ''}</div>
        <div class="ccs-sub">Kartenset: ${c?.name || '—'}</div>
      </div>
      <div class="ccs-meta">
        <div>erstellt am: ${new Date((item.created_at||'')+'Z').toLocaleString()}</div>
        <div>zuletzt geöffnet: ${new Date((item.updated_at||'')+'Z').toLocaleString()}</div>
      </div>
      <div class="ccs-actions">
        <button class="ccs-btn orange" data-open>Brett öffnen</button>
        <button class="ccs-btn secondary" data-invite>Beitritts-Link</button>
        <button class="ccs-btn tertiary" data-pass>Passwort setzen/ändern</button>
      </div>`;

    // kebab
    const kebab = el.querySelector('.ccs-kebab');
    const pop = el.querySelector('.ccs-menu');
    kebab.addEventListener('click', (e)=>{
      e.stopPropagation();
      $$('.ccs-menu.open').forEach(p=>p.classList.remove('open'));
      pop.classList.toggle('open');
    });
    document.addEventListener('click', ()=> pop.classList.remove('open'));

    // menu actions
    el.querySelector('[data-rename]').addEventListener('click', async (e)=>{
      e.stopPropagation(); pop.classList.remove('open'); await renameSession(item);
    });
    el.querySelector('[data-delete]').addEventListener('click', async (e)=>{
      e.stopPropagation(); pop.classList.remove('open'); await deleteSession(item);
    });

    // buttons
    el.querySelector('[data-invite]').addEventListener('click', async ()=>{
      const res = await api(`sessions/${item.id}/invite`, 'POST');
      const url = res.board_url || `${ccsConfig.boardBase}/${res.token}`;
      try { await navigator.clipboard.writeText(url); alert('Einladungslink kopiert!'); }
      catch { prompt('Beitritts-Link:', url); }

    });
    el.querySelector('[data-pass]').addEventListener('click', async ()=>{
      const p = prompt('Neues Passwort (leer = entfernen)');
      await api(`sessions/${item.id}`, 'PATCH', { password: p || null });
      await load();
    });
    // meine-sessions.js — im [data-open]-Click-Handler
    el.querySelector('[data-open]').addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const res = await api(`sessions/${item.id}/invite`, 'POST');
      let url = res.board_url || `${ccsConfig.boardBase}/${res.token}`;
      try {
        const u = new URL(url, window.location.origin);
        if (item?.name) u.searchParams.set('name', item.name); // << neu
        url = u.toString();
      } catch {}
      window.location.assign(url); // gleiches Tab
    });
    
    return el;
  };

  // ---------- Sortierung ----------
  const comparators = {
    recent_open: (a,b)=> new Date(b.updated_at) - new Date(a.updated_at),
    recent_added: (a,b)=> new Date(b.created_at) - new Date(a.created_at),
    alpha: (a,b)=> a.name.localeCompare(b.name, 'de', {sensitivity:'base'})
  };

  function render(){
    const boardMap = Object.fromEntries((Catalog.boards||[]).map(b=>[b.key,b]));
    const root = $('#ccs-list'); root.innerHTML = '';
    const mode = $('#ccs-filter')?.value || 'recent_open';
    const list = [...Sessions].sort(comparators[mode] || comparators.recent_open);
    list.forEach(item => root.appendChild(renderCard(item, boardMap)));
  }

  // ---------- Load ----------
  async function load(){
    try {
      Sessions = await api('sessions');
      Catalog = await api('catalog');

      // Fill selects in modal
      $('#ccs-f-board').innerHTML = (Catalog.boards||[]).map(b=>`<option value="${b.key}">${b.name}</option>`).join('');
      $('#ccs-f-card').innerHTML  = (Catalog.cardsets||[]).map(c=>`<option value="${c.key}">${c.name}</option>`).join('');

      render();
    } catch (e){
      console.error(e);
      alert('Fehler beim Laden: ' + e.message);
    }
  }

  // ---------- New Session flow ----------
  window.ccsNewSession = async function(){
    if(!Catalog.boards.length || !Catalog.cardsets.length){
      Catalog = await api('catalog');
    }
    $('#ccs-f-board').innerHTML = (Catalog.boards||[]).map(b=>`<option value="${b.key}">${b.name}</option>`).join('');
    $('#ccs-f-card').innerHTML  = (Catalog.cardsets||[]).map(c=>`<option value="${c.key}">${c.name}</option>`).join('');
    openModal(); $('#ccs-f-name').focus();
  };

  $('#ccs-cancel')?.addEventListener('click', (e)=>{ e.preventDefault(); closeModal(); });
  $('#ccs-create')?.addEventListener('click', async (e)=>{
    e.preventDefault();
    const name = $('#ccs-f-name').value.trim();
    const password = $('#ccs-f-pass').value;
    const board_key = $('#ccs-f-board').value;
    const cardset_key = $('#ccs-f-card').value;
    if(!name){ alert('Bitte einen Namen eingeben.'); return; }
    await api('sessions','POST',{ name, password, board_key, cardset_key });
    closeModal();
    await load();
  });

  // Filter wechseln
  $('#ccs-filter')?.addEventListener('change', render);

  // Close modal on backdrop
  $('#ccs-modal')?.addEventListener('click', (e)=>{ if(e.target.id === 'ccs-modal'){ closeModal(); }});

  document.addEventListener('DOMContentLoaded', load);
})();
