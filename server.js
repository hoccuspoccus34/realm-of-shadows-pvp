// =====================================================
// REALM OF SHADOWS - Multiplayer PvP Server
// Node.js + Socket.IO WebSocket Server
// =====================================================
// Run: npm install express socket.io
// Start: node server.js
// Open: http://localhost:3000
// =====================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =====================================================
// GAME STATE
// =====================================================

// All connected players: { socketId: playerData }
const players = {};

// PvP queue: array of socket IDs waiting for a match
let pvpQueue = [];

// Active PvP battles: { battleId: battleData }
const activeBattles = {};

// Battle ID counter
let battleIdCounter = 1;

// Online player list broadcast interval
let broadcastInterval = null;

// =====================================================
// HELPER FUNCTIONS
// =====================================================

function generateBattleId() {
  return 'battle_' + (battleIdCounter++);
}

// Calculate player damage (server-side, authoritative)
function calcDamage(fighter) {
  const s = fighter.stats;
  const cls = fighter.class;
  let dmg;
  if (cls === 'Warrior') dmg = s.str * 2 + s.dex * 0.5;
  else if (cls === 'Mage') dmg = s.int * 2.2 + s.dex * 0.3;
  else dmg = s.dex * 1.8 + s.str * 0.6;
  dmg += fighter.level * 1.5;
  // Random variance 85%-115%
  dmg = Math.max(1, Math.round(dmg * (0.85 + Math.random() * 0.3)));
  return dmg;
}

// Check critical hit
function isCrit(fighter) {
  const critChance = Math.min(60, (fighter.stats.lck || 0) * 2);
  return Math.random() * 100 < critChance;
}

// Calculate defense reduction
function calcDefense(fighter) {
  const s = fighter.stats;
  const cls = fighter.class;
  const lv = fighter.level;
  let def, maxDef;
  if (cls === 'Warrior') {
    def = (s.str * 0.8 + s.dex * 0.2 + lv * 1.5) * 0.65;
    maxDef = 60;
  } else if (cls === 'Mage') {
    def = (s.int * 0.3 + s.dex * 0.2 + lv * 1.0) * 0.5;
    maxDef = 30;
  } else {
    def = (s.dex * 0.6 + s.str * 0.2 + lv * 1.2) * 0.55;
    maxDef = 40;
  }
  return Math.min(maxDef, def);
}

// Simulate one attack turn
function performAttack(attacker, defender) {
  let dmg = calcDamage(attacker);
  const crit = isCrit(attacker);
  if (crit) dmg = Math.round(dmg * 2);
  const def = calcDefense(defender);
  const blocked = Math.round(dmg * (def / 100));
  dmg = Math.max(1, dmg - blocked);
  defender.currentHP = Math.max(0, defender.currentHP - dmg);
  return { damage: dmg, crit, blocked, attackerName: attacker.name, defenderName: defender.name };
}

// Elo rating calculation
function calcElo(winnerRating, loserRating) {
  const K = 40;
  const expectedWin = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const expectedLose = 1 / (1 + Math.pow(10, (winnerRating - loserRating) / 400));
  const winnerChange = Math.round(K * (1 - expectedWin));
  const loserChange = Math.round(K * (0 - expectedLose));
  return { winnerChange, loserChange };
}

// Get rank from rating
function getRank(rating) {
  if (rating >= 2200) return { name: 'Legend', icon: '🔥' };
  if (rating >= 1800) return { name: 'Diamond', icon: '💎' };
  if (rating >= 1500) return { name: 'Gold', icon: '🥇' };
  if (rating >= 1200) return { name: 'Silver', icon: '🥈' };
  return { name: 'Bronze', icon: '🥉' };
}

