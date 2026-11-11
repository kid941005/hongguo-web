import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { fail } from "./errors.mjs";

const DAY = 24 * 60 * 60 * 1000;
const TOKEN_TTL = 30 * DAY;
const USER_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,20}$/;

function hashPassword(pw, salt) {
  return scryptSync(String(pw), salt, 64).toString("hex");
}
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
function str(value, max = 200) {
  return String(value == null ? "" : value).slice(0, max);
}
function num(value, def = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

export class UserStore {
  constructor(db) {
    this.db = db;
    try { this.db.prepare("DELETE FROM auth_tokens WHERE expires_at < ?").run(Date.now()); } catch { /* 清理过期令牌失败不影响启动 */ }
  }

  // ---- 账号 ----
  register(username, pw) {
    const name = String(username || "").trim();
    const pass = String(pw || "");
    if (!USER_RE.test(name)) throw fail("BAD_INPUT", "用户名需为 3–20 位中文、字母、数字或下划线");
    if (pass.length < 6 || pass.length > 64) throw fail("BAD_INPUT", "密码长度需为 6–64 位");
    const exists = this.db.prepare("SELECT id FROM users WHERE username = ?").get(name);
    if (exists) throw fail("USER_EXISTS", "用户名已被占用");
    const salt = randomBytes(16).toString("hex");
    const now = Date.now();
    let info;
    try {
      info = this.db
        .prepare("INSERT INTO users (username, phash, salt, created_at) VALUES (?, ?, ?, ?)")
        .run(name, hashPassword(pass, salt), salt, now);
    } catch (error) {
      // 并发注册同名用户时，唯一约束会把竞态暴露到这里，统一转成 409。
      if (/unique constraint failed:\s*users\.username/i.test(String((error && error.message) || error)))
        throw fail("USER_EXISTS", "用户名已被占用");
      throw error;
    }
    const user = { id: Number(info.lastInsertRowid), username: name };
    return { token: this.issueToken(user.id), user };
  }

  login(username, pw) {
    const name = String(username || "").trim();
    const row = this.db.prepare("SELECT id, username, phash, salt FROM users WHERE username = ?").get(name);
    if (!row) {
      // 用户不存在时也做一次等价开销的哈希，避免通过响应时间枚举用户名。
      hashPassword(String(pw || ""), "0".repeat(32));
      throw fail("UNAUTHORIZED", "用户名或密码错误");
    }
    if (!safeEqualHex(row.phash, hashPassword(String(pw || ""), row.salt)))
      throw fail("UNAUTHORIZED", "用户名或密码错误");
    const user = { id: Number(row.id), username: row.username };
    return { token: this.issueToken(user.id), user };
  }

  issueToken(userId) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db.prepare("INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, userId, now, now + TOKEN_TTL);
    return token;
  }

  auth(token) {
    const t = String(token || "").trim();
    if (!t) return null;
    const row = this.db
      .prepare("SELECT u.id, u.username, t.expires_at FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?")
      .get(t);
    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) {
      this.db.prepare("DELETE FROM auth_tokens WHERE token = ?").run(t);
      return null;
    }
    return { id: Number(row.id), username: row.username, token: t };
  }

  logout(token) {
    const t = String(token || "").trim();
    if (t) this.db.prepare("DELETE FROM auth_tokens WHERE token = ?").run(t);
    return { ok: true };
  }

  // ---- 观看历史 ----
  listHistory(userId, limit = 100) {
    const rows = this.db
      .prepare("SELECT * FROM history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(userId, Math.min(200, Math.max(1, Math.floor(Number(limit) || 100))));
    return rows.map((r) => ({
      source: r.source, id: r.vod_id, title: r.title, cover: r.cover,
      lineIdx: r.line_idx, lineName: r.line_name, epIdx: r.ep_idx, epName: r.ep_name,
      pos: r.pos, dur: r.dur, at: r.updated_at,
    }));
  }

  putHistory(userId, item) {
    const source = str(item.source, 64);
    const vodId = str(item.id, 128);
    if (!vodId) throw fail("BAD_INPUT", "缺少剧集 id");
    // 允许客户端上报的 at 略早于服务端，但不接受未来时间，避免提前占位。
    const at = Math.min(Date.now() + 5 * 60 * 1000, Math.max(0, Math.floor(num(item.at, Date.now()))) || Date.now());
    const lineIdx = Math.max(0, Math.floor(num(item.lineIdx)));
    const epIdx = Math.max(0, Math.floor(num(item.epIdx)));
    const pos = Math.max(0, num(item.pos));
    const dur = Math.max(0, num(item.dur));
    this.db.prepare(
      `INSERT INTO history (user_id, source, vod_id, title, cover, line_idx, line_name, ep_idx, ep_name, pos, dur, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, source, vod_id) DO UPDATE SET
         title=excluded.title, cover=excluded.cover, line_idx=excluded.line_idx, line_name=excluded.line_name,
         ep_idx=excluded.ep_idx, ep_name=excluded.ep_name, pos=excluded.pos, dur=excluded.dur, updated_at=excluded.updated_at
       WHERE excluded.updated_at >= history.updated_at`,
    ).run(userId, source, vodId, str(item.title), str(item.cover, 500), lineIdx, str(item.lineName),
      epIdx, str(item.epName), pos, dur, at);
    return { ok: true };
  }

  deleteHistory(userId, source, vodId) {
    this.db.prepare("DELETE FROM history WHERE user_id = ? AND source = ? AND vod_id = ?").run(userId, str(source, 64), str(vodId, 128));
    return { ok: true };
  }

  clearHistory(userId) {
    this.db.prepare("DELETE FROM history WHERE user_id = ?").run(userId);
    return { ok: true };
  }

  // ---- 收藏 ----
  listFavorites(userId) {
    return this.db.prepare("SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC").all(userId).map((r) => ({
      source: r.source, id: r.vod_id, title: r.title, cover: r.cover, remarks: r.remarks, at: r.created_at,
    }));
  }

  addFavorite(userId, item) {
    const vodId = str(item.id, 128);
    if (!vodId) throw fail("BAD_INPUT", "缺少剧集 id");
    this.db.prepare(
      `INSERT INTO favorites (user_id, source, vod_id, title, cover, remarks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, source, vod_id) DO UPDATE SET title=excluded.title, cover=excluded.cover, remarks=excluded.remarks`,
    ).run(userId, str(item.source, 64), vodId, str(item.title), str(item.cover, 500), str(item.remarks), Date.now());
    return { ok: true };
  }

  removeFavorite(userId, source, vodId) {
    this.db.prepare("DELETE FROM favorites WHERE user_id = ? AND source = ? AND vod_id = ?").run(userId, str(source, 64), str(vodId, 128));
    return { ok: true };
  }

  // ---- 追剧（更新提醒） ----
  listFollows(userId) {
    return this.db.prepare("SELECT * FROM follows WHERE user_id = ? ORDER BY created_at DESC").all(userId).map((r) => ({
      source: r.source, id: r.vod_id, title: r.title, cover: r.cover,
      epCount: Number(r.ep_count), lastChecked: Number(r.last_checked), at: r.created_at,
    }));
  }

  addFollow(userId, item) {
    const vodId = str(item.id, 128);
    if (!vodId) throw fail("BAD_INPUT", "缺少剧集 id");
    this.db.prepare(
      `INSERT INTO follows (user_id, source, vod_id, title, cover, ep_count, last_checked, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)
       ON CONFLICT(user_id, source, vod_id) DO UPDATE SET title=excluded.title, cover=excluded.cover`,
    ).run(userId, str(item.source, 64), vodId, str(item.title), str(item.cover, 500), Date.now());
    return { ok: true };
  }

  removeFollow(userId, source, vodId) {
    this.db.prepare("DELETE FROM follows WHERE user_id = ? AND source = ? AND vod_id = ?").run(userId, str(source, 64), str(vodId, 128));
    return { ok: true };
  }

  touchFollow(userId, source, vodId, epCount) {
    this.db.prepare("UPDATE follows SET ep_count = ?, last_checked = ? WHERE user_id = ? AND source = ? AND vod_id = ?")
      .run(Math.max(0, Math.floor(epCount)), Date.now(), userId, str(source, 64), str(vodId, 128));
  }
}
