// =====================================================
// REALM OF SHADOWS - Multiplayer PvP Server
// Node.js + Socket.IO WebSocket Server
// WITH GUILD SYSTEM + PERSISTENCE + ANTI-CHEAT
// =====================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =====================================================
// DATA PERSISTENCE
// =====================================================
const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const GUILDS_FILE = path.join(DATA_DIR, 'guilds.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('[DATA] Created data/ directory');
  }
}

let playersData = {}; // { token: playerRecord }
let savePlayersTimer = null;
let saveGuildsTimer = null;

function loadPlayersData() {
  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      playersData = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
      console.log(`[DATA] Loaded ${Object.keys(playersData).length} players`);
    }
  } catch (e) {
    console.error('[DATA] Failed to load players.json, starting fresh:', e.message);
    playersData = {};
  }
}

function savePlayersData() {
  if (savePlayersTimer) clearTimeout(savePlayersTimer);
  savePlayersTimer = setTimeout(() => {
    try {
      ensureDataDir();
      fs.writeFileSync(PLAYERS_FILE, JSON.stringify(playersData, null, 2));
    } catch (e) {
      console.error('[DATA] Failed to save players.json:', e.message);
    }
  }, 2000);
}

function loadGuildsData() {
  try {
    if (fs.existsSync(GUILDS_FILE)) {
      guilds = JSON.parse(fs.readFileSync(GUILDS_FILE, 'utf8'));
      for (const guildName in guilds) {
        for (const member of guilds[guildName].members) {
          if (member.token) playerGuild[member.token] = guildName;
        }
      }
      console.log(`[DATA] Loaded ${Object.keys(guilds).length} guilds`);
    }
  } catch (e) {
    console.error('[DATA] Failed to load guilds.json, starting fresh:', e.message);
    guilds = {};
  }
}

function saveGuildsData() {
  if (saveGuildsTimer) clearTimeout(saveGuildsTimer);
  saveGuildsTimer = setTimeout(() => {
    try {
      ensureDataDir();
      fs.writeFileSync(GUILDS_FILE, JSON.stringify(guilds, null, 2));
    } catch (e) {
      console.error('[DATA] Failed to save guilds.json:', e.message);
    }
  }, 2000);
}

// =====================================================
// GAME STATE
// =====================================================
const players = {};
let pvpQueue = [];
const activeBattles = {};
let battleIdCounter = 1;
let broadcastInterval = null;

// Session identity maps (reset on server restart)
const playerTokens = {};  // { socketId: token }
const tokenToSocket = {}; // { token: socketId }

// =====================================================
// GUILD STATE
// =====================================================
let guilds = {};
const playerGuild = {}; // { token: guildName }

const GUILD_CREATION_COST = 500;
const GUILD_UPGRADES = {
  str_bonus:    { name: 'Forge of Strength',   icon: '⚔️', desc: '+2 STR for all members',   levels: 5, costPerLevel: 300,  statKey: 'str', valuePerLevel: 2 },
  dex_bonus:    { name: 'Shadow Training',      icon: '🏃', desc: '+2 DEX for all members',   levels: 5, costPerLevel: 300,  statKey: 'dex', valuePerLevel: 2 },
  int_bonus:    { name: 'Arcane Library',       icon: '📚', desc: '+2 INT for all members',   levels: 5, costPerLevel: 300,  statKey: 'int', valuePerLevel: 2 },
  hp_bonus:     { name: 'Guild Infirmary',      icon: '❤️', desc: '+50 HP for all members',   levels: 5, costPerLevel: 400,  statKey: 'hp',  valuePerLevel: 50 },
  lck_bonus:    { name: 'Fortune Shrine',       icon: '🍀', desc: '+1 LCK for all members',   levels: 5, costPerLevel: 250,  statKey: 'lck', valuePerLevel: 1 },
  xp_bonus:     { name: 'Hall of Learning',     icon: '✨', desc: '+10% XP gain per level',   levels: 5, costPerLevel: 500,  statKey: 'xp',  valuePerLevel: 10 },
  gold_bonus:   { name: 'Merchant Alliance',    icon: '💰', desc: '+5% Gold gain per level',  levels: 5, costPerLevel: 450,  statKey: 'gold',valuePerLevel: 5 },
};

// =====================================================
// CHARACTER CONSTANTS
// =====================================================
const BASE_STATS = {
  Warrior: { str: 8, dex: 4, int: 2, hp: 120, lck: 1 },
  Mage:    { str: 2, dex: 3, int: 8, hp: 80,  lck: 2 },
  Rogue:   { str: 4, dex: 8, int: 3, hp: 90,  lck: 3 }
};
const STARTING_STAT_POINTS = 5;
const STARTING_GOLD = 50;

function xpForLevel(level) { return level * 100; }

function createNewCharacter(token, name, charClass) {
  const base = BASE_STATS[charClass];
  return {
    token, name, class: charClass,
    level: 1, xp: 0,
    stats: { str: base.str, dex: base.dex, int: base.int, hp: base.hp, lck: base.lck },
    statPoints: STARTING_STAT_POINTS,
    gold: STARTING_GOLD,
    currentHP: base.hp,
    arena: { rating: 1000, wins: 0, losses: 0, streak: 0, bestStreak: 0, history: [] },
    equipment: { weapon: null, armor: null, helmet: null, boots: null, amulet: null, ring: null },
    guildName: null
  };
}

function getEquipmentBonus(pd, stat) {
  let bonus = 0;
  const eq = pd.equipment;
  if (!eq) return 0;
  for (const slot of ['weapon', 'armor', 'helmet', 'boots', 'amulet', 'ring']) {
    const item = eq[slot];
    if (item && item.bonuses && typeof item.bonuses[stat] === 'number') bonus += item.bonuses[stat];
  }
  return bonus;
}

function getServerTotalStat(pd, stat) {
  let t = pd.stats[stat];
  const bonuses = getGuildBonuses(pd.guildName);
  t += bonuses[stat] || 0;
  t += getEquipmentBonus(pd, stat);
  return t;
}

