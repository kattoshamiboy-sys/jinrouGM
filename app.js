// ==========================================
// NextGen Werewolf GM Tool — v6 (Refactored)
// ==========================================

// --- CONSTANTS & CONFIG ---
const ROLES_INFO = {
  '人狼': { icon: '🐺', team: 'wolf', theme: 'theme-wolf', desc: '毎晩1人を仲間と相談して襲撃します。' },
  '狂人': { icon: '🃏', team: 'wolf', theme: 'theme-wolf', desc: '人狼陣営として勝利します。占い結果は「白」です。' },
  '占い師': { icon: '🔮', team: 'village', theme: 'theme-seer', desc: '毎夜1人を占い、人狼か否かを判定できます。' },
  '霊能者': { icon: '👁', team: 'village', theme: 'theme-seer', desc: '処刑されたプレイヤーが人狼かどうかを確認できます。' },
  '騎士': { icon: '🛡', team: 'village', theme: 'theme-knight', desc: '毎夜1人を護衛します（連続護衛不可）。' },
  '村人': { icon: '🏘️', team: 'village', theme: '', desc: '特殊能力はありません。議論と投票で人狼を見つけましょう。' },
};

const MAX_PLAYERS = 13;

// Dynamic role composition based on player count
function buildRoleList(count) {
  if (count < 5 || count > MAX_PLAYERS) return null;
  if (count <= 6)  return ['人狼', '占い師', '騎士', ...Array(count - 3).fill('村人')];
  if (count <= 8)  return ['人狼', '人狼', '占い師', '霊能者', ...Array(count - 4).fill('村人')];
  if (count <= 11) return ['人狼', '人狼', '狂人', '占い師', '霊能者', '騎士', ...Array(count - 6).fill('村人')];
  return ['人狼', '人狼', '人狼', '狂人', '占い師', '霊能者', '騎士', ...Array(count - 7).fill('村人')];
}

// --- PERSISTENT UID ---
function getOrCreateUid() {
  let uid = sessionStorage.getItem('jinrou_uid');
  if (!uid) {
    uid = Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem('jinrou_uid', uid);
  }
  return uid;
}

// --- STATE ---
let myRoomId = sessionStorage.getItem('jinrou_roomId') || null;
let myUid = getOrCreateUid();
let gameState = null;
let lastPhase = null;
let lastDay = null;
let isGM = sessionStorage.getItem('jinrou_isGM') === 'true';
const seenLogs = new Set();

// --- DOM HELPERS ---
const el = (id) => document.getElementById(id);
const views = { lobby: el('view-lobby'), waiting: el('view-waiting'), app: el('view-app'), gm: el('view-gm'), kifu: el('view-kifu') };

function switchView(viewName) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[viewName].classList.add('active');
}

function toast(msg) {
  const t = el('lobby-toast');
  if (!t) return;
  t.textContent = msg;
  t.style.opacity = 1;
  setTimeout(() => t.style.opacity = 0, 3000);
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// --- ROOM ID GENERATION (3-digit number: 100-999) ---
function generateRoomId() {
  return String(Math.floor(Math.random() * 900) + 100);
}

// --- TABS ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    e.target.classList.add('active');
    el(e.target.dataset.target).classList.add('active');
  });
});

// ==========================================
// LOCAL STORAGE DB ENGINE
// ==========================================
function loadDB() {
  try {
    const d = localStorage.getItem('jinrou_db');
    return d ? JSON.parse(d) : { rooms: {} };
  } catch (e) {
    return { rooms: {} };
  }
}

function saveDB(db) {
  localStorage.setItem('jinrou_db', JSON.stringify(db));
  refreshStateFromDB(db);
}

// 自分が参加していない終了済みルームをlocalStorageから削除してストレージ肥大化を防ぐ
function cleanupFinishedRooms() {
  try {
    const db = loadDB();
    let changed = false;
    Object.keys(db.rooms).forEach(rid => {
      if (rid !== myRoomId && db.rooms[rid]?.public?.status === 'finished') {
        delete db.rooms[rid];
        changed = true;
      }
    });
    if (changed) localStorage.setItem('jinrou_db', JSON.stringify(db));
  } catch (e) { /* ignore */ }
}

// Atomic read-modify-write to reduce race conditions
function updateRoom(roomId, mutator) {
  const db = loadDB();
  const room = db.rooms[roomId];
  if (!room) return null;
  mutator(room, db);
  saveDB(db);
  return room;
}

window.addEventListener('storage', (e) => {
  if (e.key === 'jinrou_db' && e.newValue) {
    try { refreshStateFromDB(JSON.parse(e.newValue)); } catch (err) { /* ignore parse errors */ }
  }
});

let _popupRecheckTimer = null;
function refreshStateFromDB(db) {
  if (!myRoomId) return;
  const room = db.rooms[myRoomId];
  if (!room) return;
  const dayVotes = room.votes[room.public.day] || {};
  gameState = { public: room.public, private: room.private[myUid] || {}, votes: dayVotes };
  renderState();
  // Delayed recheck — ensures seer/medium popups fire even if storage event arrives
  // slightly before the phase transition settles across tabs
  clearTimeout(_popupRecheckTimer);
  _popupRecheckTimer = setTimeout(() => {
    if (gameState) checkNewResultLogs(gameState.public, gameState.private);
  }, 400);
}

// ==========================================
// AUTO-REJOIN ON RELOAD
// ==========================================
(function tryAutoRejoin() {
  if (!myRoomId) return;
  const db = loadDB();
  const room = db.rooms[myRoomId];
  if (!room || !room.public.players[myUid]) {
    sessionStorage.removeItem('jinrou_roomId');
    sessionStorage.removeItem('jinrou_isGM');
    myRoomId = null;
    isGM = false;
    return;
  }
  // Restore GM flag from stored player data
  if (room.public.players[myUid]?.isGM) {
    isGM = true;
    sessionStorage.setItem('jinrou_isGM', 'true');
  }
  refreshStateFromDB(db);
  if (room.public.status === 'waiting') {
    if (isGM) switchView('gm');
    else enterRoom(myRoomId);
  }
  cleanupFinishedRooms();
})();

// ==========================================
// LOBBY ACTIONS
// ==========================================
el('btn-create').addEventListener('click', () => {
  const name = el('create-name').value.trim();
  if (!name) return toast('名前を入力してください');

  const db = loadDB();
  let roomId;
  do { roomId = generateRoomId(); } while (db.rooms[roomId]);

  db.rooms[roomId] = {
    public: { id: roomId, status: 'waiting', phase: 'discuss', day: 1, players: {}, days: [] },
    private: {},
    votes: {}
  };
  db.rooms[roomId].public.players[myUid] = { uid: myUid, name, isAlive: true, isHost: true, voteStatus: 'pending' };
  db.rooms[roomId].private[myUid] = { role: null, actionLog: [], wolfMates: [] };

  myRoomId = roomId;
  sessionStorage.setItem('jinrou_roomId', roomId);
  saveDB(db);
  enterRoom(roomId);
});

el('btn-join').addEventListener('click', () => {
  const roomId = el('join-roomId').value.trim();
  const name = el('join-name').value.trim();
  if (!roomId || !name) return toast('IDと名前を入力してください');
  if (!/^\d{3}$/.test(roomId)) return toast('ルームIDは3桁の数字で入力してください');

  const db = loadDB();
  const room = db.rooms[roomId];
  if (!room) return toast('ルームが見つかりません');

  // 自分のUIDが既にルームにある場合はそのまま再入室（なりすまし防止）
  if (room.public.players[myUid]) {
    myRoomId = roomId;
    sessionStorage.setItem('jinrou_roomId', roomId);
    toast('再入室しました');
    refreshStateFromDB(db);
    return;
  }

  const existingPlayer = Object.values(room.public.players).find(p => p.name === name);
  if (existingPlayer) {
    if (room.public.status === 'playing' || room.public.status === 'finished') {
      // ゲーム中の名前一致再入室は別タブ/別デバイスからの復帰のみ許可
      myUid = existingPlayer.uid;
      sessionStorage.setItem('jinrou_uid', myUid);
      myRoomId = roomId;
      sessionStorage.setItem('jinrou_roomId', roomId);
      toast('再入室しました');
      refreshStateFromDB(db);
      return;
    } else {
      return toast('その名前は既に参加しています');
    }
  }

  if (room.public.status !== 'waiting') return toast('既にゲームが開始されています');

  const currentCount = Object.values(room.public.players).filter(p => !p.isGM).length;
  if (currentCount >= MAX_PLAYERS) return toast(`定員（${MAX_PLAYERS}人）に達しています`);

  const isHost = Object.keys(room.public.players).length === 0;
  room.public.players[myUid] = { uid: myUid, name, isAlive: true, isHost, voteStatus: 'pending' };
  room.private[myUid] = { role: null, actionLog: [], wolfMates: [] };

  myRoomId = roomId;
  sessionStorage.setItem('jinrou_roomId', roomId);
  saveDB(db);
  enterRoom(roomId);
});

// ==========================================
// GM LOBBY ACTIONS
// ==========================================
function gmEnterRoom(roomId) {
  isGM = true;
  myRoomId = roomId;
  sessionStorage.setItem('jinrou_isGM', 'true');
  sessionStorage.setItem('jinrou_roomId', roomId);
  switchView('gm');
}

el('btn-gm-create').addEventListener('click', () => {
  const name = el('gm-name').value.trim() || 'GM';
  const db = loadDB();
  let roomId;
  do { roomId = generateRoomId(); } while (db.rooms[roomId]);

  db.rooms[roomId] = {
    public: { id: roomId, status: 'waiting', phase: 'discuss', day: 1, players: {}, days: [] },
    private: {},
    votes: {}
  };
  db.rooms[roomId].public.players[myUid] = { uid: myUid, name, isAlive: true, isHost: true, isGM: true, voteStatus: 'pending' };
  db.rooms[roomId].private[myUid] = { role: null, actionLog: [], wolfMates: [] };

  saveDB(db);
  gmEnterRoom(roomId);
  refreshStateFromDB(db);
});

