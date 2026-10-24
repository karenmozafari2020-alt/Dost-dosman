/**
 * Dost in Prehistoric Karen — Dedicated Low-Latency Online PvP Server
 * Karen Studios | Godot 4 WebSocket Real-Time Server + Anti-Cheat + Persistent DB
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = '0.0.0.0';
const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'db.json');
const APK_PATH = '/home/user/Dost_in_Prehistoric_Karen.apk';

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Persistent Database (Accounts & Leaderboard) with crash-safe atomic writes
let db = {
  accounts: {
    "legend_karen": {
      id: "legend_karen",
      tok_hash: "system",
      name: "Karen_Prime",
      kills: 340,
      deaths: 95,
      wins: 18,
      max_level: 300,
      rating: 1520,
      updated_at: Date.now()
    },
    "prehistoric_rex": {
      id: "prehistoric_rex",
      tok_hash: "system",
      name: "PrehistoricRex",
      kills: 210,
      deaths: 112,
      wins: 9,
      max_level: 245,
      rating: 1290,
      updated_at: Date.now()
    },
    "dost_warrior": {
      id: "dost_warrior",
      tok_hash: "system",
      name: "Dost_Vanguard",
      kills: 145,
      deaths: 88,
      wins: 5,
      max_level: 178,
      rating: 1165,
      updated_at: Date.now()
    }
  }
};

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.accounts === 'object') {
        db = parsed;
      }
    } else {
      saveDatabase();
    }
  } catch (err) {
    console.error('[DB] Failed to load db.json, using in-memory defaults:', err.message);
  }
}

let savePending = false;
function saveDatabase() {
  if (savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    try {
      const tmpFile = DB_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), 'utf8');
      fs.renameSync(tmpFile, DB_FILE);
    } catch (err) {
      console.error('[DB] Atomic write error:', err.message);
    }
  }, 200);
}

loadDatabase();

function hashToken(tok) {
  return crypto.createHash('sha256').update(String(tok || '')).digest('hex');
}

function getWeaponStatsForLevel(lv) {
  const level = Math.max(1, Math.min(300, Number.parseInt(lv || 1, 10) || 1));
  if (level === 300) {
    return { damage: 42, maxRange: 145, minCooldownMs: 160, isMelee: false };
  }
  if (level <= 10) {
    return { damage: 56, maxRange: 5.8, minCooldownMs: 380, isMelee: true };
  }
  if (level <= 30) {
    return { damage: 44, maxRange: 65, minCooldownMs: 280, isMelee: false };
  }
  if (level <= 75) {
    return { damage: 42, maxRange: 90, minCooldownMs: 220, isMelee: false };
  }
  if (level <= 150) {
    return { damage: 32, maxRange: 125, minCooldownMs: 110, isMelee: false };
  }
  return { damage: 36, maxRange: 140, minCooldownMs: 120, isMelee: false };
}

const VALID_MODES = new Set(['gun_progression', 'ffa', 'tdm', 'private']);

function normalizeMode(value) {
  const mode = String(value || 'gun_progression').trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : 'gun_progression';
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function finiteVector(value, minLength = 3) {
  if (!Array.isArray(value) || value.length < minLength) return null;
  const out = value.slice(0, minLength).map(Number);
  return out.every(Number.isFinite) ? out : null;
}

function getLeaderboard(limit = 20) {
  return Object.values(db.accounts)
    .map((acc) => ({
      name: acc.name,
      kills: acc.kills || 0,
      deaths: acc.deaths || 0,
      wins: acc.wins || 0,
      max_level: acc.max_level || 1,
      rating: acc.rating || 1000
    }))
    .sort((a, b) => b.rating - a.rating || b.kills - a.kills)
    .slice(0, limit);
}

// Active Rooms & Connected Clients
const clients = new Map(); // clientId -> ClientSession
const rooms = new Map();   // roomCode -> RoomState

function createRoom({ isPrivate = false, mode = 'gun_progression', mapId = 0, levelStep = 1, demoteRule = 1 }) {
  let code = '';
  do {
    code = 'KRN' + Math.floor(100 + Math.random() * 900);
  } while (rooms.has(code));

  const room = {
    code,
    isPrivate: Boolean(isPrivate),
    mode: normalizeMode(mode),
    map_id: boundedInt(mapId, 0, 0, 2),
    level_step: boundedInt(levelStep, 1, 1, 50),
    demote_rule: boundedInt(demoteRule, 1, 0, 2),
    team_red_score: 0,
    team_blue_score: 0,
    matchEnded: false,
    players: new Map(), // playerId -> PlayerRoomState
    createdAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

// Create a default public lobby room so the server always has an active arena ready
createRoom({ isPrivate: false, mode: 'gun_progression', mapId: 0, levelStep: 1, demoteRule: 1 });

function getPublicRoomsList() {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.isPrivate && !r.matchEnded) {
      list.push({
        code: r.code,
        mode: r.mode,
        map_id: r.map_id,
        player_count: r.players.size
      });
    }
  }
  return list;
}

function serializeRoom(room) {
  const playersObj = {};
  for (const [pid, p] of room.players.entries()) {
    playersObj[pid] = {
      id: p.id,
      name: p.name,
      level: p.level,
      kills: p.kills,
      deaths: p.deaths,
      team: p.team
    };
  }
  return {
    code: room.code,
    private: room.isPrivate,
    mode: room.mode,
    map_id: room.map_id,
    level_step: room.level_step,
    demote_rule: room.demote_rule,
    team_red_score: room.team_red_score,
    team_blue_score: room.team_blue_score,
    players: playersObj
  };
}

function broadcastToRoom(room, payloadObj, excludeId = null) {
  const raw = JSON.stringify(payloadObj);
  const frame = encodeWsTextFrame(raw);
  for (const [pid, pState] of room.players.entries()) {
    if (pid === excludeId) continue;
    if (pState.session && pState.session.isOpen) {
      pState.session.sendRawFrame(frame);
    }
  }
}

function removePlayerFromCurrentRoom(session) {
  if (!session.roomCode) return;
  const room = rooms.get(session.roomCode);
  session.roomCode = '';
  if (!room) return;

  room.players.delete(session.playerId);
  broadcastToRoom(room, { t: 'plr_left', id: session.playerId });

  if (room.players.size === 0 && rooms.size > 1) {
    rooms.delete(room.code);
  }
}

function joinPlayerToRoom(session, room) {
  if (room.matchEnded) {
    session.sendJson({ t: 'room_err', msg: 'این مسابقه پایان یافته است؛ یک مسابقهٔ تازه بسازید.' });
    return false;
  }
  if (!room.players.has(session.playerId) && room.players.size >= 12) {
    session.sendJson({ t: 'room_err', msg: 'این اتاق به ظرفیت ۱۲ بازیکن رسیده است.' });
    return false;
  }
  removePlayerFromCurrentRoom(session);

  // Fair Catch-Up System for players joining mid-match
  let sumLv = 0;
  let count = 0;
  let redCount = 0;
  let blueCount = 0;
  for (const p of room.players.values()) {
    sumLv += p.level;
    count += 1;
    if (p.team === 1) redCount += 1;
    if (p.team === 2) blueCount += 1;
  }
  const fairStartLevel = count > 0 ? Math.max(1, Math.min(250, Math.floor((sumLv / count) * 0.65))) : 1;
  const team = room.mode === 'tdm' ? (redCount <= blueCount ? 1 : 2) : 0;
  const now = Date.now();

  const pState = {
    id: session.playerId,
    name: session.username,
    level: fairStartLevel,
    hp: 100,
    kills: 0,
    deaths: 0,
    team,
    alive: true,
    respawnAt: 0,
    spawnShieldUntil: now + 2500,
    position: null,
    lastStateAt: 0,
    stateHistory: [],
    lastHitTimeMs: 0,
    lastSeq: -1,
    lastAttackSeq: 0,
    lastAttackAt: 0,
    lastHeavyAt: 0,
    attackRecords: new Map(),
    session
  };

  room.players.set(session.playerId, pState);
  session.roomCode = room.code;

  session.sendJson({
    t: 'room_joined',
    room: serializeRoom(room)
  });

  broadcastToRoom(room, {
    t: 'plr_joined',
    player: {
      id: pState.id,
      name: pState.name,
      level: pState.level,
      kills: pState.kills,
      deaths: pState.deaths,
      team: pState.team
    }
  }, session.playerId);
}

// ============================================================================
// RFC-6455 Ultra-Low-Latency WebSocket Framing
// ============================================================================

function encodeWsTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x81; // FIN + Text
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function handleClientMessage(session, msgStr) {
  let msg;
  try {
    msg = JSON.parse(msgStr);
  } catch (_) {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (!session.authenticated && msg.t !== 'auth' && msg.t !== 'ping') return;
  if (session.authenticated && msg.t === 'auth') return;

  switch (msg.t) {
    case 'ping': {
      session.sendJson({ t: 'pong', c: msg.c || 0 });
      break;
    }

    case 'auth': {
      const pid = String(msg.id || '').trim().slice(0, 48);
      const tok = String(msg.tok || '');
      const uname = String(msg.name || 'Hunter').trim().slice(0, 22) || 'Hunter';
      if (!/^[A-Za-z0-9_-]{6,48}$/.test(pid) || tok.length < 12 || tok.length > 256) {
        session.sendJson({ t: 'auth_err', msg: 'شناسه یا کلید حساب معتبر نیست. لطفاً بازی را به‌روزرسانی کنید.' });
        return;
      }
      const tokHash = hashToken(tok);
      let acc = db.accounts[pid];

      if (acc && acc.tok_hash !== tokHash) {
        session.sendJson({ t: 'auth_err', msg: 'کلید این حساب با این دستگاه مطابقت ندارد؛ برای امنیت ورود رد شد.' });
        return;
      }
      if (!acc) {
        acc = {
          id: pid,
          tok_hash: tokHash,
          name: uname,
          kills: 0,
          deaths: 0,
          wins: 0,
          max_level: 1,
          rating: 1000,
          updated_at: Date.now()
        };
        db.accounts[pid] = acc;
      } else {
        acc.name = uname;
        acc.updated_at = Date.now();
      }

      // Keep one authoritative socket per account to prevent duplicate room identities.
      for (const [otherId, other] of clients.entries()) {
        if (other !== session && other.authenticated && other.playerId === pid) {
          removePlayerFromCurrentRoom(other);
          other.isOpen = false;
          try { other.socket.destroy(); } catch (_) {}
          clients.delete(otherId);
        }
      }
      session.playerId = pid;
      session.username = uname;
      session.authenticated = true;
      saveDatabase();
      session.sendJson({
        t: 'auth_ok',
        profile: {
          id: acc.id,
          name: acc.name,
          kills: acc.kills,
          deaths: acc.deaths,
          wins: acc.wins,
          max_level: acc.max_level,
          rating: acc.rating
        },
        rooms: getPublicRoomsList(),
        leaderboard: getLeaderboard()
      });
      break;
    }

    case 'list_rooms': {
      session.sendJson({ t: 'rooms', rooms: getPublicRoomsList() });
      break;
    }

    case 'leaderboard': {
      session.sendJson({ t: 'leaderboard', leaderboard: getLeaderboard() });
      break;
    }

    case 'quick_match': {
      const mode = normalizeMode(msg.mode);
      const mapId = boundedInt(msg.map_id, 0, 0, 2);
      if (msg.name) session.username = String(msg.name).trim().slice(0, 22) || session.username;

      let targetRoom = null;
      for (const r of rooms.values()) {
        if (!r.isPrivate && !r.matchEnded && r.mode === mode && r.map_id === mapId && r.players.size < 12) {
          targetRoom = r;
          break;
        }
      }
      if (!targetRoom) {
        targetRoom = createRoom({ isPrivate: false, mode, mapId, levelStep: 1, demoteRule: 1 });
      }
      joinPlayerToRoom(session, targetRoom);
      break;
    }

    case 'create_room': {
      if (msg.name) session.username = String(msg.name).slice(0, 22);
      const room = createRoom({
        isPrivate: Boolean(msg.private),
        mode: msg.mode || 'gun_progression',
        mapId: msg.map_id || 0,
        levelStep: msg.level_step || 1,
        demoteRule: msg.demote_rule !== undefined ? msg.demote_rule : 1
      });
      joinPlayerToRoom(session, room);
      break;
    }

    case 'join_room': {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        session.sendJson({ t: 'room_err', msg: 'اتاق مورد نظر یافت نشد: ' + code });
        return;
      }
      joinPlayerToRoom(session, room);
      break;
    }

    case 'leave_room': {
      removePlayerFromCurrentRoom(session);
      break;
    }

    case 's': {
      // Validate and relay 20Hz movement. This also provides the server-side hit geometry.
      if (!session.roomCode) return;
      const room = rooms.get(session.roomCode);
      const player = room && room.players.get(session.playerId);
      if (!room || !player || room.matchEnded || !Array.isArray(msg.d) || msg.d.length < 8) return;
      const d = msg.d.slice(0, 8).map(Number);
      if (!d.every(Number.isFinite)) return;
      const [x, y, z, yaw, pitch, vx, vz, anim] = d;
      if (Math.abs(x) > 300 || Math.abs(z) > 300 || y < -15 || y > 100 || Math.abs(vx) > 30 || Math.abs(vz) > 30) return;
      const now = Date.now();

      if (!player.alive) {
        if (now < player.respawnAt) return;
        player.alive = true;
        player.hp = 100;
        player.spawnShieldUntil = now + 2800;
        player.respawnAt = 0;
        player.position = null;
        player.stateHistory = [];
      }

      if (player.position && player.lastStateAt > 0) {
        const dt = Math.max(0.02, (now - player.lastStateAt) / 1000);
        const dx = x - player.position.x;
        const dy = y - player.position.y;
        const dz = z - player.position.z;
        const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const maxMove = Math.max(3.0, Math.min(12.0, dt * 24.0 + 2.5));
        if (moved > maxMove) return;
      }

      const cleanState = [
        x, y, z,
        Math.atan2(Math.sin(yaw), Math.cos(yaw)),
        Math.max(-1.55, Math.min(1.55, pitch)),
        Math.max(-24, Math.min(24, vx)),
        Math.max(-24, Math.min(24, vz)),
        boundedInt(anim, 0, 0, 8)
      ];
      player.position = { x, y, z, yaw: cleanState[3], pitch: cleanState[4] };
      player.lastStateAt = now;
      player.stateHistory.push({ at: now, x, y, z });
      if (player.stateHistory.length > 80) player.stateHistory.shift();
      broadcastToRoom(room, { t: 's', id: session.playerId, d: cleanState }, session.playerId);
      break;
    }

    case 'atk': {
      // An accepted server-side attack record must exist before a hit can be credited.
      if (!session.roomCode) return;
      const room = rooms.get(session.roomCode);
      const attacker = room && room.players.get(session.playerId);
      if (!room || !attacker || room.matchEnded || !attacker.alive || !attacker.position) return;
      const now = Date.now();
      if (now - attacker.lastStateAt > 1200) return;
      const seq = boundedInt(msg.seq, 0, 1, 2147483647);
      if (seq <= attacker.lastAttackSeq) return;
      const origin = finiteVector(msg.o);
      const rawDir = finiteVector(msg.d);
      if (!origin || !rawDir) return;
      const dirLen = Math.hypot(rawDir[0], rawDir[1], rawDir[2]);
      if (dirLen < 0.8 || dirLen > 1.2) return;
      const originOffset = Math.hypot(
        origin[0] - attacker.position.x,
        origin[1] - (attacker.position.y + 1.5),
        origin[2] - attacker.position.z
      );
      if (originOffset > 2.8) return;

      const heavy = Boolean(msg.heavy);
      const stats = getWeaponStatsForLevel(attacker.level);
      if (now - attacker.lastAttackAt < stats.minCooldownMs * 0.55) return;
      if (heavy && now - attacker.lastHeavyAt < 800) return;
      attacker.lastAttackSeq = seq;
      attacker.lastAttackAt = now;
      if (heavy) attacker.lastHeavyAt = now;
      const dir = rawDir.map((v) => v / dirLen);
      attacker.attackRecords.set(seq, {
        seq,
        level: attacker.level,
        stats,
        origin,
        dir,
        position: { ...attacker.position },
        createdAt: now,
        heavy,
        used: false
      });
      for (const [attackId, record] of attacker.attackRecords.entries()) {
        if (now - record.createdAt > 3500) attacker.attackRecords.delete(attackId);
      }
      while (attacker.attackRecords.size > 32) {
        attacker.attackRecords.delete(attacker.attackRecords.keys().next().value);
      }
      broadcastToRoom(room, {
        t: 'atk',
        id: session.playerId,
        seq,
        w: attacker.level,
        heavy,
        o: origin,
        d: dir
      }, session.playerId);
      break;
    }

    case 'hit': {
      // Candidate hits are verified against the authenticated attacker, live room
      // membership, accepted attack sequence, replicated positions, range and aim.
      if (!session.roomCode) return;
      const room = rooms.get(session.roomCode);
      const attacker = room && room.players.get(session.playerId);
      if (!room || !attacker || room.matchEnded || !attacker.alive) return;

      const now = Date.now();
      const hitSeq = boundedInt(msg.seq, 0, 1, 2147483647);
      if (hitSeq <= attacker.lastSeq) return;
      attacker.lastSeq = hitSeq;
      const attackSeq = boundedInt(msg.atk_seq, 0, 0, 2147483647);
      const attack = attacker.attackRecords.get(attackSeq);
      if (!attack || attack.used || now - attack.createdAt > 3500) return;

      const victimId = String(msg.vic_id || '').slice(0, 48);
      const victim = room.players.get(victimId);
      if (!victim || victim === attacker || !victim.alive || !victim.position) return;
      if (now - attacker.lastStateAt > 1200 || now - victim.lastStateAt > 1200) return;
      if (now < victim.spawnShieldUntil) return;
      if (room.mode === 'tdm' && attacker.team !== 0 && attacker.team === victim.team) return;
      if (now - attacker.lastHitTimeMs < attack.stats.minCooldownMs * 0.45) return;

      const target = [victim.position.x, victim.position.y + 1.0, victim.position.z];
      const toTarget = [target[0] - attack.origin[0], target[1] - attack.origin[1], target[2] - attack.origin[2]];
      const distance = Math.hypot(toTarget[0], toTarget[1], toTarget[2]);
      const melee = attack.stats.isMelee || attack.heavy;
      const rangeAllowance = melee ? 1.7 : 6.5;
      const maxRange = attack.heavy ? 4.8 : attack.stats.maxRange;
      if (distance > maxRange + rangeAllowance || distance < 0.35) return;
      const aimDot = (toTarget[0] * attack.dir[0] + toTarget[1] * attack.dir[1] + toTarget[2] * attack.dir[2]) / distance;
      const minAimDot = melee ? 0.16 : (attack.level === 300 ? 0.60 : 0.48);
      if (aimDot < minAimDot) return;

      attack.used = true;
      attacker.lastHitTimeMs = now;
      const damage = attack.heavy
        ? Math.max(attack.stats.damage, Math.min(85, attack.stats.damage * 1.35))
        : attack.stats.damage;
      victim.hp = Math.max(0, victim.hp - damage);
      broadcastToRoom(room, {
        t: 'dmg_ev',
        vic_id: victim.id,
        att_id: attacker.id,
        hp: victim.hp,
        dmg: damage
      });

      if (victim.hp > 0) break;

      // A kill and all progression/profile changes are committed only here.
      victim.hp = 100;
      victim.alive = false;
      victim.respawnAt = now + 2600;
      victim.deaths += 1;
      attacker.kills += 1;
      const previousLevel = attacker.level;
      const usedKarLaser = attack.level === 300 && !attack.heavy;
      attacker.level = Math.min(300, attacker.level + room.level_step);
      const karenUnlocked = previousLevel < 300 && attacker.level === 300;
      const isMeleeKill = attack.stats.isMelee || attack.heavy;
      if (room.demote_rule === 2 || (room.demote_rule === 1 && isMeleeKill)) {
        victim.level = Math.max(1, victim.level - 1);
      }

      const attackerAccount = db.accounts[attacker.id];
      const victimAccount = db.accounts[victim.id];
      if (attackerAccount) {
        attackerAccount.kills = (attackerAccount.kills || 0) + 1;
        attackerAccount.max_level = Math.max(attackerAccount.max_level || 1, attacker.level);
        attackerAccount.updated_at = now;
      }
      if (victimAccount) {
        victimAccount.deaths = (victimAccount.deaths || 0) + 1;
        victimAccount.updated_at = now;
      }

      if (room.mode === 'tdm') {
        if (attacker.team === 1) room.team_red_score += 1;
        else if (attacker.team === 2) room.team_blue_score += 1;
      }

      broadcastToRoom(room, {
        t: 'kill_ev',
        killer_id: attacker.id,
        killer_name: attacker.name,
        killer_level: attacker.level,
        killer_kills: attacker.kills,
        used_weapon_level: attack.level,
        used_karen: usedKarLaser,
        karen_unlocked: karenUnlocked,
        victim_id: victim.id,
        victim_name: victim.name,
        victim_level: victim.level,
        victim_deaths: victim.deaths,
        team_red_score: room.team_red_score,
        team_blue_score: room.team_blue_score
      });

      let winnerName = '';
      let winnerId = '';
      let endReason = '';
      if (room.mode === 'tdm' && room.team_red_score >= 50) {
        winnerName = 'تیم سرخ (Red Team)';
        endReason = 'رسیدن به امتیاز هدف (۵۰ کیل تیمی)';
        winnerId = [...room.players.values()].filter((p) => p.team === 1).sort((a, b) => b.kills - a.kills)[0]?.id || '';
      } else if (room.mode === 'tdm' && room.team_blue_score >= 50) {
        winnerName = 'تیم آبی (Blue Team)';
        endReason = 'رسیدن به امتیاز هدف (۵۰ کیل تیمی)';
        winnerId = [...room.players.values()].filter((p) => p.team === 2).sort((a, b) => b.kills - a.kills)[0]?.id || '';
      } else if (usedKarLaser && ['gun_progression', 'ffa', 'private'].includes(room.mode)) {
        winnerName = attacker.name;
        winnerId = attacker.id;
        endReason = 'پیروزی نهایی با تفنگ لیزری افسانه‌ای KAREN در لول ۳۰۰!';
      }

      if (winnerName && !room.matchEnded) {
        room.matchEnded = true;
        const winnerAccount = db.accounts[winnerId];
        if (winnerAccount) {
          winnerAccount.wins = (winnerAccount.wins || 0) + 1;
          winnerAccount.rating = (winnerAccount.rating || 1000) + 25;
          winnerAccount.updated_at = now;
        }
        saveDatabase();
        broadcastToRoom(room, { t: 'match_end', winner: winnerName, reason: endReason });
      } else {
        saveDatabase();
      }
      broadcastToRoom(room, { t: 'leaderboard', leaderboard: getLeaderboard() });
      break;
    }
  }
}

// ============================================================================
// HTTP Server & Live Dashboard + Direct APK Download Portal
// ============================================================================

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/api/status') {
    const apkExists = fs.existsSync(APK_PATH);
    const apkSizeMb = apkExists ? (fs.statSync(APK_PATH).size / (1024 * 1024)).toFixed(1) : 0;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      game: 'Dost in Prehistoric Karen',
      studio: 'Karen Studios',
      online_players: clients.size,
      active_rooms: getPublicRoomsList(),
      leaderboard: getLeaderboard(10),
      apk_ready: apkExists,
      apk_size_mb: apkSizeMb
    }));
    return;
  }

  if (urlPath === '/download/Dost_in_Prehistoric_Karen.apk' || urlPath === '/Dost_in_Prehistoric_Karen.apk') {
    if (!fs.existsSync(APK_PATH)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('APK file is currently building, please refresh in a few seconds.');
      return;
    }
    const stat = fs.statSync(APK_PATH);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': stat.size,
      'Content-Disposition': 'attachment; filename="Dost_in_Prehistoric_Karen.apk"'
    });
    fs.createReadStream(APK_PATH).pipe(res);
    return;
  }

  // Serve Persian Server Status & Direct APK Download Portal
  const apkExists = fs.existsSync(APK_PATH);
  const apkSizeMb = apkExists ? (fs.statSync(APK_PATH).size / (1024 * 1024)).toFixed(1) : '0';
  const lbRows = getLeaderboard(10)
    .map((e, i) => `<tr><td>#${i + 1}</td><td>${e.name}</td><td>${e.rating}</td><td>${e.kills}</td><td>${e.wins}</td><td>Lv.${e.max_level} / 300</td></tr>`)
    .join('');

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dost in Prehistoric Karen | سرور آنلاین و دانلود مستقیم APK</title>
  <style>
    * { box-sizing: border-box; font-family: Tahoma, system-ui, sans-serif; }
    body { margin: 0; background: #090d18; color: #eef6ff; padding: 24px; }
    .container { max-width: 920px; margin: 0 auto; }
    .hero {
      background: linear-gradient(135deg, #101b35, #1e1035);
      border: 2px solid #00f5e5;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 12px 32px rgba(0, 245, 229, 0.15);
      margin-bottom: 20px;
    }
    h1 { margin: 0 0 8px 0; color: #ffdf38; font-size: 26px; }
    .sub { color: #00f5e5; font-size: 15px; margin-bottom: 18px; }
    .btn-apk {
      display: inline-block;
      background: linear-gradient(90deg, #00f5d4, #00bbf9);
      color: #06101e;
      font-weight: bold;
      font-size: 18px;
      padding: 14px 28px;
      border-radius: 10px;
      text-decoration: none;
      margin-top: 8px;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 20px; }
    .card { background: #11182b; border: 1px solid #283a63; border-radius: 12px; padding: 16px; }
    .card h3 { margin-top: 0; color: #ffdf38; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { padding: 10px; border-bottom: 1px solid #223052; text-align: right; }
    th { color: #00f5e5; }
    code { background: #060913; color: #00f5e5; padding: 4px 8px; border-radius: 6px; direction: ltr; display: inline-block; }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <h1>🎮 Dost in Prehistoric Karen — Karen Studios</h1>
      <div class="sub">سرور اختصاصی بلادرنگ (TCP_NODELAY WebSocket) + دانلود مستقیم فایل نصبی اندروید (APK)</div>
      <p>وضعیت سرور آنلاین: <strong style="color:#38ff7a;">🟢 فعال و آماده اتصال (۲۰ هرتز، پینگ فوق‌پایین)</strong></p>
      <p>پروتکل اتصال داخل بازی: <code id="ws-url">wss://8080-${process.env.E2B_SANDBOX_ID || 'localhost'}.e2b.app</code></p>
      ${apkExists
        ? `<a class="btn-apk" href="/download/Dost_in_Prehistoric_Karen.apk">📲 دانلود مستقیم فایل Dost_in_Prehistoric_Karen.apk (${apkSizeMb} MB)</a>`
        : `<p style="color:#ffaa38;">در حال آماده‌سازی فایل APK...</p>`}
    </div>

    <div class="grid">
      <div class="card">
        <h3>⚡ مسیر تکامل ۳۰۰ سلاح</h3>
        <ul>
          <li><strong>لول ۱–۱۰ (عصر چوب):</strong> شروع با چوب بیسبال ماقبل تاریخ، چماق و گرز</li>
          <li><strong>لول ۱۱–۳۰ (عصر سنگ):</strong> نیزه چخماق، تبر ابسیدین و فلاخن</li>
          <li><strong>لول ۳۱–۷۵ (عصر جنگجویان):</strong> شمشیر، کمان، زوبین و چاکرام</li>
          <li><strong>لول ۷۶–۱۵۰ (عصر فناوری):</strong> تپانچه، شاتگان، اسنایپر و مینی‌گان</li>
          <li><strong>لول ۱۵۱–۲۹۹ (عصر انرژی):</strong> تفنگ پلاسما، توپ تسلا و پادماده</li>
          <li><strong>لول ۳۰۰ (عصر افسانه‌ای Karen):</strong> تفنگ لیزری افسانه‌ای Karen ⚡</li>
        </ul>
      </div>
      <div class="card">
        <h3>🗺️ نقشه‌ها و حالت‌های بازی</h3>
        <ul>
          <li><strong>Prehistoric Jungle:</strong> جنگل باستانی، رودخانه و غارها</li>
          <li><strong>Ancient Arena:</strong> میدان باستانی، برجک‌ها و مسیرهای مخفی</li>
          <li><strong>Cyber Ruins:</strong> خرابه‌های ماقبل تاریخ و راکتورهای نئونی Karen</li>
          <li><strong>حالت‌ها:</strong> Gun Progression، Free For All، Team Deathmatch، Private Match و Practice vs AI + همراه هوشمند Dost</li>
        </ul>
      </div>
    </div>

    <div class="card">
      <h3>🏆 جدول رتبه‌بندی زنده سرور (Leaderboard)</h3>
      <table>
        <thead>
          <tr><th>رتبه</th><th>نام جنگجو</th><th>امتیاز</th><th>کیل</th><th>برد</th><th>بالاترین لول سلاح</th></tr>
        </thead>
        <tbody>${lbRows}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  // Disable Nagle's algorithm immediately for lowest possible ping!
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15000);

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );

  const sessionId = 'sess_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  const session = {
    sessionId,
    playerId: sessionId,
    username: 'Hunter',
    roomCode: '',
    isOpen: true,
    socket,
    buffer: Buffer.alloc(0),
    sendRawFrame(frameBuf) {
      if (this.isOpen && !this.socket.destroyed) {
        try {
          this.socket.write(frameBuf);
        } catch (_) {}
      }
    },
    sendJson(obj) {
      this.sendRawFrame(encodeWsTextFrame(JSON.stringify(obj)));
    }
  };

  clients.set(sessionId, session);

  socket.on('data', (chunk) => {
    session.buffer = Buffer.concat([session.buffer, chunk]);

    while (session.buffer.length >= 2) {
      const byte0 = session.buffer[0];
      const byte1 = session.buffer[1];
      const opcode = byte0 & 0x0f;
      const isMasked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (session.buffer.length < 4) return;
        payloadLen = session.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (session.buffer.length < 10) return;
        payloadLen = Number(session.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      if (session.buffer.length < offset + maskLen + payloadLen) {
        return; // Wait for rest of frame
      }

      let maskKey = null;
      if (isMasked) {
        maskKey = session.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(session.buffer.subarray(offset, offset + payloadLen));
      session.buffer = session.buffer.subarray(offset + payloadLen);

      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x08) {
        // Close frame
        session.isOpen = false;
        socket.end();
        return;
      } else if (opcode === 0x09) {
        // Ping frame -> Pong frame
        const pong = Buffer.allocUnsafe(2 + payload.length);
        pong[0] = 0x8a;
        pong[1] = payload.length;
        payload.copy(pong, 2);
        session.sendRawFrame(pong);
      } else if (opcode === 0x01 || opcode === 0x02) {
        handleClientMessage(session, payload.toString('utf8'));
      }
    }
  });

  const cleanup = () => {
    session.isOpen = false;
    removePlayerFromCurrentRoom(session);
    clients.delete(sessionId);
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

server.listen(PORT, HOST, () => {
  console.log(`[KAREN SERVER] Dost in Prehistoric Karen Online Server listening on http://${HOST}:${PORT}`);
});
