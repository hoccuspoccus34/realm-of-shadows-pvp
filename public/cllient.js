// =====================================================
// REALM OF SHADOWS - Multiplayer PvP Client
// Socket.IO WebSocket Client Logic
// =====================================================

// ---- PLAYER TOKEN (persistent identity) ----
let playerToken = localStorage.getItem('ros_token') || null;

// ---- SOCKET CONNECTION ----
const socket = io();

// ---- MULTIPLAYER STATE ----
let mySocketId = null;
let isConnected = false;
let isRegistered = false;
let inQueue = false;
let inBattle = false;
let currentBattle = null;
let isMyTurn = false;
let onlinePlayers = [];
let chatMessages = [];

// ---- CLASS ICONS ----
const CLASS_ICONS = { Warrior: '⚔️', Mage: '🔮', Rogue: '🗡️' };

// =====================================================
// CONNECTION EVENTS
// =====================================================

socket.on('connect', () => {
  isConnected = true;
  console.log('[WS] Connected to server');
  updateConnectionStatus();
  // Auto-register if we have a game state
  if (typeof gameState !== 'undefined' && gameState && gameState.name) {
    registerFighter();
  }
});

socket.on('disconnect', () => {
  isConnected = false;
  isRegistered = false;
  inQueue = false;
  inBattle = false;
  currentBattle = null;
  console.log('[WS] Disconnected from server');
  updateConnectionStatus();
  if (typeof getActivePanel === 'function' && getActivePanel() === 'arena') {
    renderArena();
  }
});

socket.on('welcome', (data) => {
  mySocketId = data.id;
  console.log('[WS] Welcome:', data.message, '| Online:', data.onlineCount);
});

socket.on('error', (data) => {
  console.error('[WS] Error:', data.message);
  if (typeof showToast === 'function') showToast(data.message, 'error');
});

socket.on('assignToken', (data) => {
  if (data.token) {
    playerToken = data.token;
    localStorage.setItem('ros_token', data.token);
    console.log('[WS] Token assigned:', data.token.slice(0, 8) + '...');
  }
});

socket.on('syncGameState', (data) => {
  if (!data || typeof gameState === 'undefined' || !gameState) return;
  gameState.level = data.level;
  gameState.xp = data.xp;
  gameState.stats = data.stats;
  gameState.statPoints = data.statPoints;
  gameState.gold = data.gold;
  gameState.currentHP = data.currentHP;
  gameState.arena = data.arena;
  if (data.guildName !== undefined) gameState.guild = data.guildName;
  if (typeof saveGame === 'function') saveGame();
  if (typeof updateStatusBar === 'function') updateStatusBar();
  if (typeof renderCharacterPanel === 'function') renderCharacterPanel();
});

socket.on('characterDeleted', (data) => {
  if (typeof showToast === 'function') showToast('🗑️ ' + (data.message || 'Character deleted.'), 'info', 4000);
  playerToken = null;
  localStorage.removeItem('ros_token');
  localStorage.removeItem('ros_save');
  location.reload();
});

// =====================================================
// REGISTRATION
// =====================================================

function registerFighter() {
  if (!isConnected || typeof gameState === 'undefined' || !gameState) return;
  // Send only token+name+class; server loads/creates authoritative data
  socket.emit('registerFighter', { token: playerToken, name: gameState.name, class: gameState.class });
}

// =====================================================
// Auto-registration on stat changes (server handles validation)
// =====================================================
function updateFighterRegistration() {
  if (isConnected && isRegistered && gameState) {
    registerFighter();
  }
}

socket.on('registered', (data) => {
  isRegistered = true;
  console.log('[WS] Registered:', data.message);
  if (typeof showToast === 'function') showToast('🌐 ' + data.message, 'arena');
  updateConnectionStatus();
  if (typeof getActivePanel === 'function' && getActivePanel() === 'arena') {
    renderArena();
  }
});

// =====================================================
// PLAYER LIST
// =====================================================

socket.on('playerList', (list) => {
  onlinePlayers = list;
  updateOnlinePlayersList();
  if (typeof getActivePanel === 'function' && getActivePanel() === 'arena') {
    renderArena();
  }
});

