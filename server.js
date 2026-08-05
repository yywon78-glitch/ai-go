'use strict';
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const { v4: uuid } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const db       = require('./db');
const {
  createGame, placeStone, passMove,
  calcScore, autoSuggestDead, toSGF,
} = require('./game');

// ─── 초기화 ───────────────────────────────────────────────
const app    = express();
app.set('trust proxy', 1);  // Railway 리버스 프록시 신뢰 (세션 쿠키 HTTPS 동작)
const server = http.createServer(app);
const io      = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || '*' } });
const PORT    = process.env.PORT || 3100;
const DATA_DIR = process.env.DATA_DIR || __dirname;

const SGF_DIR = path.join(DATA_DIR, 'sgf_records');
if (!fs.existsSync(SGF_DIR)) fs.mkdirSync(SGF_DIR, { recursive: true });

// ─── 미들웨어 ────────────────────────────────────────────
app.use(express.json());

// CORS: file:// 에서 직접 열어도 동작하도록 허용
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 세션 미들웨어 (정적 파일보다 먼저 — 쿠키 설정 필요)
const isProd = process.env.NODE_ENV === 'production';
const sessionMw = session({
  secret: process.env.SESSION_SECRET || 'smart-baduk-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  },
});
app.use(sessionMw);

// 소켓에 세션 공유
io.use((socket, next) => sessionMw(socket.request, {}, next));