function sanitizeEquipment(data) {
  const clean = { weapon: null, armor: null, helmet: null, boots: null, amulet: null, ring: null };
  if (!data || typeof data !== 'object') return clean;
  for (const slot of ['weapon', 'armor', 'helmet', 'boots', 'amulet', 'ring']) {
    const item = data[slot];
    if (item && typeof item === 'object' && item.bonuses && typeof item.bonuses === 'object') {
      const bonuses = {};
      for (const s of ['str', 'dex', 'int', 'hp', 'lck']) {
        bonuses[s] = (typeof item.bonuses[s] === 'number') ? Math.max(0, Math.floor(item.bonuses[s])) : 0;
      }
      clean[slot] = { name: item.name || '', icon: item.icon || '', slot, rarity: item.rarity || 'Common', bonuses, level: Math.floor(Number(item.level) || 1) };
    }
  }
  return clean;
}

function buildFighter(token) {
  const pd = playersData[token];
  if (!pd) return null;
  const stats = {};
  for (const stat of ['str', 'dex', 'int', 'hp', 'lck']) {
    stats[stat] = getServerTotalStat(pd, stat);
  }
  return {
    name: pd.name, class: pd.class, level: pd.level,
    stats,
    currentHP: Math.min(pd.currentHP, stats.hp),
    maxHP: stats.hp,
    arena: { rating: pd.arena.rating, wins: pd.arena.wins, losses: pd.arena.losses },
    equipment: pd.equipment || {}
  };
}

function buildSyncData(token) {
  const pd = playersData[token];
  if (!pd) return null;
  return {
    name: pd.name, class: pd.class, level: pd.level, xp: pd.xp,
    stats: { str: pd.stats.str, dex: pd.stats.dex, int: pd.stats.int, hp: pd.stats.hp, lck: pd.stats.lck },
    statPoints: pd.statPoints, gold: pd.gold, currentHP: pd.currentHP,
    arena: { rating: pd.arena.rating, wins: pd.arena.wins, losses: pd.arena.losses,
             streak: pd.arena.streak, bestStreak: pd.arena.bestStreak, history: pd.arena.history },
    guildName: pd.guildName
  };
}

// =====================================================
// HELPER FUNCTIONS
// =====================================================
function generateBattleId() { return 'battle_' + (battleIdCounter++); }

function calcDamage(fighter) {
  const s = fighter.stats, cls = fighter.class;
  let dmg;
  if (cls === 'Warrior') dmg = s.str * 2 + s.dex * 0.5;
  else if (cls === 'Mage') dmg = s.int * 2.2 + s.dex * 0.3;
  else dmg = s.dex * 1.8 + s.str * 0.6;
  dmg += fighter.level * 1.5;
  return Math.max(1, Math.round(dmg * (0.85 + Math.random() * 0.3)));
}

function isCrit(fighter) {
  return Math.random() * 100 < Math.min(60, (fighter.stats.lck || 0) * 2);
}

function calcDefense(fighter) {
  const s = fighter.stats, cls = fighter.class, lv = fighter.level;
  let def, maxDef;
  if (cls === 'Warrior') { def = (s.str * 0.8 + s.dex * 0.2 + lv * 1.5) * 0.65; maxDef = 60; }
  else if (cls === 'Mage') { def = (s.int * 0.3 + s.dex * 0.2 + lv * 1.0) * 0.5; maxDef = 30; }
  else { def = (s.dex * 0.6 + s.str * 0.2 + lv * 1.2) * 0.55; maxDef = 40; }
  return Math.min(maxDef, def);
}

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

function calcElo(winnerRating, loserRating) {
  const K = 40;
  const expectedWin = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const expectedLose = 1 / (1 + Math.pow(10, (winnerRating - loserRating) / 400));
  return { winnerChange: Math.round(K * (1 - expectedWin)), loserChange: Math.round(K * (0 - expectedLose)) };
}

function getRank(rating) {
  if (rating >= 2200) return { name: 'Legend', icon: '👑' };
  if (rating >= 1800) return { name: 'Diamond', icon: '💎' };
  if (rating >= 1500) return { name: 'Gold', icon: '🥇' };
  if (rating >= 1200) return { name: 'Silver', icon: '🥈' };
  return { name: 'Bronze', icon: '🥉' };
}

function getPublicPlayerInfo(p) {
  if (!p || !p.fighter) return null;
  const f = p.fighter;
  return {
    id: p.id, name: f.name, class: f.class, level: f.level,
    rating: f.arena ? f.arena.rating : 1000,
    rank: getRank(f.arena ? f.arena.rating : 1000),
    wins: f.arena ? f.arena.wins : 0,
    losses: f.arena ? f.arena.losses : 0,
    inBattle: p.battleId !== null,
    inQueue: pvpQueue.includes(p.id),
    guild: p.token ? (playerGuild[p.token] || null) : null
  };
}

function broadcastPlayerList() {
  const list = [];
  for (const id in players) {
    const info = getPublicPlayerInfo(players[id]);
    if (info) list.push(info);
  }
  list.sort((a, b) => b.rating - a.rating);
  io.emit('playerList', list);
}

function getGuildPublicData(guildName) {
  const g = guilds[guildName];
  if (!g) return null;
  return { name: g.name, tag: g.tag, leaderId: g.leaderId, leaderName: g.leaderName,
    memberCount: g.members.length, gold: g.gold, upgrades: g.upgrades,
    members: g.members, createdAt: g.createdAt };
}

function broadcastGuildUpdate(guildName) {
  const g = guilds[guildName];
  if (!g) return;
  const data = getGuildPublicData(guildName);
  g.members.forEach(m => {
    const sid = tokenToSocket[m.token];
    if (sid && players[sid]) io.to(sid).emit('guildUpdate', data);
  });
}

function getGuildBonuses(guildName) {
  if (!guildName || !guilds[guildName]) return {};
  const g = guilds[guildName];
  const bonuses = {};
  for (const key in GUILD_UPGRADES) {
    const upg = GUILD_UPGRADES[key];
    const level = g.upgrades[key] || 0;
    if (level > 0) bonuses[upg.statKey] = (bonuses[upg.statKey] || 0) + level * upg.valuePerLevel;
  }
  return bonuses;
}