el('btn-gm-join').addEventListener('click', () => {
  const roomId = el('gm-roomId').value.trim();
  const name = el('gm-name').value.trim() || 'GM';
  if (!roomId) return toast('ルームIDを入力してください');
  if (!/^\d{3}$/.test(roomId)) return toast('ルームIDは3桁の数字で入力してください');

  const db = loadDB();
  const room = db.rooms[roomId];
  if (!room) return toast('ルームが見つかりません');

  // If already in the room (rejoin)
  const existing = Object.values(room.public.players).find(p => p.uid === myUid);
  if (existing) {
    existing.isGM = true;
    existing.isHost = true;
    saveDB(db);
    gmEnterRoom(roomId);
    refreshStateFromDB(db);
    return;
  }

  // Transfer host from existing host if any
  Object.values(room.public.players).forEach(p => { p.isHost = false; });
  room.public.players[myUid] = { uid: myUid, name, isAlive: true, isHost: true, isGM: true, voteStatus: 'pending' };
  room.private[myUid] = { role: null, actionLog: [], wolfMates: [] };

  saveDB(db);
  gmEnterRoom(roomId);
  refreshStateFromDB(db);
});

// ==========================================
// GAME START
// ==========================================
el('btn-start').addEventListener('click', () => {
  const db = loadDB();
  const room = db.rooms[myRoomId];
  if (!room || !room.public.players[myUid]?.isHost) return;

  const pids = Object.keys(room.public.players).filter(pid => !room.public.players[pid].isGM);
  if (pids.length < 5) { toast('5人以上必要です'); return; }

  const roles = buildRoleList(pids.length);
  if (!roles) { toast('5人以上必要です'); return; }

  // Count each role
  const counts = {};
  roles.forEach(r => counts[r] = (counts[r] || 0) + 1);

  // Build role breakdown HTML
  const roleOrder = ['人狼', '狂人', '占い師', '霊能者', '騎士', '村人'];
  let breakdownHtml = '<div class="role-breakdown">';
  roleOrder.forEach(r => {
    if (!counts[r]) return;
    const info = ROLES_INFO[r];
    breakdownHtml += `<div class="role-breakdown-row">
      <span class="role-breakdown-icon">${info.icon}</span>
      <span class="role-breakdown-name">${r}</span>
      <span class="role-breakdown-count">×${counts[r]}</span>
    </div>`;
  });
  breakdownHtml += '</div>';

  const warning = pids.length < MAX_PLAYERS
    ? `<div class="confirm-warning">⚠ 定員${MAX_PLAYERS}人に対して現在${pids.length}人です</div>`
    : '';

  showConfirmDialog(
    `${pids.length}人でゲームを開始`,
    `${warning}<div style="margin-top:12px;margin-bottom:4px;font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;">役職内訳</div>${breakdownHtml}`,
    () => startGame()
  );
});

function startGame() {
  updateRoom(myRoomId, (room) => {
    if (!room.public.players[myUid]?.isHost) return;

    // Only non-GM players get roles
    const pids = Object.keys(room.public.players).filter(pid => !room.public.players[pid].isGM);
    const roles = buildRoleList(pids.length);
    if (!roles) { toast('5人以上必要です'); return; }

    room.public.status = 'playing';
    room.public.phase = 'confirm';
    room.public.day = 1;
    room.public.days = [{ exec: null, attack: null, attackBlocked: false }];
    room.votes[1] = { voteOrder: [], runoffOrder: [], wolfVotes: {}, wolfCandidates: [], wolfCandidateSetBy: null, seerVotes: {}, knightVotes: {}, speechFinished: [] };

    // Shuffle
    for (let i = pids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pids[i], pids[j]] = [pids[j], pids[i]];
    }

    const wolves = [];
    pids.forEach((pid, idx) => {
      const role = roles[idx] || '村人';
      room.private[pid] = { role, actionLog: [], lastGuarded: null };
      if (role === '人狼') wolves.push(pid);
    });
    pids.forEach(pid => {
      if (room.private[pid].role === '人狼') room.private[pid].wolfMates = wolves.filter(w => w !== pid);
    });

    // Seer Day 0
    const seerUid = Object.keys(room.private).find(id => room.private[id].role === '占い師');
    if (seerUid) {
      const whiteCandidates = pids.filter(id => id !== seerUid && room.private[id].role !== '人狼');
      if (whiteCandidates.length > 0) {
        const target = whiteCandidates[Math.floor(Math.random() * whiteCandidates.length)];
        room.private[seerUid].actionLog.push({
          _id: `log_${Date.now()}_${Math.random().toString(36).substr(2,5)}`,
          day: 1, type: '占い', targetName: room.public.players[target].name, result: '白'
        });
      }
    }
  });
}

// ==========================================
// PHASE CONTROL
// ==========================================
function setPhase(phase) {
  updateRoom(myRoomId, (room) => {
    if (!room.public.players[myUid]?.isHost && !room.public.players[myUid]?.isGM) return;
    room.public.phase = phase;
    if (phase === 'vote' || phase === 'runoff') {
      Object.values(room.public.players).forEach(p => { if (p.isAlive && !p.isGM) p.voteStatus = 'pending'; });
    }
  });
}

function enterRoom(roomId) {
  myRoomId = roomId;
  switchView('waiting');
  el('display-roomId').textContent = roomId;
}

// ==========================================
// RENDERING
// ==========================================

function renderState() {
  if (!gameState) return;
  const { public: pub, private: priv, votes } = gameState;

  // GM gets a dedicated view
  if (isGM) { renderGMState(pub, votes); return; }

  if (pub.status === 'waiting') {
    switchView('waiting');
    const pids = Object.keys(pub.players);
    const nonGMPids = pids.filter(pid => !pub.players[pid].isGM);
    const gmPids = pids.filter(pid => pub.players[pid].isGM);
    el('waiting-count').textContent = `${nonGMPids.length} / ${MAX_PLAYERS}`;
    el('waiting-players-list').innerHTML = nonGMPids.map(pid => {
      const p = pub.players[pid];
      return `<li class="player-item ${pid === myUid ? 'is-me' : ''}">
        <div class="p-status-dot"></div>
        <div class="p-name">${escHtml(p.name)} ${p.isHost ? '👑' : ''}</div>
      </li>`;
    }).join('');
    // GM separate section
    let gmSection = el('waiting-gm-section');
    if (!gmSection) {
      gmSection = document.createElement('div');
      gmSection.id = 'waiting-gm-section';
      el('waiting-players-list').parentNode.insertAdjacentElement('afterend', gmSection);
    }
    if (gmPids.length > 0) {
      gmSection.innerHTML = `<div class="waiting-gm-box"><span class="p-tag gm-tag" style="margin-right:6px;">GM</span>${gmPids.map(pid => escHtml(pub.players[pid].name)).join(', ')}</div>`;
    } else {
      gmSection.innerHTML = '';
    }
    el('btn-start').style.display = pub.players[myUid]?.isHost && !pub.players[myUid]?.isGM ? 'block' : 'none';
    el('waiting-helper').textContent = pub.players[myUid]?.isHost && !pub.players[myUid]?.isGM ? '全員が揃ったら開始してください' : 'ホストの開始を待っています...';
    return;
  }

  switchView('app');

  if (lastPhase !== pub.phase) { applyPhaseVFX(pub.phase); lastPhase = pub.phase; }
  if (lastDay !== pub.day) { lastDay = pub.day; }

  const phaseMap = {
    confirm: ['🔍 確認', 'phase-day'], discuss: ['☀ 昼議論', 'phase-day'],
    vote: ['⚖ 投票', 'phase-vote'], speech: ['🗣 弁明', 'phase-day'],
    runoff: ['⚡ 決戦投票', 'phase-vote'], will: ['📜 遺言', 'phase-day'],
    night: ['🌙 夜行動', 'phase-night']
  };
  const [pText, pClass] = phaseMap[pub.phase] || ['--', ''];
  el('app-phase-badge').className = `phase-badge ${pClass}`;
  el('app-phase-badge').textContent = pText;
  el('app-day-label').textContent = `${pub.day}日目`;
  el('app-host-badge').style.display = pub.players[myUid]?.isHost ? 'block' : 'none';
  el('host-panel').style.display = pub.players[myUid]?.isHost ? 'block' : 'none';

  const playersArr = Object.values(pub.players).filter(p => !p.isGM);
  el('app-alive-count').textContent = `生存 ${playersArr.filter(p => p.isAlive).length}人`;
  el('app-players-list').innerHTML = playersArr.map(p =>
    `<li class="player-item ${!p.isAlive ? 'is-dead' : ''} ${p.uid === myUid ? 'is-me' : ''}">
      <div class="p-status-dot"></div>
      <div class="p-name">${escHtml(p.name)}</div>
      <div class="p-tags">
        ${p.uid === myUid ? '<span class="p-tag me">あなた</span>' : ''}
        ${p.isAlive && (pub.phase === 'vote' || pub.phase === 'runoff') && p.voteStatus === 'voted' ? '<span class="p-tag voted">投票済</span>' : ''}
      </div>
    </li>`
  ).join('');

  if (pub.status === 'finished') { renderResultScreen(pub); return; }

  renderRoleCard(priv);
  renderAnnouncements(pub);
  renderActionCallout(pub, priv, votes);
  renderPrivateLogs(priv);
  checkNewResultLogs(pub, priv);
}

function renderResultScreen(pub) {
  const db = loadDB();
  const allPrivs = db.rooms[myRoomId]?.private || {};

  el('app-phase-badge').textContent = '🎉 ゲーム終了';
  el('app-phase-badge').className = 'phase-badge';
  el('app-alive-count').textContent = pub.winner === 'village' ? '村人陣営の勝利' : '人狼陣営の勝利';
  el('action-callout-area').innerHTML = `<div class="action-callout" style="text-align:center"><h3>${escHtml(pub.winReason || '')}</h3><p style="margin-top:8px">お疲れ様でした！</p><button class="btn outline btn-large" style="margin-top:16px" onclick="openKifu()">📜 棋譜を見る</button></div>`;
  el('announcements-area').innerHTML = '';
  el('role-render-area').innerHTML = '';
  el('private-logs-area').innerHTML = '';

  let html = `<h3 style="margin:20px 0 10px; color:var(--text); text-align:center;">👥 最終役職一覧</h3>`;
  Object.values(pub.players).forEach(p => {
    const pRole = allPrivs[p.uid]?.role || '不明';
    const rInfo = ROLES_INFO[pRole] || ROLES_INFO['村人'];
    html += `<li class="player-item ${!p.isAlive ? 'is-dead' : ''}">
      <div class="p-status-dot"></div>
      <div class="p-name">${escHtml(p.name)} <span style="font-size:12px;color:var(--text-muted)">(${pRole})</span></div>
      <div class="p-tags">${pRole === '人狼' ? '🐺' : rInfo.icon}</div>
    </li>`;
  });
  el('app-players-list').innerHTML = html;
}

