'use strict';
// game.js — 서버측 바둑 규칙 엔진
// v3.35 클라이언트 로직 이식 + 플레이어 합의 계가 지원

const COORDS = 'ABCDEFGHJKLMNOPQRST';

// ─── 게임 생성 ───────────────────────────────────────────
function createGame(size = 19, komi = 6.5) {
  return {
    size,
    komi,
    board: Array.from({ length: size }, () => Array(size).fill(null)),
    currentPlayer: 'black',
    history: [],
    moveList: [],
    capturedBlack: 0,   // 흑이 따낸 돌 수 (백 사석)
    capturedWhite: 0,   // 백이 따낸 돌 수 (흑 사석)
    passCount: 0,
    lastMove: null,
    koPoint: null,
    phase: 'playing',   // 'playing' | 'marking' | 'ended'
    deadProposals: { black: null, white: null },
    deadSubmitted:  { black: false, white: false },
    result: null,
    startedAt: null,
  };
}

// ─── 기본 유틸 ────────────────────────────────────────────
function neighbors(x, y, size) {
  const n = [];
  if (x > 0)        n.push({ x: x - 1, y });
  if (x < size - 1) n.push({ x: x + 1, y });
  if (y > 0)        n.push({ x, y: y - 1 });
  if (y < size - 1) n.push({ x, y: y + 1 });
  return n;
}

function getGroup(board, sx, sy, size) {
  const color = board[sy][sx];
  if (!color) return [];
  const group = [], visited = new Set(), stack = [{ x: sx, y: sy }];
  while (stack.length) {
    const p = stack.pop();
    const k = `${p.x},${p.y}`;
    if (visited.has(k)) continue;
    visited.add(k);
    if (board[p.y][p.x] !== color) continue;
    group.push(p);
    for (const n of neighbors(p.x, p.y, size))
      if (!visited.has(`${n.x},${n.y}`)) stack.push(n);
  }
  return group;
}

function liberties(board, group, size) {
  const libs = new Set();
  for (const p of group)
    for (const n of neighbors(p.x, p.y, size))
      if (board[n.y][n.x] === null) libs.add(`${n.x},${n.y}`);
  return libs.size;
}

function cloneBoard(board) {
  return board.map(row => [...row]);
}

// ─── 착수 ────────────────────────────────────────────────
function placeStone(game, x, y, player) {
  if (game.phase !== 'playing')
    return { ok: false, msg: '대국 중이 아닙니다' };
  if (game.currentPlayer !== player)
    return { ok: false, msg: '상대방 차례입니다' };
  const { board, size } = game;
  if (board[y][x] !== null)
    return { ok: false, msg: '이미 돌이 있습니다' };
  if (game.koPoint && game.koPoint.x === x && game.koPoint.y === y)
    return { ok: false, msg: '패! 한 수 쉬어야 합니다' };

  const opp = player === 'black' ? 'white' : 'black';

  // 히스토리 저장
  game.history.push({
    board: cloneBoard(board),
    currentPlayer: game.currentPlayer,
    capturedBlack: game.capturedBlack,
    capturedWhite: game.capturedWhite,
    lastMove: game.lastMove,
    koPoint: game.koPoint,
  });

  board[y][x] = player;

  // 따냄
  const captured = [];
  for (const n of neighbors(x, y, size)) {
    if (board[n.y][n.x] === opp) {
      const g = getGroup(board, n.x, n.y, size);
      if (liberties(board, g, size) === 0) captured.push(...g);
    }
  }
  for (const p of captured) board[p.y][p.x] = null;

  // 자충수 검사
  if (captured.length === 0) {
    const myG = getGroup(board, x, y, size);
    if (liberties(board, myG, size) === 0) {
      // 롤백
      const prev = game.history.pop();
      game.board = prev.board;
      return { ok: false, msg: '자충수! 둘 수 없습니다' };
    }
  }

  // 패 검출
  game.koPoint = null;
  if (captured.length === 1) {
    const myG = getGroup(board, x, y, size);
    if (myG.length === 1 && liberties(board, myG, size) === 1)
      game.koPoint = captured[0];
  }

  if (player === 'black') game.capturedBlack += captured.length;
  else                     game.capturedWhite += captured.length;

  const coord = `${COORDS[x]}${size - y}`;
  game.moveList.push({ player, type: 'stone', x, y, moveNum: game.moveList.length + 1, coord });
  game.lastMove = { x, y };
  game.currentPlayer = opp;
  game.passCount = 0;

  return {
    ok: true,
    coord,
    captured: captured.length,
    board: game.board,
    currentPlayer: game.currentPlayer,
  };
}