// =====================================================
// SOCKET.IO
// =====================================================
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);
  players[socket.id] = { id: socket.id, token: null, fighter: null, battleId: null, ready: false };
  socket.emit('welcome', { id: socket.id, message: 'Connected to Realm of Shadows!', onlineCount: Object.keys(players).length });
  io.emit('onlineCount', Object.keys(players).length);

  // --- REGISTER FIGHTER ---
  socket.on('registerFighter', (data) => {
    if (!data || !data.name || !data.class) {
      socket.emit('error', { message: 'Invalid fighter data!' }); return;
    }
    if (!['Warrior', 'Mage', 'Rogue'].includes(data.class)) {
      socket.emit('error', { message: 'Invalid class!' }); return;
    }

    let token = (data.token && typeof data.token === 'string' && data.token.length > 0) ? data.token : null;

    if (!token || !playersData[token]) {
      token = randomUUID();
      const base = BASE_STATS[data.class];
      // Bootstrap new players from their existing offline state instead of forcing level 1
      const clvl = (typeof data.level === 'number' && data.level >= 1) ? Math.min(1000, Math.floor(data.level)) : 1;
      const cxp  = (typeof data.xp === 'number' && data.xp >= 0) ? Math.min(xpForLevel(clvl) - 1, Math.floor(data.xp)) : 0;
      const csp  = (typeof data.statPoints === 'number' && data.statPoints >= 0) ? Math.min((clvl - 1) * 3 + STARTING_STAT_POINTS, Math.floor(data.statPoints)) : STARTING_STAT_POINTS;
      const cgold = (typeof data.gold === 'number' && data.gold >= 0) ? Math.min(1000000, Math.floor(data.gold)) : STARTING_GOLD;
      const cstats = (data.stats && typeof data.stats === 'object') ? {
        str: Math.min(base.str + 5000, Math.max(base.str, Math.floor(Number(data.stats.str) || base.str))),
        dex: Math.min(base.dex + 5000, Math.max(base.dex, Math.floor(Number(data.stats.dex) || base.dex))),
        int: Math.min(base.int + 5000, Math.max(base.int, Math.floor(Number(data.stats.int) || base.int))),
        hp:  Math.min(base.hp  + 5000, Math.max(base.hp,  Math.floor(Number(data.stats.hp)  || base.hp))),
        lck: Math.min(base.lck + 5000, Math.max(base.lck, Math.floor(Number(data.stats.lck) || base.lck))),
      } : { str: base.str, dex: base.dex, int: base.int, hp: base.hp, lck: base.lck };
      const cequip = sanitizeEquipment(data.equipment);
      playersData[token] = {
        token, name: data.name, class: data.class,
        level: clvl, xp: cxp, stats: cstats, statPoints: csp, gold: cgold, currentHP: cstats.hp,
        arena: { rating: 1000, wins: 0, losses: 0, streak: 0, bestStreak: 0, history: [] },
        equipment: cequip,
        guildName: null
      };
      const maxHP = getServerTotalStat(playersData[token], 'hp');
      playersData[token].currentHP = (typeof data.currentHP === 'number' && data.currentHP > 0) ? Math.min(maxHP, Math.floor(data.currentHP)) : maxHP;
      savePlayersData();
      console.log(`[REGISTER] New player: "${data.name}" (${data.class}) lv=${playersData[token].level} token=${token.slice(0, 8)}...`);
    } else {
      const pd = playersData[token];
      // Accept client's higher level when they have progressed offline since last session
      if (typeof data.level === 'number' && Math.floor(data.level) > pd.level) {
        const clvl = Math.min(1000, Math.floor(data.level));
        pd.level = clvl;
        if (typeof data.xp === 'number' && data.xp >= 0) pd.xp = Math.min(xpForLevel(clvl) - 1, Math.floor(data.xp));
        if (data.stats && typeof data.stats === 'object') {
          for (const s of ['str', 'dex', 'int', 'hp', 'lck']) {
            if (typeof data.stats[s] === 'number') pd.stats[s] = Math.min(BASE_STATS[pd.class][s] + 5000, Math.max(pd.stats[s], Math.floor(data.stats[s])));
          }
        }
        if (typeof data.statPoints === 'number' && data.statPoints >= 0) pd.statPoints = Math.min((clvl - 1) * 3 + STARTING_STAT_POINTS, Math.floor(data.statPoints));
        if (typeof data.gold === 'number' && data.gold >= 0) pd.gold = Math.min(1000000, Math.floor(data.gold));
        pd.equipment = sanitizeEquipment(data.equipment);
        const maxHP = getServerTotalStat(pd, 'hp');
        pd.currentHP = Math.min(maxHP, Math.max(1, typeof data.currentHP === 'number' ? Math.floor(data.currentHP) : pd.currentHP));
        savePlayersData();
        console.log(`[REGISTER] Returning player synced: "${pd.name}" lv=${pd.level} token=${token.slice(0, 8)}...`);
      } else {
        // Accept higher XP and gold within the same level (gains from quests and local combat)
        let changed = false;
        if (typeof data.level === 'number' && Math.floor(data.level) === pd.level) {
          if (typeof data.xp === 'number' && Math.floor(data.xp) > pd.xp) {
            pd.xp = Math.min(xpForLevel(pd.level) - 1, Math.floor(data.xp));
            changed = true;
          }
          if (typeof data.gold === 'number' && Math.floor(data.gold) > pd.gold) {
            pd.gold = Math.min(1000000, Math.floor(data.gold));
            changed = true;
          }
          if (data.equipment) { pd.equipment = sanitizeEquipment(data.equipment); changed = true; }
          if (typeof data.currentHP === 'number') {
            const maxHP = getServerTotalStat(pd, 'hp');
            const newHP = Math.min(maxHP, Math.max(0, Math.floor(data.currentHP)));
            if (newHP !== pd.currentHP) { pd.currentHP = newHP; changed = true; }
          }
        }
        if (changed) {
          savePlayersData();
          console.log(`[REGISTER] Returning player progress synced: "${pd.name}" lv=${pd.level} xp=${pd.xp} token=${token.slice(0, 8)}...`);
        } else {
          console.log(`[REGISTER] Returning player: "${playersData[token].name}" token=${token.slice(0, 8)}...`);
        }
      }
    }

    const pd = playersData[token];

    const oldSid = tokenToSocket[token];
    if (oldSid && oldSid !== socket.id && players[oldSid]) {
      delete playerTokens[oldSid];
      players[oldSid].token = null;
    }

    playerTokens[socket.id] = token;
    tokenToSocket[token] = socket.id;
    players[socket.id].token = token;
    players[socket.id].fighter = buildFighter(token);
    players[socket.id].ready = true;

    if (pd.guildName && guilds[pd.guildName]) {
      playerGuild[token] = pd.guildName;
      const member = guilds[pd.guildName].members.find(m => m.token === token);
      if (member) {
        member.level = pd.level;
        socket.emit('guildUpdate', getGuildPublicData(pd.guildName));
      }
    }

    socket.emit('assignToken', { token });
    socket.emit('syncGameState', buildSyncData(token));
    socket.emit('registered', { message: `Fighter "${pd.name}" registered!`, fighter: getPublicPlayerInfo(players[socket.id]) });
    broadcastPlayerList();
  });

  // --- ALLOCATE STAT ---
  socket.on('allocateStat', (data) => {
    const token = playerTokens[socket.id];
    if (!token || !playersData[token]) { socket.emit('error', { message: 'Not registered!' }); return; }

    const pd = playersData[token];
    const stat = data.stat;
    const amt = Math.max(1, Math.min(Math.floor(Number(data.amt) || 1), 100));

    if (!['str', 'dex', 'int', 'hp', 'lck'].includes(stat)) {
      socket.emit('error', { message: 'Invalid stat!' }); return;
    }

    const pts = Math.min(amt, pd.statPoints);
    if (pts <= 0) { socket.emit('error', { message: 'No stat points available!' }); return; }

    pd.statPoints -= pts;
    if (stat === 'hp') { pd.stats.hp += pts * 10; pd.currentHP += pts * 10; }
    else pd.stats[stat] += pts;

    players[socket.id].fighter = buildFighter(token);
    savePlayersData();
    socket.emit('syncGameState', buildSyncData(token));
    broadcastPlayerList();
  });

  // --- DELETE CHARACTER ---
  socket.on('deleteCharacter', (data) => {
    const token = playerTokens[socket.id];
    if (!token || !playersData[token]) {
      socket.emit('error', { message: 'Character not found!' }); return;
    }

    const guildName = playerGuild[token];
    if (guildName && guilds[guildName]) {
      const g = guilds[guildName];
      const member = g.members.find(m => m.token === token);
      if (member && member.role === 'leader') {
        if (g.members.length === 1) {
          delete guilds[guildName];
          saveGuildsData();
          io.emit('guildListUpdate', getGuildList());
        } else {
          const nextLeader = g.members.find(m => m.token !== token && m.role === 'officer')
                          || g.members.find(m => m.token !== token);
          if (nextLeader) {
            nextLeader.role = 'leader';
            g.leaderId = nextLeader.token;
            g.leaderName = nextLeader.name;
          }
          g.members = g.members.filter(m => m.token !== token);
          g.invites = g.invites.filter(t => t !== token);
          saveGuildsData();
          broadcastGuildUpdate(guildName);
          io.emit('guildListUpdate', getGuildList());
        }
      } else {
        g.members = g.members.filter(m => m.token !== token);
        g.invites = g.invites.filter(t => t !== token);
        saveGuildsData();
        broadcastGuildUpdate(guildName);
      }
      delete playerGuild[token];
    }

    delete playersData[token];
    savePlayersData();

    delete playerTokens[socket.id];
    delete tokenToSocket[token];
    players[socket.id].token = null;
    players[socket.id].fighter = null;
    players[socket.id].ready = false;

    socket.emit('characterDeleted', { message: 'Character deleted successfully.' });
    broadcastPlayerList();
    console.log(`[DELETE] Character deleted for token ${token.slice(0, 8)}...`);
  });

  // =====================================================
  // GUILD EVENTS
  // =====================================================

  socket.on('createGuild', (data) => {
    const token = playerTokens[socket.id];
    const player = players[socket.id];
    if (!player || !player.fighter || !token) { socket.emit('error', { message: 'Register first!' }); return; }
    if (playerGuild[token]) { socket.emit('guildError', { message: 'Already in a guild! Leave first.' }); return; }

    const pd = playersData[token];
    if (!pd) { socket.emit('error', { message: 'Player data not found!' }); return; }
    if (pd.gold < GUILD_CREATION_COST) {
      socket.emit('guildError', { message: `Need ${GUILD_CREATION_COST} gold to create guild!` }); return;
    }

    const name = (data.name || '').trim().slice(0, 30);
    const tag = (data.tag || '').trim().toUpperCase().slice(0, 5);

    if (!name || name.length < 3) { socket.emit('guildError', { message: 'Guild name must be 3-30 chars!' }); return; }
    if (!tag || tag.length < 2) { socket.emit('guildError', { message: 'Tag must be 2-5 chars!' }); return; }
    if (guilds[name]) { socket.emit('guildError', { message: 'Guild name already taken!' }); return; }
    if (Object.values(guilds).some(g => g.tag === tag)) { socket.emit('guildError', { message: 'Tag already taken!' }); return; }

    pd.gold -= GUILD_CREATION_COST;
    guilds[name] = {
      name, tag,
      leaderId: token,
      leaderName: player.fighter.name,
      members: [{ token, name: player.fighter.name, class: player.fighter.class, level: player.fighter.level, role: 'leader' }],
      gold: 0, upgrades: {}, invites: [], createdAt: Date.now()
    };
    playerGuild[token] = name;
    pd.guildName = name;
    savePlayersData();
    saveGuildsData();

    console.log(`[GUILD] Created: ${name} [${tag}] by ${player.fighter.name}`);
    socket.emit('guildCreated', { guild: getGuildPublicData(name), cost: GUILD_CREATION_COST });
    socket.emit('syncGameState', buildSyncData(token));
    broadcastPlayerList();
    io.emit('guildListUpdate', getGuildList());
  });

  socket.on('guildInvite', (data) => {
    const token = playerTokens[socket.id];
    const guildName = token ? playerGuild[token] : null;
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'You are not in a guild!' }); return; }
    const g = guilds[guildName];
    const member = g.members.find(m => m.token === token);
    if (!member || (member.role !== 'leader' && member.role !== 'officer')) {
      socket.emit('guildError', { message: 'Only leader or officer can invite!' }); return;
    }
    const targetId = Object.keys(players).find(id => players[id].fighter && players[id].fighter.name === data.targetName);
    if (!targetId) { socket.emit('guildError', { message: 'Player not found or offline!' }); return; }
    const targetToken = playerTokens[targetId];
    if (!targetToken) { socket.emit('guildError', { message: 'Player not found or offline!' }); return; }
    if (playerGuild[targetToken]) { socket.emit('guildError', { message: 'Player is already in a guild!' }); return; }
    if (g.invites.includes(targetToken)) { socket.emit('guildError', { message: 'Already invited!' }); return; }

    g.invites.push(targetToken);
    io.to(targetId).emit('guildInviteReceived', { guildName, tag: g.tag, leaderName: g.leaderName, invitedBy: players[socket.id].fighter.name });
    socket.emit('guildSuccess', { message: `Invited ${data.targetName} to the guild!` });
    console.log(`[GUILD] Invite: ${data.targetName} to ${guildName}`);
  });

  socket.on('guildAcceptInvite', (data) => {
    const token = playerTokens[socket.id];
    const player = players[socket.id];
    if (!player || !player.fighter || !token) { socket.emit('error', { message: 'Register first!' }); return; }
    if (playerGuild[token]) { socket.emit('guildError', { message: 'Already in a guild!' }); return; }

    const g = guilds[data.guildName];
    if (!g) { socket.emit('guildError', { message: 'Guild no longer exists!' }); return; }
    if (!g.invites.includes(token)) { socket.emit('guildError', { message: 'No invite found!' }); return; }

    g.invites = g.invites.filter(t => t !== token);
    g.members.push({ token, name: player.fighter.name, class: player.fighter.class, level: player.fighter.level, role: 'member' });
    playerGuild[token] = data.guildName;

    const pd = playersData[token];
    if (pd) { pd.guildName = data.guildName; }
    savePlayersData();
    saveGuildsData();

    socket.emit('guildJoined', { guild: getGuildPublicData(data.guildName) });
    broadcastGuildUpdate(data.guildName);
    broadcastPlayerList();
    io.emit('guildListUpdate', getGuildList());

    const leaderSid = tokenToSocket[g.leaderId];
    if (leaderSid) io.to(leaderSid).emit('guildChatMessage', { system: true, message: `${player.fighter.name} joined the guild!` });
    console.log(`[GUILD] ${player.fighter.name} joined ${data.guildName}`);
  });

  socket.on('guildDeclineInvite', (data) => {
    const token = playerTokens[socket.id];
    const g = guilds[data.guildName];
    if (g && token) g.invites = g.invites.filter(t => t !== token);
    socket.emit('guildSuccess', { message: 'Invite declined.' });
  });

  socket.on('leaveGuild', () => {
    const token = playerTokens[socket.id];
    const guildName = token ? playerGuild[token] : null;
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    const player = players[socket.id];
    const member = g.members.find(m => m.token === token);
    if (member && member.role === 'leader') {
      socket.emit('guildError', { message: 'Transfer leadership before leaving!' }); return;
    }
    g.members = g.members.filter(m => m.token !== token);
    g.invites = g.invites.filter(t => t !== token);
    delete playerGuild[token];
    const pd = playersData[token];
    if (pd) { pd.guildName = null; }
    savePlayersData();
    saveGuildsData();
    socket.emit('guildLeft', { message: 'Left the guild.' });
    broadcastGuildUpdate(guildName);
    broadcastPlayerList();
    io.emit('guildListUpdate', getGuildList());
    console.log(`[GUILD] ${player?.fighter?.name} left ${guildName}`);
  });

  socket.on('guildKickMember', (data) => {
    const token = playerTokens[socket.id];
    const guildName = token ? playerGuild[token] : null;
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    const kicker = g.members.find(m => m.token === token);
    if (!kicker || (kicker.role !== 'leader' && kicker.role !== 'officer')) {
      socket.emit('guildError', { message: 'No permission!' }); return;
    }
    const targetMember = g.members.find(m => m.name === data.targetName);
    if (!targetMember) { socket.emit('guildError', { message: 'Member not found!' }); return; }
    if (targetMember.role === 'leader') { socket.emit('guildError', { message: 'Cannot kick the leader!' }); return; }
    if (kicker.role === 'officer' && targetMember.role === 'officer') {
      socket.emit('guildError', { message: 'Officers cannot kick other officers!' }); return;
    }
    const targetToken = targetMember.token;
    g.members = g.members.filter(m => m.name !== data.targetName);
    delete playerGuild[targetToken];
    const targetPd = playersData[targetToken];
    if (targetPd) { targetPd.guildName = null; savePlayersData(); }
    saveGuildsData();
    const targetSid = tokenToSocket[targetToken];
    if (targetSid && players[targetSid]) {
      io.to(targetSid).emit('guildKicked', { guildName, reason: `Kicked by ${kicker.name}` });
    }
    socket.emit('guildSuccess', { message: `${data.targetName} was kicked!` });
    broadcastGuildUpdate(guildName);
    io.emit('guildListUpdate', getGuildList());
    console.log(`[GUILD] ${data.targetName} kicked from ${guildName} by ${kicker.name}`);
  });

  socket.on('guildTransferLeadership', (data) => {
    const token = playerTokens[socket.id];
    const guildName = token ? playerGuild[token] : null;
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    if (g.leaderId !== token) { socket.emit('guildError', { message: 'Only the leader can transfer leadership!' }); return; }
    const targetMember = g.members.find(m => m.name === data.targetName);
    if (!targetMember) { socket.emit('guildError', { message: 'Member not found!' }); return; }
    const oldLeader = g.members.find(m => m.token === token);
    if (oldLeader) oldLeader.role = 'officer';
    targetMember.role = 'leader';
    g.leaderId = targetMember.token;
    g.leaderName = targetMember.name;
    saveGuildsData();
    socket.emit('guildSuccess', { message: `Leadership transferred to ${data.targetName}!` });
    broadcastGuildUpdate(guildName);
    io.emit('guildListUpdate', getGuildList());
    console.log(`[GUILD] Leadership of ${guildName} transferred to ${data.targetName}`);
  });

  socket.on('guildPromoteOfficer', (data) => {
    const token = playerTokens[socket.id];
    const guildName = token ? playerGuild[token] : null;
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    if (g.leaderId !== token) { socket.emit('guildError', { message: 'Only the leader can promote!' }); return; }
    const targetMember = g.members.find(m => m.name === data.targetName);
    if (!targetMember) { socket.emit('guildError', { message: 'Member not found!' }); return; }
    if (targetMember.role !== 'member') { socket.emit('guildError', { message: 'Can only promote regular members!' }); return; }
    targetMember.role = 'officer';
    saveGuildsData();
    socket.emit('guildSuccess', { message: `${data.targetName} promoted to Officer!` });
    const targetSid = tokenToSocket[targetMember.token];
    if (targetSid && players[targetSid]) {
      io.to(targetSid).emit('guildSuccess', { message: 'You were promoted to Officer!' });
    }
    broadcastGuildUpdate(guildName);
    console.log(`[GUILD] ${data.targetName} promoted in ${guildName}`);
  });

  socket.on('guildDemoteOfficer', (data) => {
    const token = playerTokens[socket.id];
    const guildName = token ? playerGuild[token] : null;
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    if (g.leaderId !== token) { socket.emit('guildError', { message: 'Only the leader can demote!' }); return; }
    const targetMember = g.members.find(m => m.name === data.targetName);
    if (!targetMember || targetMember.role !== 'officer') {
      socket.emit('guildError', { message: 'Target is not an officer!' }); return;
    }
    targetMember.role = 'member';
    saveGuildsData();
    socket.emit('guildSuccess', { message: `${data.targetName} demoted to Member.` });
    broadcastGuildUpdate(guildName);
    console.log(`[GUILD] ${data.targetName} demoted in ${guildName}`);
  });

  socket.on('guildDeposit', (data) => {
    const token = playerTokens[socket.id];
    const guildName = token ? playerGuild[token] : null;
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const pd = token ? playersData[token] : null;
    if (!pd) { socket.emit('error', { message: 'Player data not found!' }); return; }
    const amount = Math.floor(Number(data.amount));
    if (!amount || amount <= 0) { socket.emit('guildError', { message: 'Invalid amount!' }); return; }
    if (pd.gold < amount) { socket.emit('guildError', { message: 'Not enough gold!' }); return; }
    pd.gold -= amount;
    const g = guilds[guildName];
    g.gold += amount;
    savePlayersData();
    saveGuildsData();
    const depositor = players[socket.id]?.fighter?.name || 'Unknown';
    socket.emit('guildDeposited', { amount, newGuildGold: g.gold, message: `Deposited ${amount} gold to guild bank!` });
    socket.emit('syncGameState', buildSyncData(token));
    broadcastGuildUpdate(guildName);
    g.members.forEach(m => {
      const sid = tokenToSocket[m.token];
      if (sid && players[sid] && m.token !== token) {
        io.to(sid).emit('guildChatMessage', { system: true, message: `${depositor} deposited ${amount} gold to the guild bank!` });
      }
    });
    console.log(`[GUILD] ${depositor} deposited ${amount}g to ${guildName}`);
  });

  socket.on('guildBuyUpgrade', (data) => {
    const token = playerTokens[socket.id];
    const guildName = token ? playerGuild[token] : null;
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    const member = g.members.find(m => m.token === token);
    if (!member || (member.role !== 'leader' && member.role !== 'officer')) {
      socket.emit('guildError', { message: 'Only leader or officer can buy upgrades!' }); return;
    }
    const upg = GUILD_UPGRADES[data.upgradeKey];
    if (!upg) { socket.emit('guildError', { message: 'Invalid upgrade!' }); return; }
    const currentLevel = g.upgrades[data.upgradeKey] || 0;
    if (currentLevel >= upg.levels) { socket.emit('guildError', { message: 'Upgrade already at max level!' }); return; }
    const cost = upg.costPerLevel * (currentLevel + 1);
    if (g.gold < cost) { socket.emit('guildError', { message: `Need ${cost} gold! Guild has ${g.gold}.` }); return; }
    g.gold -= cost;
    g.upgrades[data.upgradeKey] = currentLevel + 1;
    saveGuildsData();
    const bonuses = getGuildBonuses(guildName);
    const buyerName = member.name;
    socket.emit('guildUpgradeBought', { upgradeKey: data.upgradeKey, newLevel: currentLevel + 1, cost, newGuildGold: g.gold });
    broadcastGuildUpdate(guildName);
    g.members.forEach(m => {
      const sid = tokenToSocket[m.token];
      if (sid && players[sid]) {
        io.to(sid).emit('guildBonusUpdate', { bonuses });
        if (m.token !== token) {
          io.to(sid).emit('guildChatMessage', { system: true, message: `${buyerName} upgraded ${upg.name} to level ${currentLevel + 1}!` });
        }
      }
    });
    console.log(`[GUILD] ${buyerName} bought ${upg.name} Lv${currentLevel+1} in ${guildName} for ${cost}g`);
  });

  socket.on('getGuildList', () => { socket.emit('guildListUpdate', getGuildList()); });
  socket.on('getGuildUpgradesInfo', () => { socket.emit('guildUpgradesInfo', GUILD_UPGRADES); });

  socket.on('guildChatMessage', (data) => {
    const token = playerTokens[socket.id];
    const guildName = token ? playerGuild[token] : null;
    if (!guildName || !guilds[guildName]) return;
    const player = players[socket.id];
    if (!player || !player.fighter) return;
    const msg = String(data.message || '').trim().slice(0, 200);
    if (!msg) return;
    const g = guilds[guildName];
    const member = g.members.find(m => m.token === token);
    const role = member ? member.role : 'member';
    g.members.forEach(m => {
      const sid = tokenToSocket[m.token];
      if (sid && players[sid]) {
        io.to(sid).emit('guildChatMessage', { name: player.fighter.name, class: player.fighter.class, role, message: msg });
      }
    });
  });

  // --- PVP QUEUE ---
  socket.on('joinQueue', () => {
    const player = players[socket.id];
    if (!player || !player.fighter) { socket.emit('error', { message: 'Register first!' }); return; }
    if (player.battleId) { socket.emit('error', { message: 'Already in a battle!' }); return; }
    if (pvpQueue.includes(socket.id)) { socket.emit('error', { message: 'Already in queue!' }); return; }
    pvpQueue.push(socket.id);
    socket.emit('queueJoined', { message: 'Searching for opponent...', position: pvpQueue.length });
    broadcastPlayerList();
    tryMatchPlayers();
  });

  socket.on('leaveQueue', () => {
    pvpQueue = pvpQueue.filter(id => id !== socket.id);
    socket.emit('queueLeft', { message: 'Left the queue.' });
    broadcastPlayerList();
  });

  // --- BATTLE ACTION ---
  socket.on('battleAction', (data) => {
    const player = players[socket.id];
    if (!player || !player.battleId) { socket.emit('error', { message: 'Not in a battle!' }); return; }
    const battle = activeBattles[player.battleId];
    if (!battle || battle.finished) { socket.emit('error', { message: 'Battle not found or over!' }); return; }
    if (battle.currentTurn !== socket.id) { socket.emit('error', { message: 'Not your turn!' }); return; }

    const attackerId = socket.id;
    const defenderId = battle.player1.id === attackerId ? battle.player2.id : battle.player1.id;
    const attacker = battle.player1.id === attackerId ? battle.player1 : battle.player2;
    const defender = battle.player1.id === attackerId ? battle.player2 : battle.player1;

    if (data.action === 'attack') {
      const result = performAttack(attacker.fighter, defender.fighter);
      battle.turns++;
      const logEntry = {
        turn: battle.turns, attacker: attacker.fighter.name, defender: defender.fighter.name,
        damage: result.damage, crit: result.crit, blocked: result.blocked,
        defenderHP: defender.fighter.currentHP, defenderMaxHP: defender.fighter.maxHP, type: 'attack'
      };
      battle.log.push(logEntry);
      const updatePayload = {
        battleId: battle.id, log: logEntry,
        player1: { name: battle.player1.fighter.name, currentHP: battle.player1.fighter.currentHP, maxHP: battle.player1.fighter.maxHP },
        player2: { name: battle.player2.fighter.name, currentHP: battle.player2.fighter.currentHP, maxHP: battle.player2.fighter.maxHP },
        currentTurn: null, turns: battle.turns
      };
      io.to(battle.player1.id).emit('battleUpdate', updatePayload);
      io.to(battle.player2.id).emit('battleUpdate', updatePayload);
      if (defender.fighter.currentHP <= 0) { endBattle(battle, attackerId, defenderId, 'defeat'); return; }
      battle.currentTurn = defenderId;
      setTimeout(() => {
        const turnData = { currentTurn: battle.currentTurn, currentTurnName: battle.currentTurn === battle.player1.id ? battle.player1.fighter.name : battle.player2.fighter.name };
        io.to(battle.player1.id).emit('turnChange', turnData);
        io.to(battle.player2.id).emit('turnChange', turnData);
      }, 300);
    } else if (data.action === 'forfeit') {
      battle.log.push({ turn: battle.turns + 1, type: 'forfeit', attacker: attacker.fighter.name, defender: defender.fighter.name, message: `${attacker.fighter.name} forfeits!` });
      endBattle(battle, defenderId, attackerId, 'forfeit');
    }
  });

  // --- CHAT ---
  socket.on('chatMessage', (data) => {
    const player = players[socket.id];
    if (!player || !player.fighter) return;
    const msg = String(data.message || '').trim().slice(0, 200);
    if (!msg) return;
    io.emit('chatMessage', { name: player.fighter.name, class: player.fighter.class, level: player.fighter.level, message: msg, time: Date.now() });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    const player = players[socket.id];
    const token = playerTokens[socket.id];
    pvpQueue = pvpQueue.filter(id => id !== socket.id);

    if (player && player.battleId) {
      const battle = activeBattles[player.battleId];
      if (battle && !battle.finished) {
        const winnerId = battle.player1.id === socket.id ? battle.player2.id : battle.player1.id;
        battle.log.push({ turn: battle.turns + 1, type: 'disconnect', message: `${player.fighter ? player.fighter.name : 'Player'} disconnected!` });
        endBattle(battle, winnerId, socket.id, 'disconnect');
      }
    }

    if (token) {
      const guildName = playerGuild[token];
      if (guildName && guilds[guildName]) {
        guilds[guildName].invites = guilds[guildName].invites.filter(t => t !== token);
      }
      delete tokenToSocket[token];
      delete playerTokens[socket.id];
    }

    delete players[socket.id];
    io.emit('onlineCount', Object.keys(players).length);
    broadcastPlayerList();
  });
});