function checkNewResultLogs(pub, priv) {
  if (!priv?.actionLog) return;
  priv.actionLog.forEach(log => {
    const logId = log._id || `${log.day}-${log.type}-${log.targetName}`;
    if (!seenLogs.has(logId)) {
      if (log.type === '霊能' && pub.phase !== 'night') return;
      showBigPopup(`${log.type}結果`, `<div style="font-size:20px;margin-top:12px;"><strong>${escHtml(log.targetName)}</strong> は <br><strong style="font-size:28px; color:${log.result === '黒' ? 'var(--wolf)' : '#7ab3f5'}">${log.result}</strong> でした。</div>`);
      seenLogs.add(logId);
    }
  });
}

function showBigPopup(title, htmlContent) {
  let modal = document.getElementById('result-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'result-modal';
    modal.innerHTML = `<div class="modal-bg" id="modal-bg-close"></div><div class="modal-content"><h2 id="modal-title"></h2><div id="modal-body"></div><button class="btn primary btn-large" style="margin-top:20px; width:100%" id="modal-close-btn">確認</button></div>`;
    document.body.appendChild(modal);
    document.getElementById('modal-close-btn').addEventListener('click', () => modal.style.display = 'none');
    document.getElementById('modal-bg-close').addEventListener('click', () => modal.style.display = 'none');
  }
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = htmlContent;
  modal.style.display = 'block';
}

