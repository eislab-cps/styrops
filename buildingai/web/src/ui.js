// === Equipment search ===
document.getElementById('searchEquipment').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const results = document.getElementById('eqSearchResults');
  if (q.length < 1) { results.innerHTML = ''; return; }

  let matches = equipment.filter(eq =>
    (eq.name && eq.name.toLowerCase().includes(q)) ||
    (eq.type && eq.type.toLowerCase().includes(q)) ||
    (eq.room && eq.room.toLowerCase().includes(q)) ||
    (eq.status && eq.status.toLowerCase().includes(q)) ||
    (eq.id && eq.id.toLowerCase().includes(q)) ||
    (eq.details?.model && eq.details.model.toLowerCase().includes(q))
  ).slice(0, 10);

  results.innerHTML = matches.map(eq => {
    const sc = eq.status === 'running' ? '#00e676' : eq.status === 'warning' ? '#ffab00' : '#ff1744';
    const levelKey = eq.level;
    const fullLevel = LEVELS.find(l => l.endsWith(levelKey));
    const levelIdx = fullLevel ? LEVELS.indexOf(fullLevel) : 0;
    let overdueTag = '';
    if (eq.inspection) {
      const nextDate = new Date(new Date(eq.inspection.last_inspected).getTime() + eq.inspection.interval_days * 86400000);
      const daysUntil = Math.ceil((nextDate - new Date()) / 86400000);
      if (daysUntil < 0) overdueTag = ' <span style="color:#ff1744;font-weight:bold">OVERDUE</span>';
      else if (daysUntil < 14) overdueTag = ` <span style="color:#ffab00">${daysUntil}d</span>`;
    }
    return `<div class="pop-item" style="border-left:3px solid ${sc}"
          onclick="window._eqZoom('${eq.room}','${fullLevel||''}','${eq.id}')">
      <span style="color:${sc}">${eq.name}${overdueTag}</span>
      <span class="pop-dim">${eq.room} · F${levelIdx}</span>
    </div>`;
  }).join('');
});

document.getElementById('searchEquipment').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = document.getElementById('eqSearchResults').querySelector('div');
    if (first) first.click();
  }
});

function _escape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

window._renderEquipmentInfo = function(eq) {
  if (!eq) return;
  const sc = eq.status === 'running' ? '#00e676' : eq.status === 'warning' ? '#ffab00' : '#ff1744';
  let html = `<b style="color:${sc}">${_escape(eq.name)}</b> <span style="color:${sc}">${_escape((eq.status||'').toUpperCase())}</span>`;
  html += `<br><span style="color:#aaa">Room: ${_escape(eq.room)} | ${_escape(eq.details?.model || eq.type)}</span>`;
  if (eq.inspection) {
    const lastDate = new Date(eq.inspection.last_inspected);
    const nextDate = new Date(lastDate.getTime() + eq.inspection.interval_days * 86400000);
    const daysUntil = Math.ceil((nextDate - new Date()) / 86400000);
    const overdue = daysUntil < 0;
    html += `<br><span style="color:${overdue ? '#ff1744' : '#aaa'}">Last: ${_escape(eq.inspection.last_inspected)}`;
    html += overdue ? ` <b>OVERDUE ${-daysUntil}d</b>` : ` (next in ${daysUntil}d)`;
    html += `</span>`;
  }

  const notes = Array.isArray(eq.notes) ? eq.notes : [];
  const sorted = notes.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  html += '<div style="margin-top:6px"><b style="color:#8ab4f8">Notes (' + sorted.length + ')</b></div>';
  if (sorted.length > 0) {
    html += '<div style="font-size:10px;color:#ddd;max-height:160px;overflow-y:auto;border:1px solid #2a3a5c;border-radius:3px;padding:4px;margin-top:2px">';
    for (const note of sorted) {
      const ts = note.timestamp ? new Date(note.timestamp).toLocaleString() : '';
      html += `<div style="border-left:2px solid #4a6fa5;padding-left:5px;margin:3px 0">`;
      html += `<div style="color:#888;font-size:9px">${_escape(ts)} · ${_escape(note.author || 'unknown')} `;
      html += `<a href="#" onclick="event.preventDefault();window._deleteNote('${_escape(eq.id)}','${_escape(note.id)}')" style="color:#8a5555;margin-left:4px">✕</a></div>`;
      html += `<div style="white-space:pre-wrap">${_escape(note.text)}</div>`;
      html += `</div>`;
    }
    html += '</div>';
  }
  html += `<button onclick="window._showNoteForm('${_escape(eq.id)}')" style="margin-top:6px;padding:4px 10px;background:#2a3a5c;color:#8ab4f8;border:1px solid #4a6fa5;border-radius:3px;cursor:pointer;font-size:11px">+ Add Note</button>`;
  html += '<div id="noteFormContainer"></div>';

  setInfoCard(html, eq.name);
};

window._refreshEquipmentInfo = async function(eqId) {
  try {
    const resp = await fetch(`/api/equipment/${encodeURIComponent(eqId)}?t=${Date.now()}`);
    if (!resp.ok) return;
    const eq = await resp.json();
    // Keep local cache in sync
    const idx = equipment.findIndex(e => e.id === eqId);
    if (idx >= 0) equipment[idx] = eq;
    window._renderEquipmentInfo(eq);
  } catch (e) { console.warn('refresh equipment failed', e); }
};