// =====================================================
// GUILD HELPERS
// =====================================================
function getGuildList() {
  return Object.values(guilds).map(g => ({
    name: g.name, tag: g.tag, leaderName: g.leaderName,
    memberCount: g.members.length, gold: g.gold, upgrades: g.upgrades
  })).sort((a, b) => b.memberCount - a.memberCount);
}

// =====================================================
// MATCHMAKING
// =====================================================
function tryMatchPlayers() {
  while (pvpQueue.length >= 2) {
    const id1 = pvpQueue.shift(), id2 = pvpQueue.shift();
    const p1 = players[id1], p2 = players[id2];
    if (!p1 || !p1.fighter || !p2 || !p2.fighter) {
      if (p1 && p1.fighter) pvpQueue.unshift(id1);
      if (p2 && p2.fighter) pvpQueue.unshift(id2);
      continue;
    }
    startBattle(p1, p2);
  }
}

function startBattle(p1, p2) {
  const battleId = generateBattleId();
  const token1 = playerTokens[p1.id];
  const token2 = playerTokens[p2.id];
  const f1 = (token1 ? buildFighter(token1) : null) || { ...p1.fighter };
  const f2 = (token2 ? buildFighter(token2) : null) || { ...p2.fighter };
  f1.currentHP = f1.maxHP;
  f2.currentHP = f2.maxHP;
  const battle = {
    id: battleId,
    player1: { id: p1.id, fighter: f1 },
    player2: { id: p2.id, fighter: f2 },
    currentTurn: p1.id, turns: 0, log: [], finished: false, startTime: Date.now()
  };
  activeBattles[battleId] = battle;
  p1.battleId = battleId;
  p2.battleId = battleId;
  const baseData = { battleId, currentTurn: p1.id, currentTurnName: f1.name };
  io.to(p1.id).emit('battleStart', { ...baseData,
    you: { id: p1.id, name: f1.name, class: f1.class, level: f1.level, currentHP: f1.currentHP, maxHP: f1.maxHP, stats: f1.stats },
    opponent: { id: p2.id, name: f2.name, class: f2.class, level: f2.level, currentHP: f2.currentHP, maxHP: f2.maxHP, stats: f2.stats }
  });
  io.to(p2.id).emit('battleStart', { ...baseData,
    you: { id: p2.id, name: f2.name, class: f2.class, level: f2.level, currentHP: f2.currentHP, maxHP: f2.maxHP, stats: f2.stats },
    opponent: { id: p1.id, name: f1.name, class: f1.class, level: f1.level, currentHP: f1.currentHP, maxHP: f1.maxHP, stats: f1.stats }
  });
  broadcastPlayerList();
  console.log(`[BATTLE] ${f1.name} vs ${f2.name} — ${battleId}`);
}

