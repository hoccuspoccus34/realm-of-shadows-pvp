// =====================================================
// REALM OF SHADOWS - Multiplayer PvP Server
// Node.js + Socket.IO WebSocket Server
// WITH GUILD SYSTEM
// =====================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =====================================================
// GAME STATE
// =====================================================
const players = {};
let pvpQueue = [];
const activeBattles = {};
let battleIdCounter = 1;
let broadcastInterval = null;

// =====================================================
// GUILD STATE
// =====================================================
// guilds: { guildName: { name, tag, leaderId, leaderName, members: [{id, name, class, level, role}], gold, upgrades, invites: [socketId], createdAt } }
const guilds = {};
// playerGuild: { socketId: guildName }
const playerGuild = {};

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
    id: p.id,
    name: f.name,
    class: f.class,
    level: f.level,
    rating: f.arena ? f.arena.rating : 1000,
    rank: getRank(f.arena ? f.arena.rating : 1000),
    wins: f.arena ? f.arena.wins : 0,
    losses: f.arena ? f.arena.losses : 0,
    inBattle: p.battleId !== null,
    inQueue: pvpQueue.includes(p.id),
    guild: playerGuild[p.id] || null
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
  return {
    name: g.name,
    tag: g.tag,
    leaderId: g.leaderId,
    leaderName: g.leaderName,
    memberCount: g.members.length,
    gold: g.gold,
    upgrades: g.upgrades,
    members: g.members,
    createdAt: g.createdAt
  };
}

function broadcastGuildUpdate(guildName) {
  const g = guilds[guildName];
  if (!g) return;
  const data = getGuildPublicData(guildName);
  g.members.forEach(m => {
    if (players[m.id]) {
      io.to(m.id).emit('guildUpdate', data);
    }
  });
}

function getGuildBonuses(guildName) {
  if (!guildName || !guilds[guildName]) return {};
  const g = guilds[guildName];
  const bonuses = {};
  for (const key in GUILD_UPGRADES) {
    const upg = GUILD_UPGRADES[key];
    const level = g.upgrades[key] || 0;
    if (level > 0) {
      bonuses[upg.statKey] = (bonuses[upg.statKey] || 0) + level * upg.valuePerLevel;
    }
  }
  return bonuses;
}