// ─── 패스 ────────────────────────────────────────────────
function passMove(game, player) {
  if (game.phase !== 'playing')
    return { ok: false, msg: '대국 중이 아닙니다' };
  if (game.currentPlayer !== player)
    return { ok: false, msg: '상대방 차례입니다' };

  game.history.push({
    board: cloneBoard(game.board),
    currentPlayer: game.currentPlayer,
    capturedBlack: game.capturedBlack,
    capturedWhite: game.capturedWhite,
    lastMove: game.lastMove,
    koPoint: game.koPoint,
  });

  const opp = player === 'black' ? 'white' : 'black';
  game.moveList.push({ player, type: 'pass', moveNum: game.moveList.length + 1, coord: '패스' });
  game.lastMove = null;
  game.koPoint = null;
  game.passCount++;
  game.currentPlayer = opp;

  if (game.passCount >= 2) {
    game.phase = 'marking';
    game.deadProposals = { black: null, white: null };
    game.deadSubmitted = { black: false, white: false };
    return { ok: true, phase: 'marking' };
  }
  return { ok: true, phase: 'playing' };
}

// ─── 계가 ────────────────────────────────────────────────
function calcTerritory(board, size, deadSet) {
  const terr = { black: [], white: [] };
  const visited = new Set();

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = `${x},${y}`;
      if (visited.has(k)) continue;
      if (board[y][x] && !deadSet.has(k)) continue;   // 살아있는 돌 스킵

      const region = [], borders = new Set(), stack = [{ x, y }];
      while (stack.length) {
        const p = stack.pop();
        const pk = `${p.x},${p.y}`;
        if (visited.has(pk)) continue;
        const stone = board[p.y][p.x];
        if (stone && !deadSet.has(pk)) { borders.add(stone); continue; }
        visited.add(pk);
        region.push(pk);
        for (const n of neighbors(p.x, p.y, size))
          if (!visited.has(`${n.x},${n.y}`)) stack.push(n);
      }
      if (borders.size === 1) {
        const owner = borders.values().next().value;
        terr[owner].push(...region);
      }
    }
  }
  return terr;
}

function calcScore(game, deadStones) {
  const deadSet = new Set(deadStones || []);
  const { board, size, komi, capturedBlack, capturedWhite } = game;
  const terr = calcTerritory(board, size, deadSet);

  let blackDead = 0, whiteDead = 0;
  for (const k of deadSet) {
    const [x, y] = k.split(',').map(Number);
    if (board[y][x] === 'black') blackDead++;
    else if (board[y][x] === 'white') whiteDead++;
  }

  // 일본 규칙: 집 + 따낸 돌 (상대 사석 포함)
  const blackScore = terr.black.length + capturedBlack + whiteDead;
  const whiteScore = terr.white.length + capturedWhite + blackDead + komi;
  const winner  = blackScore > whiteScore ? 'black' : 'white';
  const margin  = Math.abs(blackScore - whiteScore);
  const result  = winner === 'black' ? `B+${margin}` : `W+${margin}`;

  return {
    blackScore, whiteScore,
    blackTerritory: terr.black.length,
    whiteTerritory: terr.white.length,
    blackDead, whiteDead,
    capturedBlack, capturedWhite,
    komi,
    territories: terr,
    winner, result,
  };
}