function endBattle(battle, winnerId, loserId, reason) {
  if (battle.finished) return;
  battle.finished = true;
  const winner = players[winnerId];
  const loser = players[loserId];
  const winnerToken = winner ? playerTokens[winnerId] : null;
  const loserToken = loser ? playerTokens[loserId] : null;
  const winnerPd = winnerToken ? playersData[winnerToken] : null;
  const loserPd = loserToken ? playersData[loserToken] : null;
  const winnerRating = winnerPd ? winnerPd.arena.rating : (winner?.fighter?.arena?.rating || 1000);
  const loserRating = loserPd ? loserPd.arena.rating : (loser?.fighter?.arena?.rating || 1000);
  const elo = calcElo(winnerRating, loserRating);
  const goldReward = Math.round(20 + (loserPd ? loserPd.level : (loser?.fighter?.level || 1)) * 10 + Math.abs(elo.winnerChange) * 3);
  const xpReward = Math.round(25 + (loserPd ? loserPd.level : (loser?.fighter?.level || 1)) * 8 + Math.abs(elo.winnerChange) * 2);

  if (winnerPd) {
    winnerPd.arena.rating = Math.max(0, winnerRating + elo.winnerChange);
    winnerPd.arena.wins++;
    winnerPd.arena.streak = (winnerPd.arena.streak || 0) + 1;
    if (winnerPd.arena.streak > (winnerPd.arena.bestStreak || 0)) winnerPd.arena.bestStreak = winnerPd.arena.streak;
    winnerPd.gold += goldReward;
    winnerPd.xp += xpReward;
    while (winnerPd.xp >= xpForLevel(winnerPd.level)) {
      winnerPd.xp -= xpForLevel(winnerPd.level);
      winnerPd.level++;
      winnerPd.statPoints += 3;
    }
    winnerPd.arena.history = (winnerPd.arena.history || []).concat([{
      won: true, oppName: loserPd ? loserPd.name : (loser?.fighter?.name || 'Unknown'),
      ratingChange: elo.winnerChange, time: Date.now()
    }]).slice(-50);
  }
  if (loserPd) {
    loserPd.arena.rating = Math.max(0, loserRating + elo.loserChange);
    loserPd.arena.losses++;
    loserPd.arena.streak = 0;
    loserPd.arena.history = (loserPd.arena.history || []).concat([{
      won: false, oppName: winnerPd ? winnerPd.name : (winner?.fighter?.name || 'Unknown'),
      ratingChange: elo.loserChange, time: Date.now()
    }]).slice(-50);
  }
  savePlayersData();

  if (winner?.fighter) { if (winnerPd) winner.fighter.arena = { rating: winnerPd.arena.rating, wins: winnerPd.arena.wins, losses: winnerPd.arena.losses }; winner.battleId = null; }
  if (loser?.fighter) { if (loserPd) loser.fighter.arena = { rating: loserPd.arena.rating, wins: loserPd.arena.wins, losses: loserPd.arena.losses }; loser.battleId = null; }

  const resultData = {
    battleId: battle.id, winnerId, loserId,
    winnerName: winner?.fighter?.name || 'Unknown',
    loserName: loser?.fighter?.name || 'Unknown',
    reason, turns: battle.turns,
    winnerRatingChange: elo.winnerChange, loserRatingChange: elo.loserChange,
    winnerNewRating: winnerPd ? winnerPd.arena.rating : Math.max(0, winnerRating + elo.winnerChange),
    loserNewRating: loserPd ? loserPd.arena.rating : Math.max(0, loserRating + elo.loserChange),
    goldReward, xpReward, log: battle.log
  };

  if (winner) {
    io.to(winnerId).emit('battleEnd', { ...resultData, youWon: true });
    if (winnerToken) io.to(winnerId).emit('syncGameState', buildSyncData(winnerToken));
  }
  if (loser) {
    io.to(loserId).emit('battleEnd', { ...resultData, youWon: false });
    if (loserToken) io.to(loserId).emit('syncGameState', buildSyncData(loserToken));
  }
  delete activeBattles[battle.id];
  broadcastPlayerList();
  console.log(`[BATTLE END] ${resultData.winnerName} defeats ${resultData.loserName} (${reason})`);
}

// =====================================================
// PERIODIC TASKS
// =====================================================
broadcastInterval = setInterval(() => { broadcastPlayerList(); }, 5000);

setInterval(() => {
  const now = Date.now();
  for (const id in activeBattles) {
    const battle = activeBattles[id];
    if (!battle.finished && now - battle.startTime > 300000) {
      battle.log.push({ turn: battle.turns + 1, type: 'timeout', message: 'Battle timed out!' });
      const p1pct = battle.player1.fighter.currentHP / battle.player1.fighter.maxHP;
      const p2pct = battle.player2.fighter.currentHP / battle.player2.fighter.maxHP;
      endBattle(battle, p1pct >= p2pct ? battle.player1.id : battle.player2.id, p1pct >= p2pct ? battle.player2.id : battle.player1.id, 'timeout');
    }
  }
}, 10000);

// =====================================================
// START SERVER
// =====================================================
ensureDataDir();
loadPlayersData();
loadGuildsData();

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║  REALM OF SHADOWS PvP+Guild SERVER   ║');
  console.log(`║  Port: ${PORT}                            ║`);
  console.log(`║  http://localhost:${PORT}               ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
});