window._eqZoom = function(roomName, level, eqId) {
  if (level) searchAndZoom(roomName, level);
  window._refreshEquipmentInfo(eqId);
};

window._showEquipmentInfo = function(eq) {
  if (!eq) return;
  window._renderEquipmentInfo(eq);
  window._refreshEquipmentInfo(eq.id); // fetch fresh notes
};

window._showNoteForm = function(eqId) {
  const container = document.getElementById('noteFormContainer') || document.getElementById('info-content');
  const existing = document.getElementById('noteForm');
  if (existing) { existing.remove(); return; }

  const form = document.createElement('div');
  form.id = 'noteForm';
  form.style.cssText = 'margin-top:6px;padding:6px;background:rgba(42,58,92,0.5);border:1px solid #4a6fa5;border-radius:4px;';
  form.innerHTML = `
    <input type="text" id="noteAuthor" placeholder="Your name" style="width:100%;padding:3px 6px;margin-bottom:4px;background:#1a1a2e;color:#e0e0e0;border:1px solid #4a6fa5;border-radius:3px;font-size:11px;">
    <textarea id="noteText" placeholder="Inspection note..." rows="3" style="width:100%;padding:3px 6px;margin-bottom:4px;background:#1a1a2e;color:#e0e0e0;border:1px solid #4a6fa5;border-radius:3px;font-size:11px;resize:vertical;font-family:inherit;"></textarea>
    <div style="display:flex;gap:4px">
      <button onclick="window._saveNote('${eqId}')" style="flex:1;padding:4px;background:#1a3a2a;color:#00e676;border:1px solid #00e676;border-radius:3px;cursor:pointer;font-size:11px">Save</button>
      <button onclick="document.getElementById('noteForm').remove()" style="flex:1;padding:4px;background:#2a3a5c;color:#aaa;border:1px solid #4a6fa5;border-radius:3px;cursor:pointer;font-size:11px">Cancel</button>
    </div>
    <div id="noteSaveStatus" style="font-size:10px;color:#aaa;margin-top:2px"></div>
  `;
  container.appendChild(form);
  document.getElementById('noteText').focus();
};

window._saveNote = async function(eqId) {
  const text = document.getElementById('noteText').value.trim();
  const author = document.getElementById('noteAuthor').value.trim();
  const status = document.getElementById('noteSaveStatus');
  if (!text) { status.textContent = 'Note cannot be empty'; status.style.color = '#e04040'; return; }

  const note = {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    author: author || 'unknown',
    text: text
  };

  status.textContent = 'Saving...';
  status.style.color = '#aaa';

  try {
    const resp = await fetch(`/api/equipment/${encodeURIComponent(eqId)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note)
    });
    if (resp.ok) {
      status.textContent = 'Saved';
      status.style.color = '#00e676';
      // Nudge other sessions so their panels / indicators refresh
      fetch('/api/equipment/notify', { method: 'POST' }).catch(() => {});
      setTimeout(() => {
        const form = document.getElementById('noteForm');
        if (form) form.remove();
        window._refreshEquipmentInfo(eqId);
      }, 500);
    } else {
      const body = await resp.json().catch(() => ({}));
      status.textContent = 'Save failed: ' + (body.error || resp.status);
      status.style.color = '#e04040';
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    status.style.color = '#e04040';
  }
};

window._deleteNote = async function(eqId, noteId) {
  if (!confirm('Delete this note?')) return;
  try {
    const resp = await fetch(`/api/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
    if (resp.ok) {
      fetch('/api/equipment/notify', { method: 'POST' }).catch(() => {});
      window._refreshEquipmentInfo(eqId);
    }
  } catch (e) { console.warn('delete note failed', e); }
};

// === Click equipment sprite on map to open info panel ===
(() => {
  let downPos = null;
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    downPos = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  canvas.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !downPos) return;
    const dx = e.clientX - downPos.x, dy = e.clientY - downPos.y;
    const moved = Math.hypot(dx, dy);
    const elapsed = Date.now() - downPos.t;
    downPos = null;
    if (moved > 5 || elapsed > 400) return; // treat as drag, not click

    // 2D clicks on equipment are handled by editor.js mousedown handler
    if (!is3DView) return;

    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, activeCamera);

    // Gather all clickable equipment sprites (have attached equipment userData and are visible)
    const sprites = [];
    for (const level in equipmentGroups) {
      const g = equipmentGroups[level];
      if (!g || !g.visible) continue;
      for (const s of g.children) {
        if (!s.visible || !s.isSprite) continue;
        if (!s.userData || !s.userData.equipment) continue;
        sprites.push(s);
      }
    }
    if (sprites.length === 0) return;
    const hits = raycaster.intersectObjects(sprites);
    if (hits.length === 0) return;
    const eq = hits[0].object.userData.equipment;
    window._showEquipmentInfo(eq);
    e.stopPropagation();
  });
})();

window.addEventListener('resize', () => {
  renderer.setSize(viewerW(),viewerH(),false);
  camera3D.aspect=viewerW()/viewerH();camera3D.updateProjectionMatrix();
  updateCamera2D();render();
});

init();
animate();
