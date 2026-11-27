
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "chessarena.db"));

// Improve database performance and reliability
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// PLAYER ACCOUNTS
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// COMPLETED CHESS GAMES
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    white_player_id INTEGER,
    black_player_id INTEGER,
    mode TEXT NOT NULL,
    time_control TEXT NOT NULL,
    result TEXT NOT NULL,
    reason TEXT,
    pgn TEXT NOT NULL,
    final_fen TEXT NOT NULL,
    played_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (white_player_id) REFERENCES users(id),
    FOREIGN KEY (black_player_id) REFERENCES users(id)
  );
`);

console.log("ChessArena database connected successfully.");

module.exports = db;
