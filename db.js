// db.js — node-sqlite3-wasm 기반 (Visual Studio 없이 동작)
'use strict';
const { Database } = require('node-sqlite3-wasm');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const raw = new Database(path.join(DATA_DIR, 'baduk.db'));

// WAL 모드
raw.run('PRAGMA journal_mode = WAL');

// 테이블 생성
raw.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nick          TEXT    NOT NULL,
  email         TEXT,
  password_hash TEXT,
  is_guest      INTEGER DEFAULT 0,
  is_admin      INTEGER DEFAULT 0,
  rank          TEXT    DEFAULT '?급',
  wins          INTEGER DEFAULT 0,
  losses        INTEGER DEFAULT 0,
  created_at    TEXT    DEFAULT (datetime('now')),
  last_login    TEXT,
  is_banned     INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_nick  ON users(nick);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_email ON users(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS connections (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER,
  socket_id        TEXT,
  ip               TEXT,
  activity         TEXT DEFAULT 'lobby',
  room_id          TEXT,
  connected_at     TEXT DEFAULT (datetime('now')),
  disconnected_at  TEXT,
  duration_sec     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conn_user ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_conn_date ON connections(connected_at);

CREATE TABLE IF NOT EXISTS games (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  board_size    INTEGER,
  black_user_id INTEGER,
  white_user_id INTEGER,
  black_nick    TEXT,
  white_nick    TEXT,
  result        TEXT,
  total_moves   INTEGER,
  komi          REAL,
  sgf_path      TEXT,
  started_at    TEXT,
  ended_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_game_black ON games(black_user_id);
CREATE INDEX IF NOT EXISTS idx_game_white ON games(white_user_id);
CREATE INDEX IF NOT EXISTS idx_game_date  ON games(ended_at);
`);

// better-sqlite3 호환 shim:  db.prepare(sql).run/get/all(...)
const db = {
  prepare: (sql) => ({
    run: (...args) => raw.run(sql, args),
    get: (...args) => raw.get(sql, args),
    all: (...args) => raw.all(sql, args),
  }),
};

module.exports = db;