// ─── 페이지 라우트 (세션 뒤, static 앞) ─────────────────
app.get('/',         (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/room.html',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));
app.get('/login.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// 기타 정적 파일 (socket.io.js 등)
app.use(express.static(path.join(__dirname, 'public')));

// 세션 저장 완료 후 응답하는 헬퍼
function saveAndRespond(req, res, payload) {
  req.session.save(err => {
    if (err) { console.error('세션 저장 오류:', err); return res.json({ ok: false, msg: '서버 오류' }); }
    res.json(payload);
  });
}

app.post('/auth/register', async (req, res) => {
  try {
    const { nick, email, password, rank } = req.body;
    if (!nick?.trim() || !email?.trim() || !password)
      return res.json({ ok: false, msg: '필수 항목을 입력하세요' });
    if (nick.trim().length < 2)
      return res.json({ ok: false, msg: '닉네임은 2자 이상이어야 합니다' });

    const dup = db.prepare('SELECT id FROM users WHERE nick=? OR email=?').get(nick.trim(), email.trim());
    if (dup) return res.json({ ok: false, msg: '이미 사용 중인 닉네임 또는 이메일입니다' });

    const hash = await bcrypt.hash(password, 10);
    const r = db.prepare('INSERT INTO users (nick,email,password_hash,rank) VALUES (?,?,?,?)')
                .run(nick.trim(), email.trim(), hash, rank || '?급');

    const user = { id: r.lastInsertRowid, nick: nick.trim(), rank: rank || '?급', isGuest: false, isAdmin: false };
    req.session.user = user;
    saveAndRespond(req, res, { ok: true, user });
  } catch (e) {
    console.error('/auth/register 오류:', e.message);
    res.json({ ok: false, msg: '서버 오류: ' + e.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ ok: false, msg: '이메일과 비밀번호를 입력하세요' });

    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email.trim());
    if (!u)          return res.json({ ok: false, msg: '이메일 또는 비밀번호가 틀립니다' });
    if (u.is_banned) return res.json({ ok: false, msg: '정지된 계정입니다' });

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.json({ ok: false, msg: '이메일 또는 비밀번호가 틀립니다' });

    db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(u.id);
    const user = { id: u.id, nick: u.nick, rank: u.rank, isGuest: false, isAdmin: !!u.is_admin };
    req.session.user = user;
    saveAndRespond(req, res, { ok: true, user });
  } catch (e) {
    console.error('/auth/login 오류:', e.message);
    res.json({ ok: false, msg: '서버 오류: ' + e.message });
  }
});

app.post('/auth/guest', (req, res) => {
  try {
    const { nick } = req.body;
    if (!nick?.trim() || nick.trim().length < 2)
      return res.json({ ok: false, msg: '닉네임은 2자 이상이어야 합니다' });

    const taken = db.prepare('SELECT id FROM users WHERE nick=? AND is_guest=0').get(nick.trim());
    if (taken) return res.json({ ok: false, msg: '회원이 사용 중인 닉네임입니다' });

    const user = { id: null, nick: nick.trim(), rank: '?급', isGuest: true, isAdmin: false };
    req.session.user = user;
    saveAndRespond(req, res, { ok: true, user });
  } catch (e) {
    console.error('/auth/guest 오류:', e.message);
    res.json({ ok: false, msg: '서버 오류: ' + e.message });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/me', (req, res) => {
  res.json({ ok: !!req.session.user, user: req.session.user || null });
});

// SGF 다운로드
app.get('/sgf/:gameId', (req, res) => {
  const g = db.prepare('SELECT sgf_path,black_nick,white_nick FROM games WHERE id=?').get(req.params.gameId);
  if (!g || !fs.existsSync(g.sgf_path)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'application/x-go-sgf');
  res.setHeader('Content-Disposition', `attachment; filename="${g.black_nick}_vs_${g.white_nick}.sgf"`);
  res.send(fs.readFileSync(g.sgf_path, 'utf8'));
});

// 마이페이지 기록
app.get('/my/games', (req, res) => {
  if (!req.session.user?.id) return res.json({ ok: false });
  const uid = req.session.user.id;
  const rows = db.prepare(`SELECT * FROM games WHERE black_user_id=? OR white_user_id=? ORDER BY ended_at DESC LIMIT 30`).all(uid, uid);
  res.json({ ok: true, games: rows });
});

app.get('/my/connections', (req, res) => {
  if (!req.session.user?.id) return res.json({ ok: false });
  const rows = db.prepare('SELECT * FROM connections WHERE user_id=? ORDER BY connected_at DESC LIMIT 30').all(req.session.user.id);
  res.json({ ok: true, connections: rows });
});

// 최근 기보 목록 (로비용 — 인증 불필요)
app.get('/api/recent-games', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const rows = db.prepare(`
    SELECT id, title, board_size, black_nick, white_nick, result, total_moves, komi, ended_at
    FROM games
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(limit);
  res.json({ ok: true, games: rows });
});

// ─── 인메모리 상태 ────────────────────────────────────────
const rooms      = new Map();   // roomId → room
const onlineUsers = new Map();  // socketId → userInfo

// ─── SOCKET ──────────────────────────────────────────────
io.on('connection', (socket) => {
  const sess = socket.request.session;

  // ── 로비 ──────────────────────────────────────────────
  socket.on('join-lobby', () => {
    if (!sess.user) return;
    const u = { ...sess.user, status: 'lobby', roomId: null, socketId: socket.id };
    onlineUsers.set(socket.id, u);

    if (u.id) {
      db.prepare('INSERT INTO connections (user_id,socket_id,ip,activity) VALUES (?,?,?,?)')
        .run(u.id, socket.id, socket.handshake.address, 'lobby');
    }

    socket.join('lobby');
    socket.emit('online-users-list', onlineList());
    socket.emit('room-list', roomList());
    io.to('lobby').emit('user-online', { nick: u.nick, rank: u.rank, status: 'lobby', isGuest: u.isGuest });
    io.emit('online-count', onlineUsers.size);
  });

  socket.on('create-room', (opts = {}) => {
    const u = onlineUsers.get(socket.id);
    if (!u) return;
    const size     = [9, 13, 19].includes(opts.size) ? opts.size : 19;
    const komi     = [0, 6.5, 7.5].includes(opts.komi) ? opts.komi : 6.5;
    const mainTime = Math.min(Math.max(opts.mainTime || 600, 60), 3600);
    const roomId   = uuid();

    rooms.set(roomId, {
      id: roomId,
      title: (opts.title || `${u.nick}의 대국`).slice(0, 30),
      size, komi, mainTime,
      game: createGame(size, komi),
      players: { black: null, white: null },
      spectators: [],
      chat: [],
      status: 'waiting',
      timers: { black: mainTime, white: mainTime },
      timerInterval: null,
      createdAt: Date.now(),
      endedAt: null,
      scoreRequest: null,
      scoreConfirmed: { black: false, white: false },
      pendingScoreData: null,
    });

    socket.emit('room-created', { roomId });
    io.to('lobby').emit('room-list', roomList());
  });

  socket.on('join-room', ({ roomId }) => {
    // 로비를 거치지 않고 room.html로 직접 들어온 경우 세션에서 유저 복원
    let u = onlineUsers.get(socket.id);
    if (!u) {
      const sessUser = sess.user;
      if (!sessUser) return socket.emit('room-error', '로그인이 필요합니다');
      u = { ...sessUser, status: 'lobby', roomId: null, socketId: socket.id };
      onlineUsers.set(socket.id, u);
    }

    const room = rooms.get(roomId);
    if (!room) return socket.emit('room-error', '방을 찾을 수 없습니다');

    socket.leave('lobby');
    socket.join(roomId);

    let role;
    if (!room.players.black) {
      room.players.black = { socketId: socket.id, nick: u.nick, rank: u.rank };
      role = 'black';
    } else if (!room.players.white) {
      room.players.white = { socketId: socket.id, nick: u.nick, rank: u.rank };
      role = 'white';
      room.status = 'playing';
      room.game.startedAt = Date.now();
      startTimer(room);
    } else {
      room.spectators.push({ socketId: socket.id, nick: u.nick });
      role = 'spectator';
    }

    u.status  = role === 'spectator' ? 'spectating' : 'playing';
    u.roomId  = roomId;

    if (u.id) {
      db.prepare("UPDATE connections SET activity=?,room_id=? WHERE socket_id=? AND disconnected_at IS NULL")
        .run(u.status, roomId, socket.id);
    }

    socket.emit('joined-room', { role, snap: snap(room) });
    io.to(roomId).emit('room-update', snap(room));
    io.to('lobby').emit('room-list', roomList());
    io.to('lobby').emit('user-status', { nick: u.nick, status: u.status });
    io.emit('online-count', onlineUsers.size);
  });

  // ── 착수 ──────────────────────────────────────────────
  socket.on('place-stone', ({ x, y }) => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'playing') return;

    const role = getRole(room, socket.id);
    if (role !== 'black' && role !== 'white') return;

    const res = placeStone(room.game, x, y, role);
    if (!res.ok) return socket.emit('move-error', res.msg);

    resetTurnTimer(room, role);
    io.to(u.roomId).emit('stone-placed', {
      x, y, player: role,
      moveNum: room.game.moveList.length,
      coord: res.coord,
      capturedCount: res.captured,
      board: room.game.board,
      currentPlayer: room.game.currentPlayer,
      capturedBlack: room.game.capturedBlack,
      capturedWhite: room.game.capturedWhite,
      lastMove: room.game.lastMove,
      koPoint: room.game.koPoint,
    });
  });

  // ── 패스 ──────────────────────────────────────────────
  socket.on('pass-turn', () => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'playing') return;

    const role = getRole(room, socket.id);
    if (role !== 'black' && role !== 'white') return;

    const res = passMove(room.game, role);
    if (!res.ok) return socket.emit('move-error', res.msg);

    if (res.phase === 'marking') {
      room.status = 'marking';
      stopTimer(room);
      const suggested = autoSuggestDead(room.game.board, room.game.size);
      io.to(u.roomId).emit('enter-marking', {
        board: room.game.board,
        suggested,
      });
    } else {
      resetTurnTimer(room, role);
      io.to(u.roomId).emit('pass-done', {
        player: role,
        currentPlayer: room.game.currentPlayer,
        passCount: room.game.passCount,
      });
    }
  });

  // ── 불계 ──────────────────────────────────────────────
  socket.on('resign', () => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || !['playing', 'marking'].includes(room.status)) return;

    const role = getRole(room, socket.id);
    if (role !== 'black' && role !== 'white') return;

    const winner = role === 'black' ? 'white' : 'black';
    endGame(room, role === 'black' ? 'W+R' : 'B+R', winner, u.roomId);
  });

  // ── 계가 합의 프로토콜 ────────────────────────────────
  socket.on('submit-dead', ({ deadStones }) => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'marking') return;

    const role = getRole(room, socket.id);
    if (role !== 'black' && role !== 'white') return;

    room.game.deadProposals[role] = new Set(Array.isArray(deadStones) ? deadStones : []);
    room.game.deadSubmitted[role] = true;

    io.to(u.roomId).emit('dead-submitted', { player: role });

    // 양측 모두 제출했을 때
    if (room.game.deadSubmitted.black && room.game.deadSubmitted.white) {
      const bp = room.game.deadProposals.black;
      const wp = room.game.deadProposals.white;

      if (setsEqual(bp, wp)) {
        // 합의 완료
        const dead = [...bp];
        const scoreData = calcScore(room.game, dead);
        endGame(room, scoreData.result, scoreData.winner, u.roomId, dead, scoreData);
      } else {
        // 이견 → 클라이언트에 알림
        const onlyBlack = [...bp].filter(k => !wp.has(k));
        const onlyWhite = [...wp].filter(k => !bp.has(k));
        room.game.deadSubmitted = { black: false, white: false };
        io.to(u.roomId).emit('dead-disagreement', { onlyBlack, onlyWhite });
      }
    }
  });

  // 이견 시 교집합으로 계가 (어느 쪽이든 클릭 가능)
  socket.on('accept-intersection', () => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'marking') return;

    const bp = room.game.deadProposals.black || new Set();
    const wp = room.game.deadProposals.white || new Set();
    const dead = [...bp].filter(k => wp.has(k));
    const scoreData = calcScore(room.game, dead);
    endGame(room, scoreData.result, scoreData.winner, u.roomId, dead, scoreData);
  });

  // 이견 시 계속 두기
  socket.on('resume-play', () => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'marking') return;

    room.status = 'playing';
    room.game.phase = 'playing';
    room.game.passCount = 0;
    room.game.deadProposals = { black: null, white: null };
    room.game.deadSubmitted = { black: false, white: false };
    startTimer(room);
    io.to(u.roomId).emit('resumed-play', {
      currentPlayer: room.game.currentPlayer,
      board: room.game.board,
    });
  });

  // ── 계가 신청 ─────────────────────────────────────────
  socket.on('request-score', () => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'playing') return;
    const role = getRole(room, socket.id);
    if (role !== 'black' && role !== 'white') return;

    room.status = 'score-request';
    room.scoreRequest = { requester: role };
    stopTimer(room);
    io.to(u.roomId).emit('score-requested', { requester: role, nick: u.nick });
  });

  socket.on('accept-score', () => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'score-request') return;
    const role = getRole(room, socket.id);
    if (role === room.scoreRequest?.requester) return; // 자기 신청 수락 불가

    room.status = 'scoring';
    room.scoreConfirmed = { black: false, white: false };
    room.pendingScoreData = null;
    io.to(u.roomId).emit('score-accepted', {
      accepter: role,
      board: room.game.board,
      boardSize: room.game.size,
      komi: room.komi,
    });
  });

  socket.on('reject-score', () => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'score-request') return;
    const role = getRole(room, socket.id);
    if (role === room.scoreRequest?.requester) return;

    room.status = 'playing';
    room.scoreRequest = null;
    startTimer(room);
    io.to(u.roomId).emit('score-rejected', { rejecter: role });
  });

  socket.on('ai-score-result', ({ ownership }) => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'scoring') return;
    if (room.pendingScoreData) return; // 중복 수신 방지

    const scoreData = ownership
      ? calcScoreFromOwnership(room.game, ownership, room.komi)
      : calcScore(room.game, autoSuggestDead(room.game.board, room.game.size));

    room.pendingScoreData = scoreData;
    io.to(u.roomId).emit('score-result', { scoreData, ownership });
  });

  socket.on('confirm-score', () => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'scoring' || !room.pendingScoreData) return;
    const role = getRole(room, socket.id);
    if (role !== 'black' && role !== 'white') return;

    room.scoreConfirmed[role] = true;
    io.to(u.roomId).emit('score-confirmed-by', { role });

    if (room.scoreConfirmed.black && room.scoreConfirmed.white) {
      const sd = room.pendingScoreData;
      endGame(room, sd.result, sd.winner, u.roomId, sd.dead || [], sd);
    }
  });

  socket.on('dispute-score', () => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || room.status !== 'scoring') return;

    room.status = 'playing';
    room.scoreRequest = null;
    room.scoreConfirmed = { black: false, white: false };
    room.pendingScoreData = null;
    startTimer(room);
    io.to(u.roomId).emit('score-disputed', {
      currentPlayer: room.game.currentPlayer,
      board: room.game.board,
    });
  });

  // ── 채팅 ──────────────────────────────────────────────
  socket.on('chat-message', ({ text }) => {
    const u    = onlineUsers.get(socket.id);
    const room = u?.roomId ? rooms.get(u.roomId) : null;
    if (!room || !text?.trim()) return;

    const role = getRole(room, socket.id) || 'spectator';
    const msg  = {
      nick: u.nick,
      text: text.trim().slice(0, 200),
      role,
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
    };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    io.to(u.roomId).emit('chat', msg);
  });

  // ── 연결 해제 ─────────────────────────────────────────
  socket.on('disconnect', () => {
    const u = onlineUsers.get(socket.id);
    if (!u) return;

    if (u.id) {
      db.prepare("UPDATE connections SET disconnected_at=datetime('now'), duration_sec=strftime('%s','now')-strftime('%s',connected_at) WHERE socket_id=?")
        .run(socket.id);
    }

    if (u.roomId) {
      const room = rooms.get(u.roomId);
      if (room) {
        const role = getRole(room, socket.id);
        if (role === 'black' || role === 'white') {
          io.to(u.roomId).emit('player-disconnected', { nick: u.nick, role });
          if (role === 'black') room.players.black = null;
          else                  room.players.white = null;

          if (!room.players.black && !room.players.white && room.status !== 'ended') {
            stopTimer(room);
            rooms.delete(u.roomId);
          } else {
            io.to(u.roomId).emit('room-update', snap(room));
          }
        } else {
          room.spectators = room.spectators.filter(s => s.socketId !== socket.id);
          io.to(u.roomId).emit('room-update', snap(room));
        }
      }
    }

    io.to('lobby').emit('user-offline', { nick: u.nick });
    onlineUsers.delete(socket.id);
    io.emit('online-count', onlineUsers.size);
    io.to('lobby').emit('room-list', roomList());
  });
});

// ─── 타이머 ──────────────────────────────────────────────
function startTimer(room) {
  stopTimer(room);
  room.timerInterval = setInterval(() => {
    if (room.status !== 'playing') { stopTimer(room); return; }
    const p = room.game.currentPlayer;
    room.timers[p] = Math.max(0, room.timers[p] - 1);
    io.to(room.id).emit('timer-tick', {
      black: room.timers.black,
      white: room.timers.white,
      active: p,
    });
    if (room.timers[p] === 0) {
      stopTimer(room);
      const winner = p === 'black' ? 'white' : 'black';
      const result = p === 'black' ? 'W+T' : 'B+T';
      io.to(room.id).emit('time-out', { loser: p });
      endGame(room, result, winner, room.id);
    }
  }, 1000);
}

function stopTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
}

function resetTurnTimer(_room, _movedPlayer) {
  // 타이머는 계속 흐름 — 향후 바요미 구현 시 여기서 처리
}

// ─── 게임 종료 ────────────────────────────────────────────
function endGame(room, result, winner, roomId, deadStones, scoreData) {
  stopTimer(room);
  room.status = 'ended';
  room.endedAt = Date.now();
  room.game.phase = 'ended';
  room.game.result = result;

  // SGF 저장
  const players = {
    black: room.players.black?.nick || '흑',
    white: room.players.white?.nick || '백',
  };
  const sgf  = toSGF(room.game, players);
  const fname = `${new Date().toISOString().replace(/[:.]/g,'_')}_${result.replace('+','p')}.sgf`;
  const sgfPath = path.join(SGF_DIR, fname);
  fs.writeFileSync(sgfPath, sgf, 'utf8');

  // DB 저장
  const blackId = getUid(room.players.black?.nick);
  const whiteId = getUid(room.players.white?.nick);
  try {
    db.prepare(`INSERT OR IGNORE INTO games
      (id,title,board_size,black_user_id,white_user_id,black_nick,white_nick,result,total_moves,komi,sgf_path,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(room.id, room.title, room.size, blackId, whiteId,
        players.black, players.white,
        result, room.game.moveList.length, room.komi, sgfPath,
        room.game.startedAt ? new Date(room.game.startedAt).toISOString() : null);

    if (blackId) {
      if (winner === 'black') db.prepare('UPDATE users SET wins=wins+1 WHERE id=?').run(blackId);
      else                    db.prepare('UPDATE users SET losses=losses+1 WHERE id=?').run(blackId);
    }
    if (whiteId) {
      if (winner === 'white') db.prepare('UPDATE users SET wins=wins+1 WHERE id=?').run(whiteId);
      else                    db.prepare('UPDATE users SET losses=losses+1 WHERE id=?').run(whiteId);
    }
  } catch (e) { console.error('DB 저장 오류:', e.message); }

  io.to(roomId).emit('game-ended', {
    result, winner,
    scoreData: scoreData || null,
    deadStones: deadStones || [],
    moveList: room.game.moveList || [],
    gameId: room.id,
  });
  io.to('lobby').emit('room-list', roomList());
  io.to('lobby').emit('game-record-added');  // 로비 최근 기보 섹션 갱신
}

// ─── 유틸 ────────────────────────────────────────────────
function getRole(room, socketId) {
  if (room.players.black?.socketId === socketId) return 'black';
  if (room.players.white?.socketId === socketId) return 'white';
  if (room.spectators.find(s => s.socketId === socketId)) return 'spectator';
  return null;
}

function snap(room) {
  return {
    id: room.id, title: room.title, size: room.size, komi: room.komi,
    status: room.status, mainTime: room.mainTime,
    players: room.players, spectators: room.spectators,
    board: room.game.board,
    currentPlayer: room.game.currentPlayer,
    capturedBlack: room.game.capturedBlack,
    capturedWhite: room.game.capturedWhite,
    lastMove: room.game.lastMove, koPoint: room.game.koPoint,
    passCount: room.game.passCount,
    moveCount: room.game.moveList.length,
    timers: room.timers,
    chat: room.chat.slice(-50),
    phase: room.game.phase,
  };
}

function roomList() {
  // ended 방은 DB 기반 /api/recent-games 에서 제공 — 소켓 목록에서 제외
  const all = [...rooms.values()]
    .filter(r => r.status !== 'ended')
    .map(r => ({
      id: r.id, title: r.title, size: r.size, status: r.status,
      black: r.players.black?.nick || null,
      white: r.players.white?.nick || null,
      spectatorCount: r.spectators.length,
      moveCount: r.game.moveList.length,
      createdAt: r.createdAt,
    }));
  const waiting = all.filter(r => r.status === 'waiting').sort((a, b) => b.createdAt - a.createdAt);
  const active  = all.filter(r => r.status !== 'waiting');
  return [...waiting, ...active];
}

function onlineList() {
  return [...onlineUsers.values()].map(u => ({
    nick: u.nick, rank: u.rank, status: u.status, isGuest: u.isGuest,
  }));
}

function calcScoreFromOwnership(game, ownership, komi) {
  const { board, size, capturedBlack, capturedWhite } = game;
  let bT = 0, wT = 0, bDead = 0, wDead = 0;
  const dead = [];
  const territories = { black: [], white: [] };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = ownership[y * size + x];
      const stone = board[y][x];
      const key = `${x},${y}`;
      if (stone === 'black' && o < -0.4)     { bDead++; dead.push(key); territories.white.push(key); }
      else if (stone === 'white' && o > 0.4) { wDead++; dead.push(key); territories.black.push(key); }
      else if (!stone) {
        if (o > 0.4)      { bT++; territories.black.push(key); }
        else if (o < -0.4){ wT++; territories.white.push(key); }
      }
    }
  }
  const blackScore = bT + capturedBlack + wDead;
  const whiteScore = wT + capturedWhite + bDead + komi;
  const winner = blackScore > whiteScore ? 'black' : 'white';
  const margin  = Math.abs(blackScore - whiteScore).toFixed(1);
  const result  = winner === 'black' ? `B+${margin}` : `W+${margin}`;
  return {
    blackScore, whiteScore,
    blackTerritory: bT, whiteTerritory: wT,
    blackDead: bDead, whiteDead: wDead,
    capturedBlack, capturedWhite,
    winner, result, dead, territories,
  };
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

function getUid(nick) {
  if (!nick) return null;
  return db.prepare('SELECT id FROM users WHERE nick=?').get(nick)?.id || null;
}

// ─── 시작 ────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎯 스마트 대국 서버 실행 중\n   http://localhost:${PORT}\n`);
});