function showConfirmDialog(title, message, onConfirm) {
  let modal = document.getElementById('confirm-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'confirm-modal';
    modal.innerHTML = `<div class="modal-bg"></div>
      <div class="modal-content">
        <h2 id="confirm-title"></h2>
        <div id="confirm-body" style="margin-top:12px;font-size:15px;color:var(--text-muted)"></div>
        <div style="display:flex;gap:12px;margin-top:24px">
          <button class="btn outline btn-large" id="confirm-cancel" style="flex:1">キャンセル</button>
          <button class="btn alert btn-large" id="confirm-ok" style="flex:1">開始する</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('confirm-cancel').addEventListener('click', () => modal.style.display = 'none');
  }
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').innerHTML = message;
  const okBtn = document.getElementById('confirm-ok');
  const newOk = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  newOk.addEventListener('click', () => {
    modal.style.display = 'none';
    onConfirm();
  });
  modal.style.display = 'block';
}

function renderRoleCard(priv) {
  const container = el('role-render-area');
  if (!priv?.role) { container.innerHTML = ''; return; }
  const info = ROLES_INFO[priv.role] || ROLES_INFO['村人'];
  const pub = gameState?.public;
  const isAlive = pub?.players[myUid]?.isAlive;

  let wolfInfo = '';
  if (priv.wolfMates?.length > 0 && pub) {
    const names = priv.wolfMates.map(uid => pub.players[uid]?.name).filter(Boolean).map(n => escHtml(n)).join(', ');
    if (names) wolfInfo = `<div style="margin-top:12px;font-size:12px;color:var(--text-muted);">仲間: ${names}</div>`;
  }

  let deathMsg = '';
  if (!isAlive && pub) {
    const cause = findDeathCause(pub, myUid);
    deathMsg = `<div class="role-death-msg">${cause}</div>`;
  }

  const themeClass = isAlive ? info.theme : 'theme-dead';

  container.innerHTML = `<div class="role-card ${themeClass}">
    <div class="role-icon">${info.icon}</div>
    <div class="role-name">${priv.role}</div>
    <div class="role-desc">${info.desc}</div>${wolfInfo}${deathMsg}</div>`;
}

function findDeathCause(pub, uid) {
  if (!pub.days) return 'あなたは死亡しました';
  for (let i = 0; i < pub.days.length; i++) {
    const d = pub.days[i];
    const dayNum = i + 1;
    if (d.exec === uid) return `あなたは${dayNum}日目に処刑されました`;
    if (d.attack === uid && !d.attackBlocked) return `あなたは${dayNum}日目の夜に襲撃されました`;
  }
  return 'あなたは死亡しました';
}

function renderAnnouncements(pub) {
  const area = el('announcements-area');
  let html = '';
  const yesterday = pub.days[pub.day - 2];
  const today = pub.days[pub.day - 1];

  if (yesterday) {
    if (yesterday.attackBlocked) {
      html += `<div class="announcement gj">🕊 昨晩は誰の死体も発見されませんでした。平和な朝です。</div>`;
    } else if (yesterday.attack && pub.players[yesterday.attack]) {
      html += `<div class="announcement death">🐺 昨晩、<strong>${escHtml(pub.players[yesterday.attack].name)}</strong> が無惨な姿で発見されました。</div>`;
    }
  }
  if (today?.exec && pub.players[today.exec]) {
    html += `<div class="announcement exec">⚖ 投票の結果、<strong>${escHtml(pub.players[today.exec].name)}</strong> が処刑されました。</div>`;
  }
  area.innerHTML = html;
}

function renderPrivateLogs(priv) {
  const area = el('private-logs-area');
  if (!priv?.actionLog?.length) { area.innerHTML = ''; return; }
  area.innerHTML = `<div class="card" style="margin-top:16px;"><h3 class="card-title">📖 あなたの記録</h3>
    <ul style="list-style:none; font-size:14px;">${priv.actionLog.map(l =>
      `<li style="display:flex; justify-content:space-between; padding: 8px 0; border-bottom:1px solid var(--border);">
        <span><span style="color:var(--text-muted);font-size:11px;margin-right:8px;">${l.day}日目</span> ${escHtml(l.targetName)}</span>
        <span style="font-weight:bold; color:${l.result === '黒' ? 'var(--wolf)' : '#7ab3f5'}">${l.result}</span>
      </li>`).join('')}</ul></div>`;
}

function renderActionCallout(pub, priv, votes) {
  const area = el('action-callout-area');
  area.innerHTML = '';
  const meAlive = pub.players[myUid]?.isAlive;
  const isHost = pub.players[myUid]?.isHost;

  // Dead player — show observer message but allow host to keep operating
  if (!meAlive && pub.status !== 'finished') {
    const cause = findDeathCause(pub, myUid);
    area.innerHTML = `<div class="action-callout theme-dead-callout">
      <p style="font-size:15px;">💀 ${cause}</p>
      <p style="margin-top:8px;color:var(--text-dim);font-size:13px;">ゲームの行方を見守りましょう。</p>
    </div>`;
    // Dead host still gets host buttons
    if (isHost) renderHostCalloutButtons(area, pub, votes);
    return;
  }

  if (pub.status === 'finished') return;

  if (pub.phase === 'confirm') {
    area.innerHTML = `<div class="action-callout"><h3>🔍 確認フェーズ</h3><p>ご自身の役職をご確認ください。<br>全員の確認完了後、昼の議論へ移行します。</p></div>`;
    if (isHost) area.innerHTML += `<button class="btn primary" style="width:100%;margin-top:10px;" data-action="setPhase" data-phase="discuss">☀️ 議論を開始する</button>`;
  }

  if (pub.phase === 'discuss') {
    area.innerHTML = `<div class="action-callout"><h3>☀️ 昼議論</h3><p>全員で話し合い、誰が人狼か推測してください。</p></div>`;
    if (isHost) area.innerHTML += `<button class="btn alert" style="width:100%;margin-top:10px;" data-action="setPhase" data-phase="vote">⚖️ 投票へ</button>`;
  }

  if (pub.phase === 'vote') {
    if (pub.players[myUid].voteStatus === 'pending') {
      area.innerHTML = `<div class="action-callout"><h3>⚖ 投票フェーズ</h3><button class="btn primary btn-large" data-action="openVoteSheet">投票を行う</button></div>`;
    } else {
      area.innerHTML = `<div class="action-callout"><p>投票完了。<br>全員の投票を待っています...</p></div>`;
    }
    let vList = '';
    Object.values(pub.players).filter(p => p.isAlive).forEach(p => {
      const vRec = votes?.voteOrder?.find(o => o.uid === p.uid);
      const targetName = vRec ? (pub.players[vRec.targetId]?.name || '不明') : '（未投票）';
      vList += `<div style="font-size:14px; padding:4px 0;">${escHtml(p.name)} ➔ <strong style="color:var(--accent)">${escHtml(targetName)}</strong></div>`;
    });
    area.innerHTML += `<div class="card" style="margin-top:12px"><h4>投票状況</h4>${vList}</div>`;
    if (isHost) area.innerHTML += `<button class="btn alert outline" style="width:100%;margin-top:10px;" data-action="endVoting">投票を終了する</button>`;
  }

  if (pub.phase === 'speech') {
    const tiedPlayers = votes?.tiedPlayers || [];
    const speechFinished = votes?.speechFinished || [];
    const isTied = tiedPlayers.includes(myUid);
    const hasFinished = speechFinished.includes(myUid);
    // 弁明対象者のリストと進捗を表示
    const statusList = tiedPlayers.map(uid => {
      const name = pub.players[uid]?.name || '?';
      const done = speechFinished.includes(uid);
      return `<div style="font-size:13px;padding:3px 0;color:${done ? 'var(--gm)' : 'var(--text-muted)'}">
        ${done ? '✅' : '⏳'} ${escHtml(name)}
      </div>`;
    }).join('');
    area.innerHTML = `<div class="action-callout" style="border-color:var(--wolf)">
      <h3>🗣 弁明フェーズ</h3>
      <p>投票が同数となりました。<br>該当者は弁明を行ってください。</p>
      <div style="margin-top:10px;">${statusList}</div>
    </div>`;
    if (isTied && !hasFinished) area.innerHTML += `<button class="btn alert" style="width:100%;margin-top:10px;" data-action="finishSpeech">🗣 弁明を終了する</button>`;
    if (isTied && hasFinished) area.innerHTML += `<div style="text-align:center;color:var(--gm);font-size:13px;margin-top:10px;">✅ 弁明済み。他の対象者を待っています...</div>`;
    if (isHost) area.innerHTML += `<button class="btn outline" style="width:100%;margin-top:10px;" data-action="setPhase" data-phase="runoff">⚡ 強制的に決戦投票へ（ホスト）</button>`;
  }

  if (pub.phase === 'runoff') {
    if (pub.players[myUid].voteStatus === 'pending') {
      area.innerHTML = `<div class="action-callout"><h3>⚡ 決戦投票</h3><button class="btn primary btn-large" data-action="openRunoffSheet">決戦投票を行う</button></div>`;
    } else {
      area.innerHTML = `<div class="action-callout"><p>投票完了。<br>集計を待っています...</p></div>`;
    }
    let vList = '';
    Object.values(pub.players).filter(p => p.isAlive).forEach(p => {
      const vRec = votes?.runoffOrder?.find(o => o.uid === p.uid);
      const targetName = vRec ? (pub.players[vRec.targetId]?.name || '不明') : '（未投票）';
      vList += `<div style="font-size:14px; padding:4px 0;">${escHtml(p.name)} ➔ <strong style="color:var(--accent)">${escHtml(targetName)}</strong></div>`;
    });
    area.innerHTML += `<div class="card" style="margin-top:12px"><h4>決戦投票状況</h4>${vList}</div>`;
    if (isHost) area.innerHTML += `<button class="btn alert outline" style="width:100%;margin-top:10px;" data-action="endRunoff">決戦投票を終了する</button>`;
  }

  if (pub.phase === 'will' && votes?.pendingExec) {
    const execName = pub.players[votes.pendingExec]?.name || '不明';
    area.innerHTML = `<div class="action-callout" style="border-color:var(--wolf)"><h3>📜 遺言フェーズ</h3><p><strong>${escHtml(execName)}</strong> が処刑対象に決定しました。<br>最後の遺言を残してください。</p></div>`;
    if (myUid === votes.pendingExec) area.innerHTML += `<button class="btn alert" style="width:100%;margin-top:10px;" data-action="forceExecute">遺言終了 (処刑を受け入れる)</button>`;
    if (isHost) area.innerHTML += `<button class="btn alert outline" style="width:100%;margin-top:10px;" data-action="forceExecute">遺言終了 → 処刑を実行する</button>`;
  }

  if (pub.phase === 'night') {
    if (priv?.role === '人狼') {
      renderWolfNightPanel(area, pub, priv, votes);
    } else if (priv?.role === '占い師') {
      const hasActed = !!votes?.seerVotes?.[myUid];
      if (!hasActed) area.innerHTML = `<div class="action-callout theme-seer"><h3>🌙 夜の行動</h3><button class="btn primary btn-large" data-action="openNightSheet" data-acttype="seer_vote" data-theme="theme-seer">占い先を選ぶ</button></div>`;
      else area.innerHTML = `<div class="action-callout theme-seer"><p>行動完了。<br>夜が明けるのを待っています...</p></div>`;
    } else if (priv?.role === '騎士') {
      const hasActed = !!votes?.knightVotes?.[myUid];
      if (!hasActed) area.innerHTML = `<div class="action-callout theme-knight"><h3>🌙 夜の行動</h3><button class="btn primary btn-large" data-action="openNightSheet" data-acttype="knight_vote" data-theme="theme-knight">護衛先を選ぶ</button></div>`;
      else area.innerHTML = `<div class="action-callout theme-knight"><p>行動完了。<br>夜が明けるのを待っています...</p></div>`;
    } else {
      area.innerHTML = `<div class="action-callout"><p>🌙 夜です。<br>行動が完了するのを待っています...</p></div>`;
    }
  }
}

function renderHostCalloutButtons(area, pub, votes) {
  // Phase-specific host buttons for dead hosts
  if (pub.phase === 'discuss') {
    area.innerHTML += `<button class="btn alert" style="width:100%;margin-top:10px;" data-action="setPhase" data-phase="vote">⚖️ 投票へ</button>`;
  }
  if (pub.phase === 'vote') {
    area.innerHTML += `<button class="btn alert outline" style="width:100%;margin-top:10px;" data-action="endVoting">投票を終了する</button>`;
  }
  if (pub.phase === 'speech') {
    area.innerHTML += `<button class="btn alert" style="width:100%;margin-top:10px;" data-action="setPhase" data-phase="runoff">⚡ 決戦投票へ</button>`;
  }
  if (pub.phase === 'runoff') {
    area.innerHTML += `<button class="btn alert outline" style="width:100%;margin-top:10px;" data-action="endRunoff">決戦投票を終了する</button>`;
  }
  if (pub.phase === 'will' && votes?.pendingExec) {
    area.innerHTML += `<button class="btn alert outline" style="width:100%;margin-top:10px;" data-action="forceExecute">遺言終了 → 処刑を実行する</button>`;
  }
}

// ==========================================
// WOLF NIGHT PANEL — candidate flow + vote visibility
// ==========================================
function renderWolfNightPanel(area, pub, priv, votes) {
  const wolfMates = priv.wolfMates || [];
  const allWolfUids = [myUid, ...wolfMates];
  const aliveWolves = allWolfUids.filter(uid => pub.players[uid]?.isAlive);
  const isSoloWolf = aliveWolves.length <= 1;

  const candidates = votes?.wolfCandidates || [];
  const hasCandidates = candidates.length > 0;
  const myVote = votes?.wolfVotes?.[myUid];
  const iAmCandidateSetter = votes?.wolfCandidateSetBy === myUid;

  let html = '<div class="action-callout theme-wolf"><h3>🌙 襲撃相談</h3>';

  if (isSoloWolf) {
    if (!myVote) {
      html += `<button class="btn primary btn-large" data-action="openNightSheet" data-acttype="wolf_vote" data-theme="theme-wolf">襲撃先を選ぶ</button>`;
    } else {
      html += `<p>行動完了。<br>夜が明けるのを待っています...</p>`;
    }
  } else {
    if (!hasCandidates) {
      html += `<p style="margin-bottom:12px">候補先を選んでください（複数可）。<br>仲間が候補から最終決定します。</p>`;
      html += `<button class="btn primary btn-large" data-action="openWolfCandidateSheet">候補先を提案する</button>`;
    } else if (!iAmCandidateSetter && !myVote) {
      html += `<p style="margin-bottom:12px">仲間が候補を提案しました。<br>襲撃先を決定してください。</p>`;
      html += `<button class="btn primary btn-large" data-action="openWolfFinalSheet">襲撃先を選ぶ</button>`;
    } else {
      html += `<p>行動完了。<br>夜が明けるのを待っています...</p>`;
    }
  }
  html += '</div>';

  // Wolf vote status card
  html += '<div class="card" style="margin-top:12px; border-color:rgba(196,75,46,0.3);">';
  html += '<h4 style="color:var(--wolf);margin-bottom:8px;">🐺 仲間の状況</h4>';

  if (hasCandidates) {
    const candNames = candidates.map(uid => escHtml(pub.players[uid]?.name || '???')).join(', ');
    const setterName = escHtml(pub.players[votes.wolfCandidateSetBy]?.name || '???');
    html += `<div style="font-size:13px;padding:6px 0;border-bottom:1px solid var(--border);color:var(--text-muted);">
      ${setterName} の提案: <strong style="color:var(--wolf)">${candNames}</strong></div>`;
  }

  aliveWolves.forEach(uid => {
    const name = escHtml(pub.players[uid]?.name || '???');
    const isMe = uid === myUid;
    let status = '';
    if (isSoloWolf) {
      const v = votes?.wolfVotes?.[uid];
      status = v ? `→ <strong style="color:var(--wolf)">${escHtml(pub.players[v]?.name || '???')}</strong>` : '<span style="color:var(--text-dim)">（選択中…）</span>';
    } else if (uid === votes?.wolfCandidateSetBy) {
      status = '<span style="color:var(--text-muted)">候補提案済</span>';
    } else if (votes?.wolfVotes?.[uid]) {
      status = `→ <strong style="color:var(--wolf)">${escHtml(pub.players[votes.wolfVotes[uid]]?.name || '???')}</strong>`;
    } else if (hasCandidates) {
      status = '<span style="color:var(--text-dim)">（選択中…）</span>';
    } else {
      status = '<span style="color:var(--text-dim)">（待機中）</span>';
    }
    html += `<div style="font-size:14px; padding:6px 0; display:flex; justify-content:space-between; align-items:center;">
      <span>${name}${isMe ? ' <span style="color:var(--accent);font-size:11px;">(自分)</span>' : ''}</span>
      <span>${status}</span></div>`;
  });

  html += '</div>';
  area.innerHTML = html;
}

// ==========================================
// BOTTOM SHEET — single & multi-select
// ==========================================
let currentActionType = null;
let currentSelection = null;
let multiSelectMode = false;
let currentMultiSelection = [];

function openActionSheet(actType, themeCls) {
  currentActionType = actType;
  currentSelection = null;
  multiSelectMode = false;
  currentMultiSelection = [];
  if (!gameState) return;

  let targets = Object.values(gameState.public.players).filter(p => p.isAlive && p.uid !== myUid && !p.isGM);

  if (actType === 'runoff_submit') {
    const tied = gameState.votes?.tiedPlayers || [];
    targets = Object.values(gameState.public.players).filter(p => tied.includes(p.uid));
  }
  if (actType === 'wolf_vote' || actType === 'wolf_candidates') {
    const wolfMates = gameState.private?.wolfMates || [];
    targets = targets.filter(p => !wolfMates.includes(p.uid));
  }
  if (actType === 'wolf_final') {
    const candidates = gameState.votes?.wolfCandidates || [];
    targets = Object.values(gameState.public.players).filter(p => candidates.includes(p.uid));
  }
  // Knight: keep last guarded in list but mark as blocked
  const knightBlockedUid = (actType === 'knight_vote') ? (gameState.private?.lastGuarded || null) : null;

  // Knight consecutive guard notice → removed (now shown as grayed button)
  let sheetNotice = '';

  // Wolf candidate mode = multi-select
  if (actType === 'wolf_candidates') {
    multiSelectMode = true;
  }

  const titleText = multiSelectMode ? '候補を選択（複数可）' : '対象を選択';
  const submitText = multiSelectMode ? '候補を提案する' : '決定する';

  el('sheet-content').innerHTML = `<h3 class="sheet-title">${titleText}</h3>
    ${sheetNotice}
    <div class="target-grid">${targets.map(p => {
      const blocked = knightBlockedUid && p.uid === knightBlockedUid;
      return `<button class="target-btn ${themeCls} ${blocked ? 'target-btn-blocked' : ''}"
        data-targetuid="${p.uid}"
        ${blocked ? 'disabled title="連続護衛はできません"' : ''}>${escHtml(p.name)}${blocked ? '<br><span style="font-size:10px;opacity:0.6">連続護衛不可</span>' : ''}</button>`;
    }).join('')}</div>
    <button class="btn primary btn-large" id="btn-submit-action" disabled>${submitText}</button>`;

  el('bottom-sheet').classList.add('show');
  el('bottom-sheet-bg').classList.add('show');
}

function selectTarget(uid) {
  if (multiSelectMode) {
    // Toggle selection
    const idx = currentMultiSelection.indexOf(uid);
    if (idx >= 0) {
      currentMultiSelection.splice(idx, 1);
    } else {
      currentMultiSelection.push(uid);
    }
    // Update button visuals
    document.querySelectorAll('.target-btn').forEach(b => {
      b.classList.toggle('selected', currentMultiSelection.includes(b.dataset.targetuid));
    });
    const submit = el('btn-submit-action');
    if (submit) submit.disabled = currentMultiSelection.length === 0;
  } else {
    // Single select
    currentSelection = uid;
    document.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
    const btn = document.querySelector(`.target-btn[data-targetuid="${uid}"]`);
    if (btn) btn.classList.add('selected');
    const submit = el('btn-submit-action');
    if (submit) submit.disabled = false;
  }
}

function submitAction() {
  if (!myRoomId) return;

  // Multi-select: wolf candidate proposal
  if (multiSelectMode && currentActionType === 'wolf_candidates') {
    if (currentMultiSelection.length === 0) return;
    updateRoom(myRoomId, (room) => {
      const v = room.votes[room.public.day];
      if (!v) return;
      v.wolfCandidates = [...currentMultiSelection];
      v.wolfCandidateSetBy = myUid;
      // If only 1 candidate, auto-record vote for ALL alive wolves (no choice needed)
      if (currentMultiSelection.length === 1) {
        if (!v.wolfVotes) v.wolfVotes = {};
        const target = currentMultiSelection[0];
        const alive = Object.values(room.public.players).filter(p => p.isAlive);
        alive.forEach(p => {
          if (room.private[p.uid]?.role === '人狼') {
            v.wolfVotes[p.uid] = target;
          }
        });
      }
      checkAutoNightResolve(room, room.public.day);
    });
    closeSheet();
    toast('候補を提案しました');
    return;
  }

  // GM proxy vote
  if (currentActionType === 'gm_proxy_vote' || currentActionType === 'gm_proxy_runoff') {
    if (!currentSelection) return;
    const voterUid = el('bottom-sheet').dataset.proxyVoter;
    const isRunoff = currentActionType === 'gm_proxy_runoff';
    updateRoom(myRoomId, (room) => {
      const day = room.public.day;
      const v = room.votes[day];
      if (!v) return;
      if (!isRunoff) {
        if (!v.voteOrder) v.voteOrder = [];
        // Remove existing vote from this voter if any
        v.voteOrder = v.voteOrder.filter(o => o.uid !== voterUid);
        v.voteOrder.push({ uid: voterUid, targetId: currentSelection });
        room.public.players[voterUid].voteStatus = 'voted';
        checkAutoTally(room, day);
      } else {
        if (!v.runoffOrder) v.runoffOrder = [];
        v.runoffOrder = v.runoffOrder.filter(o => o.uid !== voterUid);
        v.runoffOrder.push({ uid: voterUid, targetId: currentSelection });
        room.public.players[voterUid].voteStatus = 'voted';
        checkAutoRunoff(room, day);
      }
    });
    closeSheet();
    toast('代理投票を記録しました');
    return;
  }

  // Single select actions
  if (!currentSelection) return;

  updateRoom(myRoomId, (room) => {
    const day = room.public.day;
    const v = room.votes[day];
    if (!v) return;

    if (currentActionType === 'vote_submit') {
      if (!v.voteOrder) v.voteOrder = [];
      if (v.voteOrder.some(o => o.uid === myUid)) return; // 二重投票防止
      v.voteOrder.push({ uid: myUid, targetId: currentSelection });
      room.public.players[myUid].voteStatus = 'voted';
      checkAutoTally(room, day);
    } else if (currentActionType === 'runoff_submit') {
      if (!v.runoffOrder) v.runoffOrder = [];
      if (v.runoffOrder.some(o => o.uid === myUid)) return; // 二重投票防止
      v.runoffOrder.push({ uid: myUid, targetId: currentSelection });
      room.public.players[myUid].voteStatus = 'voted';
      checkAutoRunoff(room, day);
    } else if (currentActionType === 'wolf_vote') {
      // Solo wolf — direct vote
      if (!v.wolfVotes) v.wolfVotes = {};
      v.wolfVotes[myUid] = currentSelection;
      checkAutoNightResolve(room, day);
    } else if (currentActionType === 'wolf_final') {
      // Multi-wolf — choose from candidates
      if (!v.wolfVotes) v.wolfVotes = {};
      v.wolfVotes[myUid] = currentSelection;
      // Auto-fill setter's vote once all other wolves have voted
      const setterUid = v.wolfCandidateSetBy;
      if (setterUid && !v.wolfVotes[setterUid]) {
        const alive = Object.values(room.public.players).filter(p => p.isAlive);
        const aliveWolves = alive.filter(p => room.private[p.uid]?.role === '人狼');
        const nonSetterWolves = aliveWolves.filter(p => p.uid !== setterUid);
        const allNonSetterVoted = nonSetterWolves.every(p => v.wolfVotes[p.uid]);
        if (allNonSetterVoted) {
          // 提案者の票 = 他の人狼の多数決。同票の場合はランダムで決定
          const counts = {};
          nonSetterWolves.forEach(p => {
            const t = v.wolfVotes[p.uid];
            counts[t] = (counts[t] || 0) + 1;
          });
          const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
          const maxCount = sorted[0][1];
          const topTargets = sorted.filter(([, c]) => c === maxCount).map(([tid]) => tid);
          v.wolfVotes[setterUid] = topTargets[Math.floor(Math.random() * topTargets.length)];
        }
      }
      checkAutoNightResolve(room, day);
    } else if (currentActionType === 'seer_vote') {
      if (!v.seerVotes) v.seerVotes = {};
      v.seerVotes[myUid] = currentSelection;
      checkAutoNightResolve(room, day);
    } else if (currentActionType === 'knight_vote') {
      if (!v.knightVotes) v.knightVotes = {};
      // Server-side consecutive guard block
      const lastGuarded = room.private[myUid]?.lastGuarded;
      if (lastGuarded && currentSelection === lastGuarded) {
        return; // Reject — consecutive guard not allowed
      }
      v.knightVotes[myUid] = currentSelection;
      room.private[myUid].lastGuarded = currentSelection;
      checkAutoNightResolve(room, day);
    }
  });
  closeSheet();
  toast('行動を記録しました');
}

function forceExecute() {
  updateRoom(myRoomId, (room) => {
    const isAuthorized = room.public.players[myUid]?.isGM ||
      room.votes[room.public.day]?.pendingExec === myUid ||
      room.public.players[myUid]?.isHost;
    if (!isAuthorized) return;
    const day = room.public.day;
    const execId = room.votes[day]?.pendingExec;
    if (!execId || !room.public.players[execId]) return;

    room.public.players[execId].isAlive = false;
    ensureDayEntry(room, day);
    room.public.days[day - 1].exec = execId;

    const medUid = Object.keys(room.private).find(id => room.private[id].role === '霊能者');
    if (medUid && room.public.players[medUid]?.isAlive) {
      room.private[medUid].actionLog.push({
        _id: `log_${Date.now()}_${Math.random().toString(36).substr(2,5)}`,
        day, type: '霊能', targetName: room.public.players[execId].name,
        result: room.private[execId]?.role === '人狼' ? '黒' : '白'
      });
    }
    room.public.phase = 'night';
    checkEndGame(room);
  });
}

// ==========================================
// VOTE TALLY & NIGHT RESOLVE
// ==========================================
function ensureDayEntry(room, day) {
  while (room.public.days.length < day) {
    room.public.days.push({ exec: null, attack: null, attackBlocked: false });
  }
}

function checkEndGame(room) {
  const alive = Object.values(room.public.players).filter(p => p.isAlive && !p.isGM);
  const wolves = alive.filter(p => room.private[p.uid]?.role === '人狼');
  const others = alive.filter(p => room.private[p.uid]?.role !== '人狼');
  if (wolves.length === 0) {
    room.public.winner = 'village'; room.public.status = 'finished';
    room.public.winReason = '人狼が全員排除されました'; return true;
  } else if (wolves.length >= others.length) {
    room.public.winner = 'wolf'; room.public.status = 'finished';
    room.public.winReason = '人狼の数が村人陣営を上回りました'; return true;
  }
  return false;
}

function endVoting() { updateRoom(myRoomId, (room) => tallyVotes(room, room.public.day)); }
function endRunoff() { updateRoom(myRoomId, (room) => tallyRunoff(room, room.public.day)); }

// GM専用：投票フェーズ中に最多得票者を即時処刑（遺言スキップ）
function gmExecuteTopVoter() {
  updateRoom(myRoomId, (room) => {
    if (!room.public.players[myUid]?.isGM) return;
    const day = room.public.day;
    const v = room.votes[day];
    if (!v?.voteOrder?.length) { toast('まだ誰も投票していません'); return; }

    const counts = {};
    v.voteOrder.forEach(o => counts[o.targetId] = (counts[o.targetId] || 0) + 1);
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const max = sorted[0][1];
    const tied = sorted.filter(s => s[1] === max).map(s => s[0]);

    // スナップショット保存（棋譜用）
    ensureDayEntry(room, day);
    room.public.days[day - 1].voteSnapshot = v.voteOrder.map(o => ({ uid: o.uid, targetId: o.targetId }));
    room.public.days[day - 1].voteTally = { ...counts };

    if (tied.length > 1) {
      // 同数 → 弁明フェーズへ
      room.public.phase = 'speech';
      v.tiedPlayers = tied;
      v.speechFinished = [];
      return;
    }

    // 単独トップ → 即時処刑（遺言スキップ）
    const execId = tied[0];
    if (!room.public.players[execId]) return;
    room.public.players[execId].isAlive = false;
    room.public.days[day - 1].exec = execId;

    const medUid = Object.keys(room.private).find(id => room.private[id].role === '霊能者');
    if (medUid && room.public.players[medUid]?.isAlive) {
      room.private[medUid].actionLog.push({
        _id: `log_${Date.now()}_${Math.random().toString(36).substr(2,5)}`,
        day, type: '霊能', targetName: room.public.players[execId].name,
        result: room.private[execId]?.role === '人狼' ? '黒' : '白'
      });
    }
    if (!checkEndGame(room)) room.public.phase = 'night';
  });
}

function finishSpeech() {
  updateRoom(myRoomId, (room) => {
    const v = room.votes[room.public.day];
    if (!v || room.public.phase !== 'speech') return;
    if (!v.speechFinished) v.speechFinished = [];
    if (!v.speechFinished.includes(myUid)) v.speechFinished.push(myUid);
    // 同数票プレイヤー全員が押したら決戦投票へ
    const tied = v.tiedPlayers || [];
    const aliveTied = tied.filter(uid => room.public.players[uid]?.isAlive);
    if (aliveTied.length > 0 && aliveTied.every(uid => v.speechFinished.includes(uid))) {
      room.public.phase = 'runoff';
      Object.values(room.public.players).forEach(p => { if (p.isAlive && !p.isGM) p.voteStatus = 'pending'; });
    }
  });
}

function tallyVotes(room, day) {
  const v = room.votes[day];
  if (!v?.voteOrder?.length) { room.public.phase = 'night'; return; }
  const counts = {};
  v.voteOrder.forEach(o => counts[o.targetId] = (counts[o.targetId] || 0) + 1);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = sorted[0][1];
  const tied = sorted.filter(s => s[1] === max).map(s => s[0]);
  // Save snapshot for kifu
  ensureDayEntry(room, day);
  room.public.days[day - 1].voteSnapshot = v.voteOrder.map(o => ({ uid: o.uid, targetId: o.targetId }));
  room.public.days[day - 1].voteTally = { ...counts };
  if (tied.length === 1) { v.pendingExec = tied[0]; room.public.phase = 'will'; }
  else { room.public.phase = 'speech'; v.tiedPlayers = tied; v.speechFinished = []; }
}

function tallyRunoff(room, day) {
  const v = room.votes[day];
  if (!v?.runoffOrder?.length) { room.public.phase = 'night'; return; }
  const counts = {};
  v.runoffOrder.forEach(o => counts[o.targetId] = (counts[o.targetId] || 0) + 1);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = sorted[0][1];
  const tied = sorted.filter(s => s[1] === max).map(s => s[0]);
  // Save snapshot for kifu
  ensureDayEntry(room, day);
  room.public.days[day - 1].runoffSnapshot = v.runoffOrder.map(o => ({ uid: o.uid, targetId: o.targetId }));
  room.public.days[day - 1].runoffTally = { ...counts };
  if (tied.length === 1) { v.pendingExec = tied[0]; room.public.phase = 'will'; }
  else { room.public.phase = 'night'; }
}

function checkAutoTally(room, day) {
  const aliveCount = Object.values(room.public.players).filter(p => p.isAlive && !p.isGM).length;
  // ユニークUIDでカウントして二重投票があっても誤発火しないようにする
  const votedCount = new Set((room.votes[day]?.voteOrder || []).map(o => o.uid)).size;
  if (votedCount >= aliveCount) tallyVotes(room, day);
}

function checkAutoRunoff(room, day) {
  const aliveCount = Object.values(room.public.players).filter(p => p.isAlive && !p.isGM).length;
  // ユニークUIDでカウントして二重投票があっても誤発火しないようにする
  const votedCount = new Set((room.votes[day]?.runoffOrder || []).map(o => o.uid)).size;
  if (votedCount >= aliveCount) tallyRunoff(room, day);
}

function checkAutoNightResolve(room, day) {
  const alive = Object.values(room.public.players).filter(p => p.isAlive && !p.isGM);
  const wolves = alive.filter(p => room.private[p.uid]?.role === '人狼');
  const seer = alive.filter(p => room.private[p.uid]?.role === '占い師');
  const knight = alive.filter(p => room.private[p.uid]?.role === '騎士');
  const v = room.votes[day];
  if (!v) return;

  // Wolf done: ALL alive wolves must have an entry in wolfVotes
  const wolfVoteCount = Object.keys(v.wolfVotes || {}).length;
  const wolfDone = wolfVoteCount >= wolves.length;

  const seerDone = seer.length === 0 || Object.keys(v.seerVotes || {}).length > 0;
  const knightDone = knight.length === 0 || Object.keys(v.knightVotes || {}).length > 0;

  ensureDayEntry(room, day);

  if (wolfDone && seerDone && knightDone && !room.public.days[day - 1].attack) {
    let guardedId = null, attackedId = null;

    if (knight.length > 0 && Object.keys(v.knightVotes || {}).length > 0) {
      const kc = {};
      Object.values(v.knightVotes).forEach(id => kc[id] = (kc[id] || 0) + 1);
      guardedId = Object.entries(kc).sort((a, b) => b[1] - a[1])[0][0];
    }

    // Wolf attack resolution
    if (wolves.length <= 1) {
      // Solo: direct from wolfVotes
      if (Object.keys(v.wolfVotes || {}).length > 0) {
        const wc = {};
        Object.values(v.wolfVotes).forEach(id => wc[id] = (wc[id] || 0) + 1);
        attackedId = Object.entries(wc).sort((a, b) => b[1] - a[1])[0][0];
      }
    } else {
      // Multi: resolve from candidates + votes
      if ((v.wolfCandidates || []).length === 1) {
        attackedId = v.wolfCandidates[0];
      } else if (Object.keys(v.wolfVotes || {}).length > 0) {
        const wc = {};
        Object.values(v.wolfVotes).forEach(id => wc[id] = (wc[id] || 0) + 1);
        attackedId = Object.entries(wc).sort((a, b) => b[1] - a[1])[0][0];
      }
    }

    const attackBlocked = guardedId !== null && guardedId === attackedId;
    if (attackedId && !attackBlocked) {
      room.public.players[attackedId].isAlive = false;
      room.public.days[day - 1].attack = attackedId;
    } else if (attackBlocked) {
      room.public.days[day - 1].attackBlocked = true;
      room.public.days[day - 1].attack = attackedId;
    }

    if (seer.length > 0 && Object.keys(v.seerVotes || {}).length > 0) {
      const sc = {};
      Object.values(v.seerVotes).forEach(id => sc[id] = (sc[id] || 0) + 1);
      const targetId = Object.entries(sc).sort((a, b) => b[1] - a[1])[0][0];
      if (room.private[targetId]) {
        const isWolf = room.private[targetId].role === '人狼' ? '黒' : '白';
        // Save for kifu
        room.public.days[day - 1].seerResult = { targetId, result: isWolf };
        seer.forEach(s => room.private[s.uid].actionLog.push({
          _id: `log_${Date.now()}_${Math.random().toString(36).substr(2,5)}`,
          day: day, type: '占い', targetName: room.public.players[targetId]?.name || '不明', result: isWolf
        }));
      }
    }

    // Save guarded for kifu
    if (guardedId) room.public.days[day - 1].guardedId = guardedId;

    if (!checkEndGame(room)) {
      room.public.day = day + 1;
      room.votes[room.public.day] = { voteOrder: [], runoffOrder: [], wolfVotes: {}, wolfCandidates: [], wolfCandidateSetBy: null, seerVotes: {}, knightVotes: {}, speechFinished: [] };
      room.public.phase = 'discuss';
      ensureDayEntry(room, room.public.day);
      Object.keys(room.public.players).forEach(pid => {
        if (room.public.players[pid].isAlive) room.public.players[pid].voteStatus = 'pending';
      });
    }
  }
}

// ==========================================
// BOTTOM SHEET & VFX
// ==========================================
function closeSheet() {
  el('bottom-sheet').classList.remove('show');
  el('bottom-sheet-bg').classList.remove('show');
}
el('bottom-sheet-bg').addEventListener('click', closeSheet);

function applyPhaseVFX(phase) {
  const overlay = el('vfx-overlay');
  if (!overlay) return;
  overlay.className = '';
  if (phase === 'discuss') {
    overlay.classList.add('vfx-daybreak');
    setTimeout(() => { if (overlay.classList.contains('vfx-daybreak')) overlay.classList.remove('vfx-daybreak'); }, 3000);
  } else if (phase === 'will') {
    // Spotlight only for the execution target
    const pendingExec = gameState?.votes?.pendingExec;
    if (pendingExec && myUid === pendingExec) {
      const rcw = document.querySelector('.role-card-wrapper');
      if (rcw) rcw.classList.add('focus-spotlight');
    }
  }
  if (phase !== 'will') {
    const rcw = document.querySelector('.role-card-wrapper');
    if (rcw) rcw.classList.remove('focus-spotlight');
  }
}

// ==========================================
// EVENT DELEGATION
// ==========================================
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  switch (action) {
    case 'setPhase': setPhase(btn.dataset.phase); break;
    case 'openVoteSheet': openActionSheet('vote_submit', ''); break;
    case 'openRunoffSheet': openActionSheet('runoff_submit', ''); break;
    case 'openNightSheet': openActionSheet(btn.dataset.acttype, btn.dataset.theme); break;
    case 'openWolfCandidateSheet': openActionSheet('wolf_candidates', 'theme-wolf'); break;
    case 'openWolfFinalSheet': openActionSheet('wolf_final', 'theme-wolf'); break;
    case 'endVoting': endVoting(); break;
    case 'endRunoff': endRunoff(); break;
    case 'finishSpeech': finishSpeech(); break;
    case 'gmExecuteTopVoter': gmExecuteTopVoter(); break;
    case 'forceExecute': forceExecute(); break;
  }
});

el('sheet-content').addEventListener('click', (e) => {
  const tgt = e.target.closest('.target-btn');
  if (tgt?.dataset.targetuid) selectTarget(tgt.dataset.targetuid);
  if (e.target.id === 'btn-submit-action') submitAction();
});

el('host-panel').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn[data-phase]');
  if (btn) setPhase(btn.dataset.phase);
});

// GM phase buttons
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-gm-phase]');
  if (btn) setPhase(btn.dataset.gmPhase);
});

// GM proxy vote — click unvoted cell in GM console
document.addEventListener('click', (e) => {
  const cell = e.target.closest('[data-gm-proxy-voter]');
  if (!cell) return;
  const voterUid = cell.dataset.gmProxyVoter;
  const voteType = cell.dataset.gmProxyType;
  openGMProxyVoteSheet(voterUid, voteType);
});

function openGMProxyVoteSheet(voterUid, voteType) {
  if (!gameState) return;
  const pub = gameState.public;
  const voterName = pub.players[voterUid]?.name || '?';
  let targets = Object.values(pub.players).filter(p => p.isAlive && !p.isGM && p.uid !== voterUid);
  if (voteType === 'runoff') {
    const tied = gameState.votes?.tiedPlayers || [];
    targets = targets.filter(p => tied.includes(p.uid));
  }
  // Reuse bottom sheet
  currentActionType = `gm_proxy_${voteType}`;
  currentSelection = null;
  el('sheet-content').innerHTML = `
    <h3 class="sheet-title">代理投票: ${escHtml(voterName)}</h3>
    <div class="target-grid">${targets.map(p =>
      `<button class="target-btn theme-wolf" data-targetuid="${p.uid}">${escHtml(p.name)}</button>`
    ).join('')}</div>
    <button class="btn primary btn-large" id="btn-submit-action" disabled>投票する</button>`;
  el('bottom-sheet').classList.add('show');
  el('bottom-sheet-bg').classList.add('show');
  // Store voter for submitAction
  el('bottom-sheet').dataset.proxyVoter = voterUid;
  el('bottom-sheet').dataset.proxyType = voteType;
}

el('btn-gm-start').addEventListener('click', () => {
  const db = loadDB();
  const room = db.rooms[myRoomId];
  if (!room) return;
  const nonGMPids = Object.keys(room.public.players).filter(pid => !room.public.players[pid].isGM);
  if (nonGMPids.length < 5) return toast('5人以上必要です（GMを除く）');
  showConfirmDialog(`${nonGMPids.length}人でゲームを開始`, 'GMモードで開始します。役職はGMコンソールで確認できます。', () => startGame());
});

el('btn-gm-kifu').addEventListener('click', () => openKifu());
el('btn-kifu-back').addEventListener('click', () => { if (isGM) switchView('gm'); else switchView('app'); });

// ==========================================
// GM STATE RENDERER
// ==========================================
function renderGMState(pub, votes) {
  switchView('gm');

  const phaseMap = {
    confirm: ['🔍 確認', 'phase-day'], discuss: ['☀ 昼議論', 'phase-day'],
    vote: ['⚖ 投票', 'phase-vote'], speech: ['🗣 弁明', 'phase-day'],
    runoff: ['⚡ 決戦投票', 'phase-vote'], will: ['📜 遺言', 'phase-day'],
    night: ['🌙 夜行動', 'phase-night']
  };
  const [pText, pClass] = phaseMap[pub.phase] || ['--', ''];
  el('gm-phase-badge').className = `phase-badge ${pClass}`;
  el('gm-phase-badge').textContent = pText;
  el('gm-day-label').textContent = `${pub.day}日目`;
  el('gm-room-badge').textContent = pub.id || myRoomId;

  // Highlight active phase button
  document.querySelectorAll('[data-gm-phase]').forEach(b => {
    b.classList.toggle('gm-phase-active', b.dataset.gmPhase === pub.phase);
  });

  // Game start / kifu button visibility
  const db = loadDB();
  const allPriv = db.rooms[myRoomId]?.private || {};
  el('btn-gm-start').style.display = pub.status === 'waiting' ? 'block' : 'none';
  el('btn-gm-kifu').style.display = pub.status === 'finished' ? 'block' : 'none';

  // Announcements
  let annHtml = '';
  const yesterday = pub.days[pub.day - 2];
  const today = pub.days[pub.day - 1];
  if (yesterday) {
    if (yesterday.attackBlocked) annHtml += `<div class="announcement gj">🕊 昨晩は護衛成功！誰も死亡しませんでした。</div>`;
    else if (yesterday.attack && pub.players[yesterday.attack]) {
      annHtml += `<div class="announcement death">🐺 昨晩の襲撃: <strong>${escHtml(pub.players[yesterday.attack].name)}</strong> (${escHtml(allPriv[yesterday.attack]?.role || '?')})</div>`;
    }
  }
  if (today?.exec && pub.players[today.exec]) {
    annHtml += `<div class="announcement exec">⚖ 処刑: <strong>${escHtml(pub.players[today.exec].name)}</strong> (${escHtml(allPriv[today.exec]?.role || '?')})</div>`;
  }
  if (pub.status === 'finished') {
    const cls = pub.winner === 'village' ? 'gj' : 'death';
    annHtml += `<div class="announcement ${cls}">🏁 ゲーム終了: ${escHtml(pub.winner === 'village' ? '村人陣営の勝利' : '人狼陣営の勝利')} — ${escHtml(pub.winReason || '')}</div>`;
  }
  el('gm-announcements').innerHTML = annHtml;

  // Action buttons per phase
  let actionBtns = '';
  if (pub.status !== 'finished') {
    if (pub.phase === 'vote') {
      actionBtns += `<button class="btn alert outline" data-action="endVoting">⚖️ 投票終了（遺言フェーズへ）</button>`;
      if ((votes?.voteOrder?.length || 0) > 0)
        actionBtns += `<button class="btn alert" data-action="gmExecuteTopVoter" style="margin-top:6px;">⚰️ 最多得票者を即時処刑</button>`;
    }
    if (pub.phase === 'runoff') actionBtns += `<button class="btn alert outline" data-action="endRunoff">⚡ 決戦投票を強制終了</button>`;
    if (pub.phase === 'will' && votes?.pendingExec) {
      const execName = pub.players[votes.pendingExec]?.name || '?';
      actionBtns += `<button class="btn alert" data-action="forceExecute">⚰️ ${escHtml(execName)} を処刑する</button>`;
    }
  }
  el('gm-action-buttons').innerHTML = actionBtns;

  // Vote status card
  const showVote = pub.phase === 'vote' || pub.phase === 'runoff' || pub.phase === 'will' || pub.phase === 'speech';
  el('gm-vote-status-card').style.display = showVote ? 'block' : 'none';
  if (showVote) {
    const vOrder = pub.phase === 'runoff' ? (votes?.runoffOrder || []) : (votes?.voteOrder || []);
    const counts = {};
    vOrder.forEach(o => counts[o.targetId] = (counts[o.targetId] || 0) + 1);
    const totalVotes = vOrder.length;
    const aliveNonGM = Object.values(pub.players).filter(p => p.isAlive && !p.isGM);
    const maxVotes = Math.max(1, ...Object.values(counts));
    let tallyHtml = '';
    // Bar chart
    Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([tid, cnt]) => {
      const tName = pub.players[tid]?.name || '?';
      const pct = Math.round((cnt / aliveNonGM.length) * 100);
      tallyHtml += `<div class="gm-tally-row">
        <span class="gm-tally-name">${escHtml(tName)}</span>
        <div class="gm-tally-bar-wrap"><div class="gm-tally-bar" style="width:${pct}%"></div></div>
        <span class="gm-tally-count">${cnt}票</span>
      </div>`;
    });
    // Individual votes - clickable for proxy voting
    tallyHtml += `<div class="gm-vote-grid" style="margin-top:10px;">`;
    const isVotePhase = pub.phase === 'vote' || pub.phase === 'runoff';
    aliveNonGM.forEach(p => {
      const vRec = vOrder.find(o => o.uid === p.uid);
      const tName = vRec ? (pub.players[vRec.targetId]?.name || '?') : '（未投票）';
      const voted = !!vRec;
      const clickAttr = (!voted && isVotePhase)
        ? `data-gm-proxy-voter="${p.uid}" data-gm-proxy-type="${pub.phase === 'runoff' ? 'runoff' : 'vote'}" style="cursor:pointer;"`
        : '';
      tallyHtml += `<div class="gm-vote-cell ${voted ? 'voted' : 'pending'} ${!voted && isVotePhase ? 'gm-proxy-btn' : ''}" ${clickAttr}>
        <span class="gm-vote-from">${escHtml(p.name)}</span>
        <span class="gm-vote-arrow">→</span>
        <span class="gm-vote-to">${escHtml(tName)}</span>
        ${!voted && isVotePhase ? '<span class="gm-proxy-hint">代理投票</span>' : ''}
      </div>`;
    });
    tallyHtml += `</div>`;
    if (votes?.pendingExec) tallyHtml += `<div class="announcement exec" style="margin-top:10px;">処刑予定: <strong>${escHtml(pub.players[votes.pendingExec]?.name || '?')}</strong></div>`;
    el('gm-vote-tally').innerHTML = tallyHtml;
  }

  // Night status card
  el('gm-night-status-card').style.display = pub.phase === 'night' ? 'block' : 'none';
  if (pub.phase === 'night') {
    const aliveArr = Object.values(pub.players).filter(p => p.isAlive && !p.isGM);
    const wolves = aliveArr.filter(p => allPriv[p.uid]?.role === '人狼');
    const seerArr = aliveArr.filter(p => allPriv[p.uid]?.role === '占い師');
    const knightArr = aliveArr.filter(p => allPriv[p.uid]?.role === '騎士');
    const wolfDone = wolves.every(w => votes?.wolfVotes?.[w.uid]);
    const seerDone = seerArr.length === 0 || seerArr.some(s => votes?.seerVotes?.[s.uid]);
    const knightDone = knightArr.length === 0 || knightArr.some(k => votes?.knightVotes?.[k.uid]);
    const nightItems = [
      { label: '🐺 人狼の襲撃', done: wolfDone },
      { label: '🔮 占い師の占い', done: seerDone || seerArr.length === 0, na: seerArr.length === 0 },
      { label: '🛡 騎士の護衛', done: knightDone || knightArr.length === 0, na: knightArr.length === 0 },
    ];
    el('gm-night-status').innerHTML = nightItems.map(item =>
      `<div class="gm-night-row ${item.na ? 'na' : (item.done ? 'done' : 'pending')}">
        <span>${item.label}</span>
        <span>${item.na ? '（不在）' : (item.done ? '✅ 完了' : '⏳ 待機中')}</span>
      </div>`
    ).join('');
  }

  // Players list with roles
  const aliveCount = Object.values(pub.players).filter(p => p.isAlive && !p.isGM).length;
  el('gm-alive-count').textContent = `生存 ${aliveCount}人`;
  el('gm-players-list').innerHTML = Object.values(pub.players).filter(p => !p.isGM).map(p => {
    const role = allPriv[p.uid]?.role || '未割当';
    const rInfo = ROLES_INFO[role] || { icon: '?', team: 'village' };
    const teamColor = rInfo.team === 'wolf' ? 'var(--wolf)' : rInfo.team === 'village' ? 'var(--village)' : 'var(--accent)';
    const vRec = votes?.voteOrder?.find(o => o.uid === p.uid);
    const vTarget = vRec ? (pub.players[vRec.targetId]?.name || '?') : null;
    return `<li class="player-item ${!p.isAlive ? 'is-dead' : ''}">
      <div class="p-status-dot"></div>
      <div class="p-name">${escHtml(p.name)}</div>
      <div class="p-tags">
        <span class="p-tag gm-role-tag" style="background:${teamColor}20;border-color:${teamColor};color:${teamColor}">${rInfo.icon} ${role}</span>
        ${vTarget ? `<span class="p-tag voted">→ ${escHtml(vTarget)}</span>` : ''}
      </div>
    </li>`;
  }).join('');

  // Wolf mate info
  const wolves = Object.values(pub.players).filter(p => !p.isGM && allPriv[p.uid]?.role === '人狼');
  let wolfHtml = '';
  if (wolves.length > 0 && pub.status === 'playing') {
    wolfHtml = `<div class="card" style="border-color:var(--wolf-bg);margin-top:4px;"><h4 style="color:var(--wolf);margin-bottom:8px;">🐺 人狼チーム</h4>`;
    wolfHtml += wolves.map(w => `<div style="font-size:13px;padding:3px 0;">${escHtml(w.name)} ${w.isAlive ? '' : '<span style="color:var(--text-dim)">(死亡)</span>'}</div>`).join('');
    if (votes?.wolfVotes && Object.keys(votes.wolfVotes).length > 0) {
      wolfHtml += `<div style="margin-top:8px;font-size:12px;color:var(--text-muted);">今夜の襲撃先: `;
      const wc = {};
      Object.values(votes.wolfVotes).forEach(id => wc[id] = (wc[id] || 0) + 1);
      const topTarget = Object.entries(wc).sort((a, b) => b[1] - a[1])[0]?.[0];
      wolfHtml += topTarget ? `<strong style="color:var(--wolf)">${escHtml(pub.players[topTarget]?.name || '?')}</strong>` : '未定';
      wolfHtml += '</div>';
    }
    wolfHtml += `</div>`;
  }
  el('gm-wolf-info').innerHTML = wolfHtml;
}

// ==========================================
// KIFU (GAME RECORD) RENDERER
// ==========================================
function openKifu() {
  switchView('kifu');
  const db = loadDB();
  const room = db.rooms[myRoomId];
  if (!room) return;
  renderKifu(room.public, room.private);
}

function renderKifu(pub, allPriv) {
  const players = pub.players;
  const days = pub.days || [];

  // Winner banner
  const winnerCls = pub.winner === 'village' ? 'kifu-winner-village' : 'kifu-winner-wolf';
  const winnerLabel = pub.winner === 'village' ? '🏘️ 村人陣営の勝利' : '🐺 人狼陣営の勝利';
  let html = `<div class="kifu-winner-banner ${winnerCls}">${winnerLabel}<div class="kifu-win-reason">${escHtml(pub.winReason || '')}</div></div>`;

  // Final role grid
  html += `<div class="card" style="margin-bottom:16px;"><h3 class="card-title">👥 最終役職一覧</h3><div class="kifu-role-grid">`;
  Object.values(players).filter(p => !p.isGM).forEach(p => {
    const role = allPriv[p.uid]?.role || '?';
    const rInfo = ROLES_INFO[role] || { icon: '?', team: 'village' };
    const isWinner = (pub.winner === 'village' && rInfo.team !== 'wolf') || (pub.winner === 'wolf' && rInfo.team === 'wolf');
    html += `<div class="kifu-role-chip ${!p.isAlive ? 'dead' : (isWinner ? 'winner' : 'loser')}">
      <div class="kifu-chip-icon">${rInfo.icon}</div>
      <div class="kifu-chip-name">${escHtml(p.name)}</div>
      <div class="kifu-chip-role">${role}</div>
    </div>`;
  });
  html += '</div></div>';

  // Day-by-day timeline
  days.forEach((day, idx) => {
    const dayNum = idx + 1;
    html += `<div class="kifu-day-card"><div class="kifu-day-header">📅 ${dayNum}日目</div>`;

    // Morning announcement (night result of previous day)
    if (idx > 0 || day.attack || day.attackBlocked) {
      if (day.attackBlocked && day.attack) {
        const guardedName = players[day.guardedId]?.name || players[day.attack]?.name || '?';
        html += `<div class="kifu-event gj">🕊 <strong>騎士の護衛成功</strong> — ${escHtml(guardedName)}が守られ、誰も死亡しませんでした。</div>`;
      } else if (day.attack && players[day.attack]) {
        const role = allPriv[day.attack]?.role || '?';
        html += `<div class="kifu-event death">🐺 <strong>夜の襲撃</strong> — ${escHtml(players[day.attack].name)}（${role}）が犠牲になりました。</div>`;
      }
    }

    // Vote tally
    if (day.voteSnapshot?.length > 0) {
      html += `<div class="kifu-section-label">⚖️ 投票結果</div>`;
      const tally = day.voteTally || {};
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const maxV = sorted[0]?.[1] || 1;
      html += '<div class="kifu-tally">';
      sorted.forEach(([tid, cnt]) => {
        const name = players[tid]?.name || '?';
        const pct = Math.round((cnt / day.voteSnapshot.length) * 100);
        html += `<div class="gm-tally-row"><span class="gm-tally-name">${escHtml(name)}</span><div class="gm-tally-bar-wrap"><div class="gm-tally-bar" style="width:${pct}%"></div></div><span class="gm-tally-count">${cnt}票</span></div>`;
      });
      html += '</div>';
      // Individual votes grid
      html += '<div class="kifu-vote-details">';
      day.voteSnapshot.forEach(v => {
        const fromName = players[v.uid]?.name || '?';
        const toName = players[v.targetId]?.name || '?';
        html += `<div class="kifu-vote-row"><span>${escHtml(fromName)}</span><span class="kifu-arrow">→</span><span class="kifu-vote-target">${escHtml(toName)}</span></div>`;
      });
      html += '</div>';
    }

    // Runoff
    if (day.runoffSnapshot?.length > 0) {
      html += `<div class="kifu-section-label">⚡ 決戦投票</div>`;
      const tally = day.runoffTally || {};
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      html += '<div class="kifu-tally">';
      sorted.forEach(([tid, cnt]) => {
        const name = players[tid]?.name || '?';
        const pct = Math.round((cnt / day.runoffSnapshot.length) * 100);
        html += `<div class="gm-tally-row"><span class="gm-tally-name">${escHtml(name)}</span><div class="gm-tally-bar-wrap"><div class="gm-tally-bar" style="width:${pct}%"></div></div><span class="gm-tally-count">${cnt}票</span></div>`;
      });
      html += '</div>';
    }

    // Execution
    if (day.exec && players[day.exec]) {
      const role = allPriv[day.exec]?.role || '?';
      html += `<div class="kifu-event exec">⚰️ <strong>処刑</strong> — ${escHtml(players[day.exec].name)}（${role}）が処刑されました。</div>`;
    } else if (day.voteSnapshot?.length > 0 && !day.exec) {
      html += `<div class="kifu-event" style="color:var(--text-muted)">🤝 同数決着なし — 誰も処刑されませんでした。</div>`;
    }

    // Night actions
    const hasSeer = day.seerResult;
    const hasKnight = day.guardedId;
    if (hasSeer || hasKnight) {
      html += `<div class="kifu-section-label">🌙 夜の行動</div><div class="kifu-night-actions">`;
      if (hasSeer) {
        const targetName = players[day.seerResult.targetId]?.name || '?';
        const resColor = day.seerResult.result === '黒' ? 'var(--wolf)' : '#7ab3f5';
        html += `<div class="kifu-night-row">🔮 占い師 → <strong>${escHtml(targetName)}</strong> = <strong style="color:${resColor}">${day.seerResult.result}</strong></div>`;
      }
      if (hasKnight) {
        const guardName = players[day.guardedId]?.name || '?';
        html += `<div class="kifu-night-row">🛡 騎士が護衛 → <strong>${escHtml(guardName)}</strong></div>`;
      }
      if (day.attack) {
        const attackName = players[day.attack]?.name || '?';
        html += `<div class="kifu-night-row">🐺 人狼が襲撃 → <strong style="color:var(--wolf)">${escHtml(attackName)}</strong>${day.attackBlocked ? ' <span style="color:var(--knight)">(GJ)</span>' : ''}</div>`;
      }
      html += '</div>';
    }

    html += '</div>';
  });

  el('kifu-content').innerHTML = html;
}

// Auto-rejoin for GM is handled in the main tryAutoRejoin block above
