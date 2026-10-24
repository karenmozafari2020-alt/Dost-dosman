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
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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

// Only connected, authenticated human accounts; no seeded or offline records.
function getOnlineLeaderboard() {
  const entries = new Map();
  for (const session of clients.values()) {
    if (!session.isOpen || !session.authenticated) continue;
    const account = db.accounts[session.playerId] || {};
    const room = rooms.get(session.roomCode);
    const player = room && room.players.get(session.playerId);
    entries.set(session.playerId, {
      name: session.username, rating: account.rating || 1000,
      kills: account.kills || 0, deaths: account.deaths || 0,
      wins: account.wins || 0, max_level: account.max_level || 1,
      match_kills: player ? player.kills : 0,
      level: player ? player.level : 1,
      status: player ? 'در مسابقه' : 'در منو'
    });
  }
  return [...entries.values()].sort((a,b) => b.rating-a.rating || b.kills-a.kills || a.name.localeCompare(b.name));
}

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
    host_id: "",
    bot_count: 0,
    ai_difficulty: 1,
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
      team: p.team,
      is_bot: Boolean(p.isBot), hp: p.hp, max_hp: p.maxHp || 100,
      alive: p.alive, position: p.position
    };
  }
  return {
    code: room.code,
    private: room.isPrivate,
    host_id: room.host_id, bot_count: room.bot_count, ai_difficulty: room.ai_difficulty,
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
  if (room.host_id === session.playerId) {
    room.host_id = [...room.players.values()].find(p => !p.isBot)?.id || '';
    broadcastToRoom(room, {t:'room_settings', host_id:room.host_id, bot_count:room.bot_count, ai_difficulty:room.ai_difficulty});
  }
  if (![...room.players.values()].some(p => !p.isBot)) {
    for (const [id,p] of room.players) if(p.isBot) room.players.delete(id);
    room.bot_count = 0;
  }
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
  if (!room.host_id) room.host_id = session.playerId;
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


// Authoritative online bots: a single 10Hz simulation per room, never per phone.
const MAP_BOXES = require('./maps.json');
const BOT_TUNING = [
  {hp:72,speed:3.9,think:1000,cooldown:2.1,accuracy:0.38,damage:0.65},
  {hp:100,speed:5.4,think:550,cooldown:1.4,accuracy:0.62,damage:0.85},
  {hp:120,speed:6.8,think:280,cooldown:1.0,accuracy:0.80,damage:1.0},
  {hp:145,speed:7.8,think:140,cooldown:0.8,accuracy:0.94,damage:1.0}
];
function botInfo(p) {
 return {id:p.id,name:p.name,level:p.level,kills:p.kills,deaths:p.deaths,team:p.team,
 is_bot:true,hp:p.hp,max_hp:p.maxHp,alive:p.alive,position:p.position};
}
function clearShot(map, a, b) {
 for(const box of MAP_BOXES[map] || []) {
   let lo=0,hi=1;
   for(let axis=0;axis<3;axis++) {
     const d=b[axis]-a[axis];
     if(Math.abs(d)<0.00001) {if(a[axis]<box[axis] || a[axis]>box[axis+3]) {lo=2;break;}}
     else {const t1=(box[axis]-a[axis])/d,t2=(box[axis+3]-a[axis])/d;
       lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2));}
   }
   if(lo<=hi && hi>0.01 && lo<0.99) return false;
 }
 return true;
}
function walkable(map,x,z) {
 if(Math.abs(x)>45 || Math.abs(z)>45) return false;
 return !(MAP_BOXES[map] || []).some(b => b[4]>0.18 && b[1]<1.85 &&
  x>b[0]-0.65 && x<b[3]+0.65 && z>b[2]-0.65 && z<b[5]+0.65);
}
function botSpawn(room,seed) {
 let best=null,score=-1;
 for(let i=0;i<40;i++) {
  const angle=(i+seed)*2.39996, x=Math.round(Math.cos(angle)*40),z=Math.round(Math.sin(angle)*40);
  if(!walkable(room.map_id,x,z)) continue;
  const enemies=[...room.players.values()].filter(p=>p.alive && p.position);
  const distance=enemies.length?Math.min(...enemies.map(p=>Math.hypot(x-p.position.x,z-p.position.z))):50;
  if(distance>score){score=distance;best={x,y:0,z,yaw:0,pitch:0};}
 }
 return best || {x:40,y:0,z:0,yaw:0,pitch:0};
}
// Breadth-first grid routing avoids the same map cover on all clients.
function route(room,from,to) {
 const cell=p=>[Math.max(-22,Math.min(22,Math.round(p.x/2))),Math.max(-22,Math.min(22,Math.round(p.z/2)))];
 const start=cell(from),goal=cell(to),key=(x,z)=>x+','+z;
 const queue=[start],parents=new Map([[key(...start),null]]);
 let end=start,best=Infinity;
 for(let i=0;i<queue.length && i<2100;i++) {
  const [x,z]=queue[i],d=(x-goal[0])**2+(z-goal[1])**2;
  if(d<best){best=d;end=[x,z];} if(d===0)break;
  for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
   const nx=x+dx,nz=z+dz,k=key(nx,nz);
   if(parents.has(k)||!walkable(room.map_id,nx*2,nz*2))continue;
   parents.set(k,[x,z]);queue.push([nx,nz]);
  }
 }
 const path=[];let n=end;
 while(n && key(...n)!==key(...start)){path.push({x:n[0]*2,z:n[1]*2});n=parents.get(key(...n));}
 return path.reverse();
}
function configureBots(room,count,difficulty) {
 const humans=[...room.players.values()].filter(p=>!p.isBot).length;
 room.bot_count=boundedInt(count,0,0,Math.min(8,12-humans));
 room.ai_difficulty=boundedInt(difficulty,1,0,3);
 // Reconfigure atomically; announce removals then one canonical snapshot for each bot.
 for(const [id,p] of room.players)if(p.isBot){room.players.delete(id);broadcastToRoom(room,{t:'plr_left',id});}
 for(let i=0;i<room.bot_count;i++) {
  const id='srvbot_'+room.code+'_'+i, now=Date.now(),tune=BOT_TUNING[room.ai_difficulty];
  const session={playerId:id,roomCode:room.code,authenticated:true,isOpen:false,sendJson(){}};
  const p={id,name:'AI '+(i+1),isBot:true,level:1,hp:tune.hp,maxHp:tune.hp,kills:0,deaths:0,
    team:room.mode==='tdm'?(i%2)+1:0,alive:true,respawnAt:0,spawnShieldUntil:now+2500,
    position:botSpawn(room,i),lastStateAt:now,stateHistory:[],lastHitTimeMs:0,lastSeq:-1,
    lastAttackSeq:0,lastAttackAt:0,lastHeavyAt:0,attackRecords:new Map(),session,
    rethinkAt:0,fireAt:now+2500,path:[],targetId:'',botSeq:0};
  room.players.set(id,p);broadcastToRoom(room,{t:'plr_joined',player:botInfo(p)});
 }
 broadcastToRoom(room,{t:'room_settings',host_id:room.host_id,bot_count:room.bot_count,ai_difficulty:room.ai_difficulty});
}
function tickBots(now=Date.now()) {
 for(const room of rooms.values()) {
  if(room.matchEnded || ![...room.players.values()].some(p=>!p.isBot))continue;
  const tune=BOT_TUNING[room.ai_difficulty];
  for(const p of room.players.values()) {
   if(!p.isBot)continue;
   if(!p.alive){
    if(now<p.respawnAt)continue;
    p.alive=true;p.hp=p.maxHp;p.position=botSpawn(room,p.deaths);p.spawnShieldUntil=now+2800;
    p.path=[];p.rethinkAt=0;
    broadcastToRoom(room,{t:'bot_respawn',player:botInfo(p)});
   }
   p.lastStateAt=now;
   if(now>=p.rethinkAt){
    p.rethinkAt=now+tune.think;
    const enemies=[...room.players.values()].filter(v=>v!==p&&v.alive&&v.position&&
      (!p.team||v.team!==p.team)&&now-v.lastStateAt<1500);
    enemies.sort((a,b)=>Math.hypot(a.position.x-p.position.x,a.position.z-p.position.z)-Math.hypot(b.position.x-p.position.x,b.position.z-p.position.z));
    p.targetId=enemies[0]?.id||'';
    const target=room.players.get(p.targetId);
    p.path=target?route(room,p.position,target.position):[];
   }
   const target=room.players.get(p.targetId);
   let vx=0,vz=0;
   if(target && target.alive) {
    const dx=target.position.x-p.position.x,dz=target.position.z-p.position.z,dist=Math.hypot(dx,dz);
    p.position.yaw=Math.atan2(-dx,-dz);
    const stats=getWeaponStatsForLevel(p.level);
    const origin=[p.position.x,p.position.y+1.5,p.position.z];
    const targetPoint=[target.position.x,target.position.y+1,target.position.z];
    const visible=clearShot(room.map_id,origin,targetPoint);
    const stop=stats.isMelee?2.6:Math.min(18,stats.maxRange*0.6);
    if(dist>stop||!visible){
      while(p.path.length && Math.hypot(p.path[0].x-p.position.x,p.path[0].z-p.position.z)<0.45)p.path.shift();
      const dest=p.path[0];
      if(dest){const x=dest.x-p.position.x,z=dest.z-p.position.z,d=Math.hypot(x,z),step=Math.min(d,tune.speed*0.1);
       if(d>0.01){vx=x/d*step*10;vz=z/d*step*10;
        if(walkable(room.map_id,p.position.x+vx*0.1,p.position.z+vz*0.1)){p.position.x+=vx*0.1;p.position.z+=vz*0.1;}else{vx=0;vz=0;}}
      }
    }
    if(visible && dist<stats.maxRange && now>=p.fireAt && now>p.spawnShieldUntil){
      p.fireAt=now+stats.minCooldownMs*tune.cooldown+150;
      const seq=++p.botSeq;
      const o=[p.position.x,p.position.y+1.5,p.position.z];
      const vector=targetPoint.map((v,i)=>v-o[i]),len=Math.hypot(...vector),dir=vector.map(v=>v/len);
      const actualStats={...stats,damage:stats.damage*tune.damage};
      p.attackRecords.set(seq,{seq,level:p.level,stats:actualStats,origin:o,dir,createdAt:now,heavy:false,used:false});
      while(p.attackRecords.size>10)p.attackRecords.delete(p.attackRecords.keys().next().value);
      broadcastToRoom(room,{t:'atk',id:p.id,w:p.level,o, d:dir});
      if(Math.random()<tune.accuracy)handleClientMessage(p.session,JSON.stringify({t:'hit',seq,atk_seq:seq,vic_id:target.id}));
    }
   }
   broadcastToRoom(room,{t:'s',id:p.id,d:[p.position.x,p.position.y,p.position.z,p.position.yaw,0,vx,vz,Math.abs(vx)+Math.abs(vz)>0.1?1:0]});
  }
 }
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
      if (targetRoom.host_id === session.playerId && msg.bot_count !== undefined) configureBots(targetRoom,msg.bot_count,msg.ai_difficulty);
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
      configureBots(room,msg.bot_count || 0,msg.ai_difficulty);
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

    case 'bot_settings': {
      const room = rooms.get(session.roomCode);
      if (!room || room.host_id !== session.playerId || room.matchEnded) {
        session.sendJson({t:'room_err',msg:'فقط سازندهٔ فعلی اتاق می‌تواند بات‌ها را تنظیم کند.'});
        return;
      }
      configureBots(room, msg.bot_count, msg.ai_difficulty);
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

      if (!clearShot(room.map_id, attack.origin, target)) return;
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
      victim.hp = victim.maxHp || 100;
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
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/api/status' || urlPath === '/api/online') {
    const apkExists = fs.existsSync(APK_PATH);
    const apkSizeMb = apkExists ? (fs.statSync(APK_PATH).size / (1024 * 1024)).toFixed(1) : 0;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      server_version: '1.3.1',
      game: 'Dost in Prehistoric Karen',
      studio: 'Karen Studios',
      online_players: getOnlineLeaderboard().length,
      active_rooms: getPublicRoomsList(),
      leaderboard: getOnlineLeaderboard(),
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

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>بازیکنان آنلاین | Dost</title><style>
*{box-sizing:border-box}body{margin:0;background:#080d18;color:#e8f4ff;font-family:Tahoma,Arial,sans-serif;padding:28px}main{max-width:1100px;margin:auto}header{border:1px solid #20cfc0;background:#111d30;padding:28px;border-radius:18px}h1{color:#5cf5d8;margin:0 0 12px}p{line-height:1.9;color:#aac1d9}.badge{color:#ffd966;font-size:20px}.table{overflow:auto;margin-top:24px;border:1px solid #263b56;border-radius:14px}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{padding:16px;text-align:right;border-bottom:1px solid #25364a}th{background:#13233a;color:#61e9da}tbody tr:hover{background:#101e32}.empty{text-align:center;padding:40px;color:#a6bbcf}#error{color:#ffac92}footer{margin-top:20px;color:#90a7bf;font-size:13px}button{background:#31debd;border:0;border-radius:8px;padding:10px 18px;font-weight:bold;cursor:pointer}
</style></head><body><main><header><h1>Dost in Prehistoric Karen</h1><div>KAREN STUDIOS · لیدربرد زنده</div>
<p>تمام بازیکنان واقعی که اکنون به سرور متصل‌اند؛ شامل بازیکنان داخل منو و مسابقه. بات‌ها و حساب‌های آفلاین در این فهرست نیستند.</p>
<div class="badge">بازیکنان آنلاین: <strong id="count">—</strong></div><p>رتبه‌بندی بر اساس امتیاز حساب و مجموع کیل‌هاست؛ کیل و لول مسابقه نیز جدا نمایش داده می‌شود.</p><button id="refresh">بروزرسانی</button><div id="error" role="status"></div></header>
<div class="table"><table><thead><tr><th>رتبه</th><th>بازیکن</th><th>وضعیت</th><th>امتیاز</th><th>کل کیل‌ها</th><th>مرگ‌ها</th><th>بردها</th><th>کیل مسابقه</th><th>لول مسابقه</th></tr></thead><tbody id="players"></tbody></table><div id="empty" class="empty">در حال دریافت بازیکنان…</div></div><footer>بروزرسانی خودکار هر ۵ ثانیه · <span id="updated"></span> · سرور 1.3.1</footer></main>
<script>
let busy=false;
async function update(){if(busy)return;busy=true;try{
 const response=await fetch('/api/online',{cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);
 const data=await response.json(),list=data.leaderboard||[],body=document.getElementById('players');body.replaceChildren();
 list.forEach((p,i)=>{const row=document.createElement('tr');[i+1,p.name,p.status,p.rating,p.kills,p.deaths,p.wins,p.match_kills,p.level].forEach(value=>{const cell=document.createElement('td');cell.textContent=String(value);row.appendChild(cell)});body.appendChild(row)});
 document.getElementById('count').textContent=list.length;document.getElementById('empty').hidden=list.length>0;
 document.getElementById('empty').textContent='در حال حاضر بازیکنی آنلاین نیست.';
 document.getElementById('error').textContent='';document.getElementById('updated').textContent='آخرین دریافت: '+new Date().toLocaleTimeString('fa-IR');
 }catch(e){document.getElementById('error').textContent='ارتباط با سرور برقرار نشد؛ فهرست ممکن است قدیمی باشد.'}finally{busy=false}}
document.getElementById('refresh').onclick=update;update();setInterval(update,5000);
</script></body></html>`);
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

setInterval(() => tickBots(), 100).unref();

server.listen(PORT, HOST, () => {
  console.log(`[KAREN SERVER] Dost in Prehistoric Karen Online Server listening on http://${HOST}:${PORT}`);
});