// =====================================================
// SOCKET.IO
// =====================================================
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);
  players[socket.id] = { id: socket.id, fighter: null, battleId: null, ready: false };

  socket.emit('welcome', { id: socket.id, message: 'Connected to Realm of Shadows!', onlineCount: Object.keys(players).length });
  io.emit('onlineCount', Object.keys(players).length);

  // --- REGISTER FIGHTER ---
  socket.on('registerFighter', (data) => {
    if (!data || !data.name || !data.class || !data.level || !data.stats) {
      socket.emit('error', { message: 'Invalid fighter data!' }); return;
    }
    if (!['Warrior', 'Mage', 'Rogue'].includes(data.class)) {
      socket.emit('error', { message: 'Invalid class!' }); return;
    }
    players[socket.id].fighter = {
      name: data.name, class: data.class, level: data.level,
      stats: { str: Number(data.stats.str)||1, dex: Number(data.stats.dex)||1, int: Number(data.stats.int)||1, hp: Number(data.stats.hp)||50, lck: Number(data.stats.lck)||1 },
      currentHP: Number(data.stats.hp)||50, maxHP: Number(data.stats.hp)||50,
      arena: { rating: Number(data.arena?.rating)||1000, wins: Number(data.arena?.wins)||0, losses: Number(data.arena?.losses)||0 },
      equipment: data.equipment || []
    };
    players[socket.id].ready = true;

    // Restore guild membership if name matches
    if (data.guildName && guilds[data.guildName]) {
      const g = guilds[data.guildName];
      const member = g.members.find(m => m.name === data.name);
      if (member) {
        member.id = socket.id;
        playerGuild[socket.id] = data.guildName;
        socket.emit('guildUpdate', getGuildPublicData(data.guildName));
      }
    }

    socket.emit('registered', { message: `Fighter "${data.name}" registered!`, fighter: getPublicPlayerInfo(players[socket.id]) });
    broadcastPlayerList();
  });

  // =====================================================
  // GUILD EVENTS
  // =====================================================

  // CREATE GUILD
  socket.on('createGuild', (data) => {
    const player = players[socket.id];
    if (!player || !player.fighter) { socket.emit('error', { message: 'Register first!' }); return; }
    if (playerGuild[socket.id]) { socket.emit('guildError', { message: 'Already in a guild! Leave first.' }); return; }

    const name = (data.name || '').trim().slice(0, 30);
    const tag = (data.tag || '').trim().toUpperCase().slice(0, 5);

    if (!name || name.length < 3) { socket.emit('guildError', { message: 'Guild name must be 3-30 chars!' }); return; }
    if (!tag || tag.length < 2) { socket.emit('guildError', { message: 'Tag must be 2-5 chars!' }); return; }
    if (guilds[name]) { socket.emit('guildError', { message: 'Guild name already taken!' }); return; }
    if (Object.values(guilds).some(g => g.tag === tag)) { socket.emit('guildError', { message: 'Tag already taken!' }); return; }
    // Gold check handled client-side; server trusts player sent correct data with gold value
    if (data.playerGold < GUILD_CREATION_COST) { socket.emit('guildError', { message: `Need ${GUILD_CREATION_COST} gold to create guild!` }); return; }

    guilds[name] = {
      name, tag,
      leaderId: socket.id,
      leaderName: player.fighter.name,
      members: [{ id: socket.id, name: player.fighter.name, class: player.fighter.class, level: player.fighter.level, role: 'leader' }],
      gold: 0,
      upgrades: {},
      invites: [],
      createdAt: Date.now()
    };
    playerGuild[socket.id] = name;

    console.log(`[GUILD] Created: ${name} [${tag}] by ${player.fighter.name}`);
    socket.emit('guildCreated', { guild: getGuildPublicData(name), cost: GUILD_CREATION_COST });
    broadcastPlayerList();
    io.emit('guildListUpdate', getGuildList());
  });

  // INVITE PLAYER
  socket.on('guildInvite', (data) => {
    const guildName = playerGuild[socket.id];
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'You are not in a guild!' }); return; }
    const g = guilds[guildName];
    const member = g.members.find(m => m.id === socket.id);
    if (!member || (member.role !== 'leader' && member.role !== 'officer')) {
      socket.emit('guildError', { message: 'Only leader or officer can invite!' }); return;
    }
    // Find target player by name
    const targetId = Object.keys(players).find(id => players[id].fighter && players[id].fighter.name === data.targetName);
    if (!targetId) { socket.emit('guildError', { message: 'Player not found or offline!' }); return; }
    if (playerGuild[targetId]) { socket.emit('guildError', { message: 'Player is already in a guild!' }); return; }
    if (g.invites.includes(targetId)) { socket.emit('guildError', { message: 'Already invited!' }); return; }

    g.invites.push(targetId);
    io.to(targetId).emit('guildInviteReceived', { guildName, tag: g.tag, leaderName: g.leaderName, invitedBy: players[socket.id].fighter.name });
    socket.emit('guildSuccess', { message: `Invited ${data.targetName} to the guild!` });
    console.log(`[GUILD] Invite: ${data.targetName} → ${guildName}`);
  });

  // ACCEPT INVITE
  socket.on('guildAcceptInvite', (data) => {
    const player = players[socket.id];
    if (!player || !player.fighter) { socket.emit('error', { message: 'Register first!' }); return; }
    if (playerGuild[socket.id]) { socket.emit('guildError', { message: 'Already in a guild!' }); return; }

    const g = guilds[data.guildName];
    if (!g) { socket.emit('guildError', { message: 'Guild no longer exists!' }); return; }
    if (!g.invites.includes(socket.id)) { socket.emit('guildError', { message: 'No invite found!' }); return; }

    g.invites = g.invites.filter(id => id !== socket.id);
    g.members.push({ id: socket.id, name: player.fighter.name, class: player.fighter.class, level: player.fighter.level, role: 'member' });
    playerGuild[socket.id] = data.guildName;

    socket.emit('guildJoined', { guild: getGuildPublicData(data.guildName) });
    broadcastGuildUpdate(data.guildName);
    broadcastPlayerList();
    io.emit('guildListUpdate', getGuildList());
    // Notify guild chat
    io.to(g.leaderId).emit('guildChatMessage', { system: true, message: `${player.fighter.name} joined the guild! ⚔️` });
    console.log(`[GUILD] ${player.fighter.name} joined ${data.guildName}`);
  });

  // DECLINE INVITE
  socket.on('guildDeclineInvite', (data) => {
    const g = guilds[data.guildName];
    if (g) g.invites = g.invites.filter(id => id !== socket.id);
    socket.emit('guildSuccess', { message: 'Invite declined.' });
  });

  // LEAVE GUILD
  socket.on('leaveGuild', () => {
    const guildName = playerGuild[socket.id];
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    const player = players[socket.id];
    const member = g.members.find(m => m.id === socket.id);

    if (member && member.role === 'leader') {
      socket.emit('guildError', { message: 'Transfer leadership before leaving!' }); return;
    }

    g.members = g.members.filter(m => m.id !== socket.id);
    delete playerGuild[socket.id];
    socket.emit('guildLeft', { message: 'Left the guild.' });
    broadcastGuildUpdate(guildName);
    broadcastPlayerList();
    io.emit('guildListUpdate', getGuildList());
    console.log(`[GUILD] ${player?.fighter?.name} left ${guildName}`);
  });

  // KICK MEMBER (leader/officer only)
  socket.on('guildKickMember', (data) => {
    const guildName = playerGuild[socket.id];
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    const kicker = g.members.find(m => m.id === socket.id);
    if (!kicker || (kicker.role !== 'leader' && kicker.role !== 'officer')) {
      socket.emit('guildError', { message: 'No permission!' }); return;
    }
    const targetMember = g.members.find(m => m.name === data.targetName);
    if (!targetMember) { socket.emit('guildError', { message: 'Member not found!' }); return; }
    if (targetMember.role === 'leader') { socket.emit('guildError', { message: 'Cannot kick the leader!' }); return; }
    if (kicker.role === 'officer' && targetMember.role === 'officer') { socket.emit('guildError', { message: 'Officers cannot kick other officers!' }); return; }

    g.members = g.members.filter(m => m.name !== data.targetName);
    if (players[targetMember.id]) {
      delete playerGuild[targetMember.id];
      io.to(targetMember.id).emit('guildKicked', { guildName, reason: `Kicked by ${kicker.name}` });
    }
    socket.emit('guildSuccess', { message: `${data.targetName} was kicked!` });
    broadcastGuildUpdate(guildName);
    io.emit('guildListUpdate', getGuildList());
    console.log(`[GUILD] ${data.targetName} kicked from ${guildName} by ${kicker.name}`);
  });

  // TRANSFER LEADERSHIP
  socket.on('guildTransferLeadership', (data) => {
    const guildName = playerGuild[socket.id];
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    if (g.leaderId !== socket.id) { socket.emit('guildError', { message: 'Only the leader can transfer leadership!' }); return; }

    const targetMember = g.members.find(m => m.name === data.targetName);
    if (!targetMember) { socket.emit('guildError', { message: 'Member not found!' }); return; }

    // Demote old leader to officer
    const oldLeader = g.members.find(m => m.id === socket.id);
    if (oldLeader) oldLeader.role = 'officer';

    // Promote new leader
    targetMember.role = 'leader';
    g.leaderId = targetMember.id;
    g.leaderName = targetMember.name;

    socket.emit('guildSuccess', { message: `Leadership transferred to ${data.targetName}!` });
    broadcastGuildUpdate(guildName);
    io.emit('guildListUpdate', getGuildList());
    console.log(`[GUILD] Leadership of ${guildName} transferred to ${data.targetName}`);
  });

  // PROMOTE TO OFFICER
  socket.on('guildPromoteOfficer', (data) => {
    const guildName = playerGuild[socket.id];
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    if (g.leaderId !== socket.id) { socket.emit('guildError', { message: 'Only the leader can promote!' }); return; }

    const targetMember = g.members.find(m => m.name === data.targetName);
    if (!targetMember) { socket.emit('guildError', { message: 'Member not found!' }); return; }
    if (targetMember.role !== 'member') { socket.emit('guildError', { message: 'Can only promote regular members!' }); return; }

    targetMember.role = 'officer';
    socket.emit('guildSuccess', { message: `${data.targetName} promoted to Officer!` });
    if (players[targetMember.id]) {
      io.to(targetMember.id).emit('guildSuccess', { message: 'You were promoted to Officer! 🎖️' });
    }
    broadcastGuildUpdate(guildName);
    console.log(`[GUILD] ${data.targetName} promoted to officer in ${guildName}`);
  });

  // DEMOTE OFFICER
  socket.on('guildDemoteOfficer', (data) => {
    const guildName = playerGuild[socket.id];
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    if (g.leaderId !== socket.id) { socket.emit('guildError', { message: 'Only the leader can demote!' }); return; }

    const targetMember = g.members.find(m => m.name === data.targetName);
    if (!targetMember || targetMember.role !== 'officer') { socket.emit('guildError', { message: 'Target is not an officer!' }); return; }

    targetMember.role = 'member';
    socket.emit('guildSuccess', { message: `${data.targetName} demoted to Member.` });
    broadcastGuildUpdate(guildName);
    console.log(`[GUILD] ${data.targetName} demoted in ${guildName}`);
  });

  // DEPOSIT GOLD TO GUILD
  socket.on('guildDeposit', (data) => {
    const guildName = playerGuild[socket.id];
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const amount = Math.floor(Number(data.amount));
    if (!amount || amount <= 0) { socket.emit('guildError', { message: 'Invalid amount!' }); return; }
    if (data.playerGold < amount) { socket.emit('guildError', { message: 'Not enough gold!' }); return; }

    const g = guilds[guildName];
    g.gold += amount;

    const depositor = players[socket.id]?.fighter?.name || 'Unknown';
    socket.emit('guildDeposited', { amount, newGuildGold: g.gold, message: `Deposited ${amount} gold to guild bank!` });
    broadcastGuildUpdate(guildName);

    // Notify all guild members
    g.members.forEach(m => {
      if (players[m.id] && m.id !== socket.id) {
        io.to(m.id).emit('guildChatMessage', { system: true, message: `💰 ${depositor} deposited ${amount} gold to the guild bank!` });
      }
    });
    console.log(`[GUILD] ${depositor} deposited ${amount}g to ${guildName}`);
  });

  // BUY GUILD UPGRADE (leader/officer only)
  socket.on('guildBuyUpgrade', (data) => {
    const guildName = playerGuild[socket.id];
    if (!guildName || !guilds[guildName]) { socket.emit('guildError', { message: 'Not in a guild!' }); return; }
    const g = guilds[guildName];
    const member = g.members.find(m => m.id === socket.id);
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

    const bonuses = getGuildBonuses(guildName);
    const buyerName = member.name;

    socket.emit('guildUpgradeBought', { upgradeKey: data.upgradeKey, newLevel: currentLevel + 1, cost, newGuildGold: g.gold });
    broadcastGuildUpdate(guildName);

    // Send bonuses to all online members
    g.members.forEach(m => {
      if (players[m.id]) {
        io.to(m.id).emit('guildBonusUpdate', { bonuses });
        if (m.id !== socket.id) {
          io.to(m.id).emit('guildChatMessage', { system: true, message: `🏆 ${buyerName} upgraded ${upg.name} to level ${currentLevel + 1}!` });
        }
      }
    });

    console.log(`[GUILD] ${buyerName} bought ${upg.name} Lv${currentLevel+1} in ${guildName} for ${cost}g`);
  });

  // GET GUILD LIST
  socket.on('getGuildList', () => {
    socket.emit('guildListUpdate', getGuildList());
  });

  // GET GUILD UPGRADES INFO
  socket.on('getGuildUpgradesInfo', () => {
    socket.emit('guildUpgradesInfo', GUILD_UPGRADES);
  });

  // GUILD CHAT
  socket.on('guildChatMessage', (data) => {
    const guildName = playerGuild[socket.id];
    if (!guildName || !guilds[guildName]) return;
    const player = players[socket.id];
    if (!player || !player.fighter) return;
    const msg = String(data.message || '').trim().slice(0, 200);
    if (!msg) return;
    const g = guilds[guildName];
    const sender = player.fighter.name;
    const member = g.members.find(m => m.id === socket.id);
    const role = member ? member.role : 'member';
    g.members.forEach(m => {
      if (players[m.id]) {
        io.to(m.id).emit('guildChatMessage', { name: sender, class: player.fighter.class, role, message: msg });
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
    pvpQueue = pvpQueue.filter(id => id !== socket.id);

    if (player && player.battleId) {
      const battle = activeBattles[player.battleId];
      if (battle && !battle.finished) {
        const winnerId = battle.player1.id === socket.id ? battle.player2.id : battle.player1.id;
        battle.log.push({ turn: battle.turns + 1, type: 'disconnect', message: `${player.fighter ? player.fighter.name : 'Player'} disconnected!` });
        endBattle(battle, winnerId, socket.id, 'disconnect');
      }
    }

    // Update guild member status (keep membership, just mark offline)
    const guildName = playerGuild[socket.id];
    if (guildName && guilds[guildName]) {
      // Don't remove - just socket.id will be stale until they reconnect
      // We clean invites
      guilds[guildName].invites = guilds[guildName].invites.filter(id => id !== socket.id);
    }
    // Note: keep playerGuild entry so name-based re-registration can restore it

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
  p1.fighter.currentHP = p1.fighter.maxHP;
  p2.fighter.currentHP = p2.fighter.maxHP;

  const battle = {
    id: battleId,
    player1: { id: p1.id, fighter: { ...p1.fighter } },
    player2: { id: p2.id, fighter: { ...p2.fighter } },
    currentTurn: p1.id, turns: 0, log: [], finished: false, startTime: Date.now()
  };
  activeBattles[battleId] = battle;
  p1.battleId = battleId;
  p2.battleId = battleId;

  const baseData = { battleId, currentTurn: p1.id, currentTurnName: p1.fighter.name };
  io.to(p1.id).emit('battleStart', { ...baseData,
    you: { id: p1.id, name: p1.fighter.name, class: p1.fighter.class, level: p1.fighter.level, currentHP: p1.fighter.currentHP, maxHP: p1.fighter.maxHP, stats: p1.fighter.stats },
    opponent: { id: p2.id, name: p2.fighter.name, class: p2.fighter.class, level: p2.fighter.level, currentHP: p2.fighter.currentHP, maxHP: p2.fighter.maxHP, stats: p2.fighter.stats }
  });
  io.to(p2.id).emit('battleStart', { ...baseData,
    you: { id: p2.id, name: p2.fighter.name, class: p2.fighter.class, level: p2.fighter.level, currentHP: p2.fighter.currentHP, maxHP: p2.fighter.maxHP, stats: p2.fighter.stats },
    opponent: { id: p1.id, name: p1.fighter.name, class: p1.fighter.class, level: p1.fighter.level, currentHP: p1.fighter.currentHP, maxHP: p1.fighter.maxHP, stats: p1.fighter.stats }
  });
  broadcastPlayerList();
  console.log(`[BATTLE] ${p1.fighter.name} vs ${p2.fighter.name} — ${battleId}`);
}

function endBattle(battle, winnerId, loserId, reason) {
  if (battle.finished) return;
  battle.finished = true;
  const winner = players[winnerId], loser = players[loserId];
  const winnerRating = winner?.fighter?.arena?.rating || 1000;
  const loserRating = loser?.fighter?.arena?.rating || 1000;
  const elo = calcElo(winnerRating, loserRating);
  const goldReward = Math.round(20 + (loser?.fighter?.level || 1) * 10 + Math.abs(elo.winnerChange) * 3);
  const xpReward = Math.round(25 + (loser?.fighter?.level || 1) * 8 + Math.abs(elo.winnerChange) * 2);

  if (winner?.fighter) { winner.fighter.arena.rating = Math.max(0, winner.fighter.arena.rating + elo.winnerChange); winner.fighter.arena.wins++; winner.battleId = null; }
  if (loser?.fighter) { loser.fighter.arena.rating = Math.max(0, loser.fighter.arena.rating + elo.loserChange); loser.fighter.arena.losses++; loser.battleId = null; }

  const resultData = {
    battleId: battle.id, winnerId, loserId,
    winnerName: winner?.fighter?.name || 'Unknown', loserName: loser?.fighter?.name || 'Unknown',
    reason, turns: battle.turns,
    winnerRatingChange: elo.winnerChange, loserRatingChange: elo.loserChange,
    winnerNewRating: winner?.fighter?.arena?.rating || 1000, loserNewRating: loser?.fighter?.arena?.rating || 1000,
    goldReward, xpReward, log: battle.log
  };

  if (winner) io.to(winnerId).emit('battleEnd', { ...resultData, youWon: true });
  if (loser) io.to(loserId).emit('battleEnd', { ...resultData, youWon: false });
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
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║  REALM OF SHADOWS PvP+Guild SERVER   ║');
  console.log(`║  Port: ${PORT}                            ║`);
  console.log(`║  http://localhost:${PORT}               ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
});