// Build sanitized player info for broadcast
function getPublicPlayerInfo(p) {
  if (!p || !p.fighter) return null;
  const f = p.fighter;
  return {
    id: p.id,
    name: f.name,
    class: f.class,
    level: f.level,
    rating: f.arena ? f.arena.rating : 1000,
    rank: getRank(f.arena ? f.arena.rating : 1000),
    wins: f.arena ? f.arena.wins : 0,
    losses: f.arena ? f.arena.losses : 0,
    inBattle: p.battleId !== null,
    inQueue: pvpQueue.includes(p.id)
  };
}

// Broadcast online players list to everyone
function broadcastPlayerList() {
  const list = [];
  for (const id in players) {
    const info = getPublicPlayerInfo(players[id]);
    if (info) list.push(info);
  }
  list.sort((a, b) => b.rating - a.rating);
  io.emit('playerList', list);
}

// =====================================================
// SOCKET.IO CONNECTION HANDLING
// =====================================================

io.on('connection', (socket) => {
  console.log(`[CONNECT] Player connected: ${socket.id}`);

  // Register player in memory
  players[socket.id] = {
    id: socket.id,
    fighter: null,
    battleId: null,
    ready: false
  };

  // Send welcome
  socket.emit('welcome', {
    id: socket.id,
    message: 'Connected to Realm of Shadows PvP Server!',
    onlineCount: Object.keys(players).length
  });

  // Broadcast updated player count
  io.emit('onlineCount', Object.keys(players).length);

  // --------------------------------------------------
  // REGISTER FIGHTER - Client sends character data
  // --------------------------------------------------
  socket.on('registerFighter', (data) => {
    if (!data || !data.name || !data.class || !data.level || !data.stats) {
      socket.emit('error', { message: 'Invalid fighter data!' });
      return;
    }
    // Validate class
    if (!['Warrior', 'Mage', 'Rogue'].includes(data.class)) {
      socket.emit('error', { message: 'Invalid class!' });
      return;
    }

    players[socket.id].fighter = {
      name: data.name,
      class: data.class,
      level: data.level,
      stats: {
        str: Number(data.stats.str) || 1,
        dex: Number(data.stats.dex) || 1,
        int: Number(data.stats.int) || 1,
        hp: Number(data.stats.hp) || 50,
        lck: Number(data.stats.lck) || 1
      },
      currentHP: Number(data.stats.hp) || 50,
      maxHP: Number(data.stats.hp) || 50,
      arena: {
        rating: Number(data.arena?.rating) || 1000,
        wins: Number(data.arena?.wins) || 0,
        losses: Number(data.arena?.losses) || 0
      },
      equipment: data.equipment || []
    };
    players[socket.id].ready = true;

    console.log(`[REGISTER] ${data.name} (${data.class} Lv.${data.level}) registered from ${socket.id}`);

    socket.emit('registered', {
      message: `Fighter "${data.name}" registered!`,
      fighter: getPublicPlayerInfo(players[socket.id])
    });

    broadcastPlayerList();
  });

  // --------------------------------------------------
  // JOIN PVP QUEUE
  // --------------------------------------------------
  socket.on('joinQueue', () => {
    const player = players[socket.id];
    if (!player || !player.fighter) {
      socket.emit('error', { message: 'Register your fighter first!' });
      return;
    }
    if (player.battleId) {
      socket.emit('error', { message: 'Already in a battle!' });
      return;
    }
    if (pvpQueue.includes(socket.id)) {
      socket.emit('error', { message: 'Already in queue!' });
      return;
    }

    pvpQueue.push(socket.id);
    console.log(`[QUEUE] ${player.fighter.name} joined queue. Queue size: ${pvpQueue.length}`);

    socket.emit('queueJoined', {
      message: 'Searching for opponent...',
      position: pvpQueue.length
    });

    broadcastPlayerList();

    // Try to match players
    tryMatchPlayers();
  });

  // --------------------------------------------------
  // LEAVE PVP QUEUE
  // --------------------------------------------------
  socket.on('leaveQueue', () => {
    pvpQueue = pvpQueue.filter(id => id !== socket.id);
    console.log(`[QUEUE] ${socket.id} left queue. Queue size: ${pvpQueue.length}`);
    socket.emit('queueLeft', { message: 'Left the queue.' });
    broadcastPlayerList();
  });

  // --------------------------------------------------
  // PLAYER ACTION DURING BATTLE (attack/heal/forfeit)
  // --------------------------------------------------
  socket.on('battleAction', (data) => {
    const player = players[socket.id];
    if (!player || !player.battleId) {
      socket.emit('error', { message: 'Not in a battle!' });
      return;
    }

    const battle = activeBattles[player.battleId];
    if (!battle) {
      socket.emit('error', { message: 'Battle not found!' });
      return;
    }
    if (battle.finished) {
      socket.emit('error', { message: 'Battle is already over!' });
      return;
    }
    if (battle.currentTurn !== socket.id) {
      socket.emit('error', { message: 'Not your turn!' });
      return;
    }

    const action = data.action;
    const attackerId = socket.id;
    const defenderId = battle.player1.id === attackerId ? battle.player2.id : battle.player1.id;
    const attacker = battle.player1.id === attackerId ? battle.player1 : battle.player2;
    const defender = battle.player1.id === attackerId ? battle.player2 : battle.player1;

    if (action === 'attack') {
      // Perform attack
      const result = performAttack(attacker.fighter, defender.fighter);
      battle.turns++;

      const logEntry = {
        turn: battle.turns,
        attacker: attacker.fighter.name,
        defender: defender.fighter.name,
        damage: result.damage,
        crit: result.crit,
        blocked: result.blocked,
        defenderHP: defender.fighter.currentHP,
        defenderMaxHP: defender.fighter.maxHP,
        type: 'attack'
      };
      battle.log.push(logEntry);

      // Broadcast turn result to both players
      io.to(battle.player1.id).emit('battleUpdate', {
        battleId: battle.id,
        log: logEntry,
        player1: {
          name: battle.player1.fighter.name,
          currentHP: battle.player1.fighter.currentHP,
          maxHP: battle.player1.fighter.maxHP
        },
        player2: {
          name: battle.player2.fighter.name,
          currentHP: battle.player2.fighter.currentHP,
          maxHP: battle.player2.fighter.maxHP
        },
        currentTurn: null, // Will be set after checking win condition
        turns: battle.turns
      });
      io.to(battle.player2.id).emit('battleUpdate', {
        battleId: battle.id,
        log: logEntry,
        player1: {
          name: battle.player1.fighter.name,
          currentHP: battle.player1.fighter.currentHP,
          maxHP: battle.player1.fighter.maxHP
        },
        player2: {
          name: battle.player2.fighter.name,
          currentHP: battle.player2.fighter.currentHP,
          maxHP: battle.player2.fighter.maxHP
        },
        currentTurn: null,
        turns: battle.turns
      });

      // Check if defender is dead
      if (defender.fighter.currentHP <= 0) {
        endBattle(battle, attackerId, defenderId, 'defeat');
        return;
      }

      // Switch turn
      battle.currentTurn = defenderId;

      // Notify whose turn it is
      setTimeout(() => {
        io.to(battle.player1.id).emit('turnChange', {
          currentTurn: battle.currentTurn,
          currentTurnName: battle.currentTurn === battle.player1.id ? battle.player1.fighter.name : battle.player2.fighter.name
        });
        io.to(battle.player2.id).emit('turnChange', {
          currentTurn: battle.currentTurn,
          currentTurnName: battle.currentTurn === battle.player1.id ? battle.player1.fighter.name : battle.player2.fighter.name
        });
      }, 300);

    } else if (action === 'forfeit') {
      // Forfeit the battle
      battle.log.push({
        turn: battle.turns + 1,
        type: 'forfeit',
        attacker: attacker.fighter.name,
        defender: defender.fighter.name,
        message: `${attacker.fighter.name} forfeits!`
      });
      endBattle(battle, defenderId, attackerId, 'forfeit');
    }
  });

  // --------------------------------------------------
  // CHAT MESSAGE
  // --------------------------------------------------
  socket.on('chatMessage', (data) => {
    const player = players[socket.id];
    if (!player || !player.fighter) return;
    const msg = String(data.message || '').trim().slice(0, 200);
    if (!msg) return;
    io.emit('chatMessage', {
      name: player.fighter.name,
      class: player.fighter.class,
      level: player.fighter.level,
      message: msg,
      time: Date.now()
    });
  });

  // --------------------------------------------------
  // DISCONNECT
  // --------------------------------------------------
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] Player disconnected: ${socket.id}`);

    const player = players[socket.id];

    // Remove from queue
    pvpQueue = pvpQueue.filter(id => id !== socket.id);

    // Handle active battle (auto-forfeit)
    if (player && player.battleId) {
      const battle = activeBattles[player.battleId];
      if (battle && !battle.finished) {
        const winnerId = battle.player1.id === socket.id ? battle.player2.id : battle.player1.id;
        const loserId = socket.id;
        battle.log.push({
          turn: battle.turns + 1,
          type: 'disconnect',
          message: `${player.fighter ? player.fighter.name : 'Player'} disconnected!`
        });
        endBattle(battle, winnerId, loserId, 'disconnect');
      }
    }

    // Remove player
    delete players[socket.id];

    // Broadcast updated counts
    io.emit('onlineCount', Object.keys(players).length);
    broadcastPlayerList();
  });
});

// =====================================================
// MATCHMAKING
// =====================================================

function tryMatchPlayers() {
  // Need at least 2 players in queue
  while (pvpQueue.length >= 2) {
    const id1 = pvpQueue.shift();
    const id2 = pvpQueue.shift();

    const p1 = players[id1];
    const p2 = players[id2];

    // Verify both still connected and have fighters
    if (!p1 || !p1.fighter || !p2 || !p2.fighter) {
      // Put back the valid one
      if (p1 && p1.fighter) pvpQueue.unshift(id1);
      if (p2 && p2.fighter) pvpQueue.unshift(id2);
      continue;
    }

    startBattle(p1, p2);
  }
}

function startBattle(p1, p2) {
  const battleId = generateBattleId();

  // Reset HP for battle
  p1.fighter.currentHP = p1.fighter.maxHP;
  p2.fighter.currentHP = p2.fighter.maxHP;

  const battle = {
    id: battleId,
    player1: { id: p1.id, fighter: { ...p1.fighter } },
    player2: { id: p2.id, fighter: { ...p2.fighter } },
    currentTurn: p1.id, // P1 goes first
    turns: 0,
    log: [],
    finished: false,
    startTime: Date.now()
  };

  activeBattles[battleId] = battle;
  p1.battleId = battleId;
  p2.battleId = battleId;

  console.log(`[BATTLE] ${p1.fighter.name} vs ${p2.fighter.name} — Battle ${battleId}`);

  // Notify both players
  const battleData = {
    battleId,
    opponent: null,
    you: null,
    currentTurn: p1.id,
    currentTurnName: p1.fighter.name
  };

  io.to(p1.id).emit('battleStart', {
    ...battleData,
    you: {
      id: p1.id,
      name: p1.fighter.name,
      class: p1.fighter.class,
      level: p1.fighter.level,
      currentHP: p1.fighter.currentHP,
      maxHP: p1.fighter.maxHP,
      stats: p1.fighter.stats
    },
    opponent: {
      id: p2.id,
      name: p2.fighter.name,
      class: p2.fighter.class,
      level: p2.fighter.level,
      currentHP: p2.fighter.currentHP,
      maxHP: p2.fighter.maxHP,
      stats: p2.fighter.stats
    }
  });

  io.to(p2.id).emit('battleStart', {
    ...battleData,
    you: {
      id: p2.id,
      name: p2.fighter.name,
      class: p2.fighter.class,
      level: p2.fighter.level,
      currentHP: p2.fighter.currentHP,
      maxHP: p2.fighter.maxHP,
      stats: p2.fighter.stats
    },
    opponent: {
      id: p1.id,
      name: p1.fighter.name,
      class: p1.fighter.class,
      level: p1.fighter.level,
      currentHP: p1.fighter.currentHP,
      maxHP: p1.fighter.maxHP,
      stats: p1.fighter.stats
    }
  });

  broadcastPlayerList();
}

function endBattle(battle, winnerId, loserId, reason) {
  if (battle.finished) return;
  battle.finished = true;

  const winner = players[winnerId];
  const loser = players[loserId];

  // Calculate Elo changes
  const winnerRating = winner?.fighter?.arena?.rating || 1000;
  const loserRating = loser?.fighter?.arena?.rating || 1000;
  const elo = calcElo(winnerRating, loserRating);

  // Calculate rewards
  const winnerLevel = winner?.fighter?.level || 1;
  const loserLevel = loser?.fighter?.level || 1;
  const goldReward = Math.round(20 + loserLevel * 10 + Math.abs(elo.winnerChange) * 3);
  const xpReward = Math.round(25 + loserLevel * 8 + Math.abs(elo.winnerChange) * 2);

  // Update winner
  if (winner && winner.fighter) {
    winner.fighter.arena.rating = Math.max(0, winner.fighter.arena.rating + elo.winnerChange);
    winner.fighter.arena.wins++;
    winner.battleId = null;
  }

  // Update loser
  if (loser && loser.fighter) {
    loser.fighter.arena.rating = Math.max(0, loser.fighter.arena.rating + elo.loserChange);
    loser.fighter.arena.losses++;
    loser.battleId = null;
  }

  const resultData = {
    battleId: battle.id,
    winnerId,
    loserId,
    winnerName: winner?.fighter?.name || 'Unknown',
    loserName: loser?.fighter?.name || 'Unknown',
    reason,
    turns: battle.turns,
    winnerRatingChange: elo.winnerChange,
    loserRatingChange: elo.loserChange,
    winnerNewRating: winner?.fighter?.arena?.rating || 1000,
    loserNewRating: loser?.fighter?.arena?.rating || 1000,
    goldReward,
    xpReward,
    log: battle.log
  };

  console.log(`[BATTLE END] ${resultData.winnerName} defeats ${resultData.loserName} (${reason}) — +${elo.winnerChange}/${elo.loserChange} rating`);

  // Notify both players
  if (winner) io.to(winnerId).emit('battleEnd', { ...resultData, youWon: true });
  if (loser) io.to(loserId).emit('battleEnd', { ...resultData, youWon: false });

  // Cleanup
  delete activeBattles[battle.id];
  broadcastPlayerList();
}

// =====================================================
// PERIODIC TASKS
// =====================================================

// Broadcast player list every 5 seconds
broadcastInterval = setInterval(() => {
  broadcastPlayerList();
}, 5000);

// Battle timeout - auto-end battles lasting more than 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const id in activeBattles) {
    const battle = activeBattles[id];
    if (!battle.finished && now - battle.startTime > 300000) {
      // Draw - both lose a little rating
      battle.log.push({ turn: battle.turns + 1, type: 'timeout', message: 'Battle timed out!' });
      // Player with more HP percentage wins
      const p1pct = battle.player1.fighter.currentHP / battle.player1.fighter.maxHP;
      const p2pct = battle.player2.fighter.currentHP / battle.player2.fighter.maxHP;
      if (p1pct >= p2pct) {
        endBattle(battle, battle.player1.id, battle.player2.id, 'timeout');
      } else {
        endBattle(battle, battle.player2.id, battle.player1.id, 'timeout');
      }
    }
  }
}, 10000);

// =====================================================
// START SERVER
// =====================================================

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   ⚔️  REALM OF SHADOWS PvP SERVER  ⚔️   ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   Server running on port ${PORT}            ║`);
  console.log(`║   Open: http://localhost:${PORT}            ║`);
  console.log('║   Share your IP for LAN multiplayer!     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