socket.on('onlineCount', (count) => {
  const el = document.getElementById('online-count');
  if (el) el.textContent = count;
});

function updateOnlinePlayersList() {
  const el = document.getElementById('online-players-list');
  if (!el) return;
  
  if (onlinePlayers.length === 0) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px;font-style:italic;">No players online</div>';
    return;
  }
  
  let html = '<div class="online-players-grid">';
  for (let i = 0; i < onlinePlayers.length; i++) {
    const p = onlinePlayers[i];
    const isMe = p.id === mySocketId;
    const icon = CLASS_ICONS[p.class] || '👤';
    const statusIcon = p.inBattle ? '⚔️' : p.inQueue ? '🔍' : '🟢';
    const statusText = p.inBattle ? 'In Battle' : p.inQueue ? 'Searching...' : 'Online';
    
    html += '<div class="online-player-card' + (isMe ? ' online-player-you' : '') + '">';
    html += '<div class="online-player-info">';
    html += '<span class="online-player-icon">' + icon + '</span>';
    html += '<div>';
    html += '<div class="online-player-name">' + (isMe ? '➤ ' : '') + p.name + '</div>';
    html += '<div class="online-player-class">Lv.' + p.level + ' ' + p.class + ' · ' + p.rank.icon + ' ' + p.rating + '</div>';
    html += '</div>';
    html += '</div>';
    html += '<div class="online-player-status">';
    html += '<span class="online-status-dot">' + statusIcon + '</span> ' + statusText;
    html += '</div>';
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

// =====================================================
// PVP QUEUE
// =====================================================

function joinPvpQueue() {
  if (!isConnected) { showToast('Not connected to server!', 'error'); return; }
  if (!isRegistered) {
    registerFighter();
    setTimeout(joinPvpQueue, 500);
    return;
  }
  if (inBattle) { showToast('Already in a battle!', 'error'); return; }
  if (gameState.currentHP <= 0) { showToast('Heal first!', 'error'); return; }
  
  // Re-register to update stats before queueing
  registerFighter();
  socket.emit('joinQueue');
}

function leavePvpQueue() {
  socket.emit('leaveQueue');
}

socket.on('queueJoined', (data) => {
  inQueue = true;
  console.log('[WS] Queue joined:', data.message);
  if (typeof showToast === 'function') showToast('🔍 ' + data.message, 'arena');
  if (typeof getActivePanel === 'function' && getActivePanel() === 'arena') {
    renderArena();
  }
});

socket.on('queueLeft', (data) => {
  inQueue = false;
  console.log('[WS] Queue left:', data.message);
  if (typeof getActivePanel === 'function' && getActivePanel() === 'arena') {
    renderArena();
  }
});

// =====================================================
// BATTLE EVENTS
// =====================================================

socket.on('battleStart', (data) => {
  inQueue = false;
  inBattle = true;
  isMyTurn = (data.currentTurn === mySocketId);
  currentBattle = {
    battleId: data.battleId,
    you: data.you,
    opponent: data.opponent,
    currentTurn: data.currentTurn,
    currentTurnName: data.currentTurnName,
    turns: 0,
    log: []
  };
  console.log('[WS] Battle started! vs', data.opponent.name);
  if (typeof showToast === 'function') showToast('⚔️ PvP Battle! vs ' + data.opponent.name, 'arena', 4000);
  if (typeof playSound === 'function') playSound('arena');
  // Switch to arena panel
  if (typeof showPanel === 'function') showPanel('arena');
  renderArena();
});

socket.on('battleUpdate', (data) => {
  if (!currentBattle) return;
  
  // Update HP values
  if (currentBattle.you.name === data.player1.name) {
    currentBattle.you.currentHP = data.player1.currentHP;
    currentBattle.opponent.currentHP = data.player2.currentHP;
  } else {
    currentBattle.you.currentHP = data.player2.currentHP;
    currentBattle.opponent.currentHP = data.player1.currentHP;
  }
  
  // Add log entry
  if (data.log) {
    currentBattle.log.push(data.log);
  }
  currentBattle.turns = data.turns;
  renderArena();
  
  // Play sound effects
  if (data.log && typeof playSound === 'function') {
    if (data.log.crit) playSound('crit');
    else playSound('hit');
  }
});

socket.on('turnChange', (data) => {
  if (!currentBattle) return;
  currentBattle.currentTurn = data.currentTurn;
  currentBattle.currentTurnName = data.currentTurnName;
  isMyTurn = (data.currentTurn === mySocketId);
  renderArena();
});

socket.on('battleEnd', (data) => {
  inBattle = false;
  const won = data.youWon;
  console.log('[WS] Battle ended!', won ? 'VICTORY' : 'DEFEAT');
  
  // Apply rewards locally
  if (won && typeof gameState !== 'undefined' && gameState) {
    gameState.gold += data.goldReward;
    gameState.arena.rating = data.winnerNewRating;
    gameState.arena.wins++;
    // Add XP
    if (typeof addXP === 'function') {
      addXP(data.xpReward);
    }
    // Record in local arena history
    gameState.arena.history.push({
      won: true,
      oppName: data.loserName + ' (Online PvP)',
      oppLevel: 0,
      oppClass: '',
      ratingChange: data.winnerRatingChange,
      time: Date.now()
    });
  } else if (!won && typeof gameState !== 'undefined' && gameState) {
    gameState.arena.rating = data.loserNewRating;
    gameState.arena.losses++;
    gameState.arena.streak = 0;
    gameState.arena.history.push({
      won: false,
      oppName: data.winnerName + ' (Online PvP)',
      oppLevel: 0,
      oppClass: '',
      ratingChange: data.loserRatingChange,
      time: Date.now()
    });
  }
  
  if (typeof playSound === 'function') playSound(won ? 'arena' : 'death');
  if (typeof showToast === 'function') {
    showToast(won ? '⚔️ VICTORY! +' + data.winnerRatingChange + ' rating, +' + data.goldReward + ' gold, +' + data.xpReward + ' XP!' : '💀 DEFEAT! ' + data.loserRatingChange + ' rating', won ? 'arena' : 'error', 5000);
  }
  
  // Store result for display
  currentBattle = {
    ...currentBattle,
    finished: true,
    result: data
  };
  
  if (typeof updateStatusBar === 'function') updateStatusBar();
  if (typeof renderCharacterPanel === 'function') renderCharacterPanel();
  if (typeof saveGame === 'function') saveGame();
  renderArena();
});

// =====================================================
// BATTLE ACTIONS
// =====================================================

function pvpAttack() {
  if (!inBattle || !isMyTurn) return;
  socket.emit('battleAction', { action: 'attack' });
}

function pvpForfeit() {
  if (!inBattle) return;
  if (!confirm('Are you sure you want to forfeit?')) return;
  socket.emit('battleAction', { action: 'forfeit' });
}

// =====================================================
// CHAT
// =====================================================

function sendChat() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  if (!isConnected) { showToast('Not connected!', 'error'); return; }
  if (!isRegistered) { showToast('Register first!', 'error'); return; }
  socket.emit('chatMessage', { message: msg });
  input.value = '';
}

