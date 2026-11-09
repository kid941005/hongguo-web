import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// SQLite 持久化：账号、登录令牌、观看历史、收藏、追剧。
// 数据文件放在 DATA_DIR（默认 /app/data，容器里挂在命名卷上），重建容器不丢。
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phash       TEXT NOT NULL,
  salt        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON auth_tokens(user_id);

CREATE TABLE IF NOT EXISTS history (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT '',
  vod_id      TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  cover       TEXT NOT NULL DEFAULT '',
  line_idx    INTEGER NOT NULL DEFAULT 0,
  line_name   TEXT NOT NULL DEFAULT '',
  ep_idx      INTEGER NOT NULL DEFAULT 0,
  ep_name     TEXT NOT NULL DEFAULT '',
  pos         REAL NOT NULL DEFAULT 0,
  dur         REAL NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, source, vod_id)
);
CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS favorites (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT '',
  vod_id      TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  cover       TEXT NOT NULL DEFAULT '',
  remarks     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, source, vod_id)
);

CREATE TABLE IF NOT EXISTS follows (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT '',
  vod_id      TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  cover       TEXT NOT NULL DEFAULT '',
  ep_count    INTEGER NOT NULL DEFAULT 0,
  last_checked INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, source, vod_id)
);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "hongguo.db");
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}