// ─── 사석 자동 제안 (플레이어 힌트용) ────────────────────
// 단순 원칙: 그룹이 도달 가능한 모든 빈 점이 상대 잠정 집에만 속하면 → 사석 후보
function autoSuggestDead(board, size) {
  const deadSet = new Set();

  for (let iter = 0; iter < 6; iter++) {
    const terr = calcTerritory(board, size, deadSet);
    const blackSet = new Set(terr.black);
    const whiteSet = new Set(terr.white);
    let changed = false;

    const checked = new Set();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = `${x},${y}`;
        if (checked.has(k) || !board[y][x] || deadSet.has(k)) continue;
        const color = board[y][x];
        const opp   = color === 'black' ? 'white' : 'black';
        const oppSet = opp === 'white' ? whiteSet : blackSet;
        const group = getGroup(board, x, y, size);
        group.forEach(p => checked.add(`${p.x},${p.y}`));

        // BFS: 그룹에서 빈 점으로 탈출 가능한지 + 모두 상대 집인지
        const visited2 = new Set(group.map(p => `${p.x},${p.y}`));
        const stack2 = [...group];
        let allInOpp = true, hasEmpty = false;

        while (stack2.length) {
          const p = stack2.pop();
          for (const n of neighbors(p.x, p.y, size)) {
            const nk = `${n.x},${n.y}`;
            if (visited2.has(nk)) continue;
            visited2.add(nk);
            const s = board[n.y][n.x];
            if (s === null || deadSet.has(nk)) {
              hasEmpty = true;
              if (!oppSet.has(nk)) { allInOpp = false; break; }
              stack2.push(n);
            } else if (s === color && !deadSet.has(nk)) {
              stack2.push(n);
            }
          }
          if (!allInOpp) break;
        }

        if (hasEmpty && allInOpp) {
          for (const p of group) {
            const pk = `${p.x},${p.y}`;
            if (!deadSet.has(pk)) { deadSet.add(pk); changed = true; }
          }
        }
      }
    }
    if (!changed) break;
  }
  return [...deadSet];
}

// ─── SGF 생성 ─────────────────────────────────────────────
function toSGF(game, players) {
  const { size, komi, moveList, result } = game;
  const date = new Date().toISOString().split('T')[0];
  const pb = players?.black || '흑';
  const pw = players?.white || '백';
  let s = `(;GM[1]FF[4]CA[UTF-8]SZ[${size}]KM[${komi}]PB[${pb}]PW[${pw}]DT[${date}]`;
  if (result) s += `RE[${result}]`;
  for (const m of moveList) {
    if (m.type === 'stone') {
      const col = m.player === 'black' ? 'B' : 'W';
      const a = String.fromCharCode(97 + m.x);
      const b = String.fromCharCode(97 + (size - 1 - m.y));
      s += `;${col}[${a}${b}]`;
    } else {
      s += `;${m.player === 'black' ? 'B' : 'W'}[]`;
    }
  }
  return s + ')';
}

// ─── 무르기 ──────────────────────────────────────────────
function undoMove(game) {
  if (game.phase !== 'playing') return { ok: false, msg: '대국 중이 아닙니다' };
  if (game.history.length === 0) return { ok: false, msg: '무를 수 있는 수가 없습니다' };
  const prev = game.history.pop();
  game.board         = prev.board;
  game.currentPlayer = prev.currentPlayer;
  game.capturedBlack = prev.capturedBlack;
  game.capturedWhite = prev.capturedWhite;
  game.lastMove      = prev.lastMove;
  game.koPoint       = prev.koPoint;
  game.passCount     = 0;
  if (game.moveList.length > 0) game.moveList.pop();
  return { ok: true };
}

module.exports = {
  createGame, placeStone, passMove,
  calcScore, calcTerritory, autoSuggestDead,
  toSGF, neighbors, getGroup, undoMove,
};