socket.on('chatMessage', (data) => {
  chatMessages.push(data);
  if (chatMessages.length > 100) chatMessages = chatMessages.slice(-100);
  updateChatDisplay();
});

function updateChatDisplay() {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  let html = '';
  const start = Math.max(0, chatMessages.length - 30);
  for (let i = start; i < chatMessages.length; i++) {
    const m = chatMessages[i];
    const icon = CLASS_ICONS[m.class] || '👤';
    const isMe = typeof gameState !== 'undefined' && gameState && m.name === gameState.name;
    html += '<div class="chat-msg' + (isMe ? ' chat-msg-me' : '') + '">';
    html += '<span class="chat-name" style="color:' + (isMe ? 'var(--gold)' : 'var(--arena-purple)') + '">' + icon + ' ' + m.name + ':</span> ';
    html += '<span class="chat-text">' + escapeHtml(m.message) + '</span>';
    html += '</div>';
  }
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =====================================================
// UI HELPERS
// =====================================================

function updateConnectionStatus() {
  const el = document.getElementById('connection-status');
  if (!el) return;
  if (isConnected) {
    el.innerHTML = '<span style="color:var(--heal-green);">🟢 Connected</span>';
  } else {
    el.innerHTML = '<span style="color:var(--hp-red);">🔴 Disconnected</span>';
  }
}

// =====================================================
// RENDER ONLINE PVP ARENA
// =====================================================

function renderOnlinePvp() {
  let html = '';
  
  // Connection status bar
  html += '<div class="mp-status-bar">';
  html += '<div id="connection-status">' + (isConnected ? '<span style="color:var(--heal-green);">🟢 Connected</span>' : '<span style="color:var(--hp-red);">🔴 Disconnected</span>') + '</div>';
  html += '<div>🌐 Online: <b id="online-count">' + onlinePlayers.length + '</b></div>';
  if (isConnected && !isRegistered && typeof gameState !== 'undefined' && gameState) {
    html += '<button class="btn-pvp btn-pvp-export" onclick="registerFighter()">📡 Register Fighter</button>';
  } else if (isRegistered) {
    html += '<div style="color:var(--heal-green);font-size:0.7rem;">✅ Fighter Registered</div>';
  }
  html += '</div>';
  
  // === ACTIVE BATTLE ===
  if (inBattle && currentBattle && !currentBattle.finished) {
    html += renderActiveBattle();
  }
  // === BATTLE RESULT ===
  else if (currentBattle && currentBattle.finished && currentBattle.result) {
    html += renderBattleResult();
  }
  // === QUEUE / LOBBY ===
  else {
    html += renderLobby();
  }
  
  // === CHAT ===
  html += renderChat();
  
  // === ONLINE PLAYERS ===
  html += '<div class="panel-title" style="margin-top:14px;"><span class="icon">👥</span> Online Players</div>';
  html += '<div id="online-players-list">';
  html += '<div style="text-align:center;color:var(--text-dim);padding:20px;">Loading...</div>';
  html += '</div>';
  
  return html;
}

function renderActiveBattle() {
  const b = currentBattle;
  const you = b.you;
  const opp = b.opponent;
  const youIcon = CLASS_ICONS[you.class] || '👤';
  const oppIcon = CLASS_ICONS[opp.class] || '👤';
  const youHpPct = Math.max(0, (you.currentHP / you.maxHP) * 100);
  const oppHpPct = Math.max(0, (opp.currentHP / opp.maxHP) * 100);
  
  let html = '<div class="mp-battle-arena animate-fade">';
  // Turn indicator
  html += '<div class="mp-turn-indicator">';
  if (isMyTurn) {
    html += '<span style="color:var(--gold-bright);font-weight:700;">⚔️ YOUR TURN — Attack!</span>';
  } else {
    html += '<span style="color:var(--text-dim);">⏳ ' + b.currentTurnName + '\'s turn...</span>';
  }
  html += '</div>';
  
  // Fighters
  html += '<div class="combat-arena">';
  html += '<div class="combatant" id="mp-you">';
  html += '<div class="avatar">' + youIcon + '</div>';
  html += '<div class="name" style="color:var(--heal-green);">' + you.name + '</div>';
  html += '<div class="level-badge">Lv.' + you.level + ' ' + you.class + ' (You)</div>';
  html += '<div class="combat-hp-bar"><div class="bar-container"><div class="bar-fill hp" style="width:' + youHpPct + '%;' + (youHpPct < 25 ? 'animation:pulse .5s infinite;' : '') + '"></div><div class="bar-text">' + you.currentHP + '/' + you.maxHP + '</div></div></div>';
  html += '</div>';
  html += '<div class="combat-vs">⚔️</div>';
  html += '<div class="combatant" id="mp-opp">';
  html += '<div class="avatar">' + oppIcon + '</div>';
  html += '<div class="name" style="color:var(--hp-red);">' + opp.name + '</div>';
  html += '<div class="level-badge">Lv.' + opp.level + ' ' + opp.class + '</div>';
  html += '<div class="combat-hp-bar"><div class="bar-container"><div class="bar-fill hp" style="width:' + oppHpPct + '%;' + (oppHpPct < 25 ? 'animation:pulse .5s infinite;background:linear-gradient(90deg,#e74c3c,#ff6b6b);' : '') + '"></div><div class="bar-text">' + opp.currentHP + '/' + opp.maxHP + '</div></div></div>';
  html += '</div>';
  html += '</div>';
  
  // Action buttons
  html += '<div class="combat-controls">';
  html += '<button class="btn-combat btn-fight" onclick="pvpAttack()"' + (!isMyTurn ? ' disabled' : '') + '>⚔️ Attack' + (!isMyTurn ? ' (Wait...)' : '') + '</button>';
  html += '<button class="btn-combat btn-flee" onclick="pvpForfeit()" style="flex:0.5;">🏳️ Forfeit</button>';
  html += '</div>';
  
  // Combat log
  html += '<div class="combat-log" id="mp-combat-log">';
  if (b.log.length === 0) {
    html += '<div class="log-entry log-system">⚔️ Battle started! Turn ' + (b.turns + 1) + '</div>';
  }
  for (let i = 0; i < b.log.length; i++) {
    const log = b.log[i];
    if (log.type === 'attack') {
      const cls = log.crit ? 'log-crit' : (log.attacker === b.you.name ? 'log-player' : 'log-enemy');
      html += '<div class="log-entry ' + cls + '">';
      html += (log.crit ? '⚡ CRIT! ' : '') + log.attacker + ' hits ' + log.defender + ' for ' + log.damage + ' dmg (' + log.blocked + ' blocked)';
      html += ' — ' + log.defender + ': ' + log.defenderHP + '/' + log.defenderMaxHP + ' HP';
      html += '</div>';
    } else if (log.type === 'forfeit' || log.type === 'disconnect' || log.type === 'timeout') {
      html += '<div class="log-entry log-system">' + (log.message || log.type) + '</div>';
    }
  }
  html += '</div>';
  html += '</div>';
  return html;
}

function renderBattleResult() {
  const r = currentBattle.result;
  const won = r.youWon;
  let html = '<div class="arena-battle-result ' + (won ? 'win' : 'lose') + ' animate-bounce">';
  html += '<div class="arena-result-title ' + (won ? 'win' : 'lose') + '">' + (won ? '⚔️ VICTORY!' : '💀 DEFEAT') + '</div>';
  html += '<div class="arena-result-details">';
  html += '<p>' + r.winnerName + ' defeated ' + r.loserName + '</p>';
  html += '<p>Battle lasted <b>' + r.turns + '</b> turns (' + r.reason + ')</p>';
  if (won) {
    html += '<p style="color:var(--heal-green);">Rating: +' + r.winnerRatingChange + ' → ' + r.winnerNewRating + '</p>';
    html += '<p style="color:var(--gold);">🪙 +' + r.goldReward + ' Gold</p>';
    html += '<p style="color:var(--xp-blue);">⭐ +' + r.xpReward + ' XP</p>';
  } else {
    html += '<p style="color:var(--hp-red);">Rating: ' + r.loserRatingChange + ' → ' + r.loserNewRating + '</p>';
  }
  html += '</div>';
  
  // Show battle log
  html += '<div class="combat-log" style="max-height:150px;margin-top:12px;">';
  for (let i = 0; i < r.log.length; i++) {
    const log = r.log[i];
    if (log.type === 'attack') {
      html += '<div class="log-entry ' + (log.crit ? 'log-crit' : 'log-system') + '">' + (log.crit ? '⚡ ' : '') + log.attacker + ' → ' + log.defender + ': ' + log.damage + ' dmg</div>';
    } else {
      html += '<div class="log-entry log-system">' + (log.message || '') + '</div>';
    }
  }
  html += '</div>';
  
  html += '<button class="btn-arena-fight" onclick="currentBattle=null;renderArena();" style="margin-top:14px;">🔙 Back to Arena</button>';
  html += '</div>';
  return html;
}

function renderLobby() {
  let html = '';
  
  // Queue controls
  html += '<div class="mp-queue-box">';
  if (inQueue) {
    html += '<div class="mp-queue-searching">';
    html += '<div class="mp-search-spinner"></div>';
    html += '<div style="font-family:MedievalSharp,cursive;font-size:1.2rem;color:var(--arena-purple);margin-bottom:6px;">Searching for opponent...</div>';
    html += '<div style="font-size:0.75rem;color:var(--text-dim);">You will be matched when another player joins the queue.</div>';
    html += '<button class="btn-pvp btn-pvp-fight" onclick="leavePvpQueue()" style="margin-top:14px;">✖ Cancel Search</button>';
    html += '</div>';
  } else {
    html += '<div style="text-align:center;">';
    html += '<div style="font-size:2.5rem;margin-bottom:8px;">⚔️</div>';
    html += '<div style="font-family:MedievalSharp,cursive;font-size:1.2rem;color:var(--gold);margin-bottom:8px;">Real-Time PvP Arena</div>';
    html += '<div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:16px;line-height:1.5;">Fight real players in turn-based combat!<br>Your actual stats, equipment, and skills are used.</div>';
    
    let buttonDisabled = !isConnected || !isRegistered || gameState.currentHP <= 0;
    let buttonText = '🔍 Find Opponent';
    if (!isConnected) buttonText = '🔴 Connect First';
    else if (!isRegistered) buttonText = '📡 Register First';
    else if (gameState.currentHP <= 0) buttonText = '💀 Heal First';
    
    html += '<button class="btn-arena-fight" onclick="joinPvpQueue()" style="font-size:1.1rem;padding:16px 32px;"' + (buttonDisabled ? ' disabled' : '') + '>' + buttonText + '</button>';
    
    if (!isConnected) {
      html += '<div style="margin-top:10px;font-size:0.7rem;color:var(--hp-red);">⚠️ Not connected to server. Make sure the server is running!</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderChat() {
  let html = '<div class="mp-chat-box">';
  html += '<div class="panel-title"><span class="icon">💬</span> Global Chat</div>';
  html += '<div class="mp-chat-messages" id="chat-messages">';
  if (chatMessages.length === 0) {
    html += '<div style="text-align:center;color:var(--text-dim);padding:20px;font-size:0.75rem;font-style:italic;">No messages yet. Say hello!</div>';
  } else {
    const start = Math.max(0, chatMessages.length - 30);
    for (let i = start; i < chatMessages.length; i++) {
      const m = chatMessages[i];
      const icon = CLASS_ICONS[m.class] || '👤';
      const isMe = typeof gameState !== 'undefined' && gameState && m.name === gameState.name;
      html += '<div class="chat-msg' + (isMe ? ' chat-msg-me' : '') + '">';
      html += '<span class="chat-name" style="color:' + (isMe ? 'var(--gold)' : 'var(--arena-purple)') + '">' + icon + ' ' + m.name + ':</span> ';
      html += '<span class="chat-text">' + escapeHtml(m.message) + '</span>';
      html += '</div>';
    }
  }
  html += '</div>';
  html += '<div class="mp-chat-input-row">';
  html += '<input type="text" id="chat-input" class="mp-chat-input" placeholder="Type a message..." maxlength="200" onkeydown="if(event.key===\'Enter\')sendChat();" />';
  html += '<button class="btn-pvp btn-pvp-export" onclick="sendChat()">Send</button>';
  html += '</div>';
  html += '</div>';
  return html;
}

// =====================================================
// SERVER-AUTHORITATIVE STAT ALLOCATION
// =====================================================
function allocateStat(stat, amt) {
  amt = amt || 1;
  if (typeof gameState === 'undefined' || !gameState || gameState.statPoints <= 0) return;
  if (isConnected && isRegistered) {
    socket.emit('allocateStat', { stat, amt, currentHP: gameState.currentHP });
    if (typeof playSound === 'function') playSound('equip');
  }
}

// =====================================================
// CHARACTER DELETION
// =====================================================
function deleteCharacter() {
  if (!confirm('\u26a0\ufe0f Delete your character permanently? This cannot be undone!')) return;
  if (!isConnected) {
    if (typeof showToast === 'function') showToast('Not connected to server!', 'error');
    return;
  }
  socket.emit('deleteCharacter', { token: playerToken });
}