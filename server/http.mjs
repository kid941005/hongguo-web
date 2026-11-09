import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fail, statusOf, publicMessage } from "./errors.mjs";
import { createStaticHandler } from "./static.mjs";
import { createStreamHandler } from "./stream.mjs";
import { proxyMedia, proxyHls } from "./media.mjs";

const MAX_BODY = 3 * 1024 * 1024;
const MAX_PAGE = 500;

function sendJson(res, status, value, extraHeaders) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(JSON.stringify(value));
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(fail("TOO_BIG", "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJsonBody(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw fail("BAD_JSON", "请求体不是合法 JSON");
  }
}

function pageOf(q) {
  const page = Number(q.get("page") || 1);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) throw fail("BAD_INPUT", "分页参数无效（1–" + MAX_PAGE + "）");
  return page;
}

function requireToken(req, token) {
  const expected = Buffer.from("Bearer " + token);
  const actual = Buffer.from(req.headers.authorization || "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw fail("UNAUTHORIZED", "服务访问口令不正确");
}

export function createServer({ provider, sources, catalog, users = null, webDir, token = "", version = "0.0.0", maxStreams = 6 }) {
  const serveStatic = createStaticHandler(webDir);
  const serveStream = createStreamHandler({ provider, limit: maxStreams });

  function currentUser(ctx) {
    const t = ctx.req.headers["x-auth-token"];
    return users && t ? users.auth(t) : null;
  }
  function requireUser(ctx) {
    const user = currentUser(ctx);
    if (!user) throw fail("UNAUTHORIZED", "请先登录");
    return user;
  }
  function decode(v) {
    try { return decodeURIComponent(v); } catch { return v; }
  }

  // 路由表：[方法, 路径正则, 处理函数]。处理函数返回即响应完成；抛错交给统一错误层。
  const routes = [
    ["GET", /^\/health$/, ({ json }) =>
      json(200, {
        service: "hongguo-web",
        ok: true,
        version,
        active: sources.activeId,
        sources: sources.list().sources.length,
        accounts: Boolean(users),
      })],

    // ---- 账号（注册 / 登录 / 会话） ----
    ["POST", /^\/api\/auth\/register$/, async (ctx) => {
      if (!users) throw fail("NOT_FOUND", "账号系统未启用");
      const body = parseJsonBody(await readBody(ctx.req));
      return ctx.json(200, users.register(body.username, body.password));
    }],
    ["POST", /^\/api\/auth\/login$/, async (ctx) => {
      if (!users) throw fail("NOT_FOUND", "账号系统未启用");
      const body = parseJsonBody(await readBody(ctx.req));
      return ctx.json(200, users.login(body.username, body.password));
    }],
    ["POST", /^\/api\/auth\/logout$/, (ctx) => {
      if (!users) return ctx.json(200, { ok: true });
      return ctx.json(200, users.logout(String(ctx.req.headers["x-auth-token"] || "")));
    }],
    ["GET", /^\/api\/auth\/me$/, (ctx) => {
      const u = requireUser(ctx);
      return ctx.json(200, { user: { id: u.id, username: u.username } });
    }],

    // ---- 我的数据：观看历史（跨设备同步） ----
    ["GET", /^\/api\/me\/history$/, (ctx) => {
      const u = requireUser(ctx);
      const limit = Math.min(200, Math.max(1, Number(ctx.q.get("limit") || 100) || 100));
      return ctx.json(200, { items: users.listHistory(u.id, limit) });
    }],
    ["PUT", /^\/api\/me\/history$/, async (ctx) => {
      const u = requireUser(ctx);
      const body = parseJsonBody(await readBody(ctx.req));
      return ctx.json(200, users.putHistory(u.id, body));
    }],
    ["DELETE", /^\/api\/me\/history$/, (ctx) => {
      const u = requireUser(ctx);
      return ctx.json(200, users.clearHistory(u.id));
    }],
    ["DELETE", /^\/api\/me\/history\/([^/]+)\/([^/]+)$/, (ctx) => {
      const u = requireUser(ctx);
      return ctx.json(200, users.deleteHistory(u.id, decode(ctx.params[0]), decode(ctx.params[1])));
    }],

    // ---- 我的数据：收藏 ----
    ["GET", /^\/api\/me\/favorites$/, (ctx) => ctx.json(200, { items: users.listFavorites(requireUser(ctx).id) })],
    ["POST", /^\/api\/me\/favorites$/, async (ctx) => {
      const u = requireUser(ctx);
      const body = parseJsonBody(await readBody(ctx.req));
      return ctx.json(200, users.addFavorite(u.id, body));
    }],
    ["DELETE", /^\/api\/me\/favorites\/([^/]+)\/([^/]+)$/, (ctx) => {
      const u = requireUser(ctx);
      return ctx.json(200, users.removeFavorite(u.id, decode(ctx.params[0]), decode(ctx.params[1])));
    }],

    // ---- 我的数据：追剧提醒 ----
    ["GET", /^\/api\/me\/follows$/, (ctx) => ctx.json(200, { items: users.listFollows(requireUser(ctx).id) })],
    ["POST", /^\/api\/me\/follows$/, async (ctx) => {
      const u = requireUser(ctx);
      const body = parseJsonBody(await readBody(ctx.req));
      return ctx.json(200, users.addFollow(u.id, body));
    }],
    ["DELETE", /^\/api\/me\/follows\/([^/]+)\/([^/]+)$/, (ctx) => {
      const u = requireUser(ctx);
      return ctx.json(200, users.removeFollow(u.id, decode(ctx.params[0]), decode(ctx.params[1])));
    }],
    // 检查追更：默认 10 分钟节流，?force=1 强制立即检查
    ["GET", /^\/api\/me\/follows\/updates$/, async (ctx) => {
      const u = requireUser(ctx);
      const force = ctx.q.get("force") === "1";
      const now = Date.now();
      const updates = [];
      for (const fo of users.listFollows(u.id)) {
        if (!force && fo.lastChecked && now - fo.lastChecked < 10 * 60 * 1000) continue;
        let count = 0;
        try {
          const d = await catalog.detail(fo.source || undefined, fo.id);
          count = (d.episodes || []).length || ((d.lines && d.lines[0] && d.lines[0].episodes) || []).length;
        } catch {
          continue;
        }
        if (count > 0) {
          if (fo.epCount > 0 && count > fo.epCount) {
            updates.push({ source: fo.source, id: fo.id, title: fo.title, cover: fo.cover, epCount: count, prevCount: fo.epCount, added: count - fo.epCount });
          }
          users.touchFollow(u.id, fo.source, fo.id, count);
        }
      }
      return ctx.json(200, { updates, follows: users.listFollows(u.id) });
    }],

    // ---- 源管理 ----
    ["GET", /^\/api\/sources$/, ({ json }) => json(200, sources.list())],
    ["POST", /^\/api\/sources\/import$/, async ({ json, req }) => {
      const body = parseJsonBody(await readBody(req));
      const entry = await sources.install({ code: body.code, url: body.url });
      return json(200, {
        ok: true,
        source: { id: entry.id, name: entry.name, version: entry.version },
        sources: sources.list(),
      });
    }],
    ["POST", /^\/api\/sources\/active$/, async ({ json, req }) => {
      const body = parseJsonBody(await readBody(req));
      return json(200, { ok: true, ...sources.setActive(String(body.id || "")) });
    }],
    ["GET", /^\/api\/sources\/([\w.\-]+)\/log$/, ({ json, params }) =>
      json(200, { id: params[0], log: sources.logs(params[0]) })],
    ["DELETE", /^\/api\/sources\/([\w.\-]+)$/, ({ json, params }) =>
      json(200, { ok: true, ...sources.remove(params[0]) })],

    // ---- 目录 ----
    ["GET", /^\/api\/home$/, async ({ json, q }) =>
      json(200, await catalog.home(q.get("source") || undefined, pageOf(q)))],
    ["GET", /^\/api\/recommend$/, async ({ json, q }) =>
      json(200, await catalog.recommend(pageOf(q)))],
    ["GET", /^\/api\/category$/, async ({ json, q }) => {
      const tid = (q.get("tid") || "").trim();
      if (!tid) throw fail("BAD_INPUT", "缺少分类参数");
      let extend = {};
      if (q.get("extend")) extend = parseJsonBody(q.get("extend"));
      return json(200, await catalog.category(q.get("source") || undefined, tid, pageOf(q), extend));
    }],
    ["GET", /^\/api\/search$/, async ({ json, q }) => {
      const keyword = (q.get("q") || "").trim();
      if (!keyword || keyword.length > 80) throw fail("BAD_INPUT", "请输入 1–80 字的关键词");
      const page = pageOf(q);
      const source = q.get("source") || "";
      if (source === "__all" || q.get("all") === "1") return json(200, await catalog.searchAll(keyword, page));
      return json(200, await catalog.search(source || undefined, keyword, page));
    }],
    ["GET", /^\/api\/detail$/, async ({ json, q }) => {
      const id = (q.get("id") || "").trim();
      if (!id) throw fail("BAD_INPUT", "缺少 id");
      return json(200, await catalog.detail(q.get("source") || undefined, id));
    }],
    ["GET", /^\/api\/play$/, async ({ json, q }) => {
      const id = (q.get("id") || "").trim();
      if (!id) throw fail("BAD_INPUT", "缺少剧集 id");
      return json(200, await catalog.play(q.get("source") || undefined, { flag: q.get("flag") || "", id }));
    }],

    // ---- 媒体 ----
    ["GET", /^\/api\/media$/, async ({ req, res, q }) => {
      const target = q.get("u");
      if (!target) throw fail("BAD_INPUT", "缺少 u");
      await proxyMedia(req, res, { url: target, referer: q.get("r") || "" });
    }],
    ["GET", /^\/api\/hls$/, async ({ req, res, q }) => {
      const target = q.get("u");
      if (!target) throw fail("BAD_INPUT", "缺少 u");
      await proxyHls(req, res, { url: target, referer: q.get("r") || "" });
    }],

    // ---- 内置红果：服务端解密流 ----
    ["GET", /^\/api\/stream\/(\d{1,30})$/, ({ req, res, params }) => serveStream(req, res, params[0])],
  ];

  async function dispatch(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const json = (status, value) => sendJson(res, status, value);
    const ctx = { req, res, url, q: url.searchParams, json, params: [] };

    if (token && url.pathname.startsWith("/api/")) requireToken(req, token);

    let pathMatched = false;
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      // HEAD 视作 GET（Node 会自动丢弃响应体）
      if (method !== req.method && !(method === "GET" && req.method === "HEAD")) continue;
      ctx.params = match.slice(1);
      return handler(ctx);
    }
    if (pathMatched) throw fail("BAD_METHOD", "Method not allowed");
    if (url.pathname.startsWith("/api/")) throw fail("NOT_FOUND", "接口不存在");
    if (!["GET", "HEAD"].includes(req.method)) throw fail("BAD_METHOD", "Method not allowed");
    return serveStatic(req, res, url.pathname);
  }

  return http.createServer((req, res) => {
    dispatch(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (!error || !error.code) {
        console.error(JSON.stringify({ event: "request_failed", path: req.url, message: String((error && error.message) || error) }));
      }
      sendJson(res, statusOf(error && error.code), {
        error: publicMessage(error),
        code: (error && error.code) || "UPSTREAM_ERROR",
      });
    });
  });
}
