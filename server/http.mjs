import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fail, statusOf, publicMessage, headersOf } from "./errors.mjs";
import { createStaticHandler } from "./static.mjs";
import { createStreamHandler } from "./stream.mjs";
import { transcodeToResponse, transcodeStats } from "./transcode.mjs";
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
    let settled = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        // 不立刻 destroy：先把响应写回客户端，再放弃后续数据，否则客户端只会收到连接重置。
        settled = true;
        chunks.length = 0;
        reject(fail("TOO_BIG", "请求体过大"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
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

function requireToken(req, token, url) {
  const expected = Buffer.from("Bearer " + token);
  const candidates = [req.headers.authorization || ""];
  const queryToken = url && url.searchParams.get("token");
  if (queryToken) candidates.push("Bearer " + queryToken);
  const ok = candidates.some((value) => {
    const actual = Buffer.from(value);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  if (!ok) throw fail("UNAUTHORIZED", "服务访问口令不正确");
}

// 认证接口的内存滑动窗口限流：默认每个 IP 每分钟 10 次，降低口令爆破风险。
const RATE_WINDOW = 60 * 1000;
const RATE_MAX = 10;
const rateBuckets = new Map();
function rateLimit(req) {
  const ip = (req.socket && req.socket.remoteAddress) || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start >= RATE_WINDOW) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX) {
    const error = fail("RATE_LIMITED", "尝试过于频繁，请稍后再试");
    error.retryAfter = Math.ceil((bucket.start + RATE_WINDOW - now) / 1000);
    throw error;
  }
  if (rateBuckets.size > 10000) {
    for (const [key, value] of rateBuckets) if (now - value.start >= RATE_WINDOW) rateBuckets.delete(key);
  }
}

export function createServer({ provider, sources, catalog, users = null, monitor = null, recommend = null, webDir, token = "", version = "0.0.0", maxStreams = 6 }) {
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

    ["GET", /^\/api\/metrics$/, ({ json }) =>
      json(200, {
        uptime: Math.round(process.uptime()),
        rss: process.memoryUsage().rss,
        ...(typeof provider.metrics === "function" ? provider.metrics() : {}),
        ...(typeof serveStream.dedupe === "function" ? { dedupe: serveStream.dedupe() } : {}),
        transcode: transcodeStats(),
        playback: monitor ? monitor.snapshot() : null,
      })],

    // ---- 运维：一键清缓存 ----
    // 上游风控/签名变化时的第一步动作：清掉首页 SWR、推荐池、vendor 四层缓存与播放模型缓存。
    // 鉴权沿用全局 TOKEN（dispatch 里对 /api/ 已统一校验），未设 TOKEN 的部署即本机自用。
    ["POST", /^\/api\/cache\/clear$/, ({ json }) => {
      const cleared = {
        catalog: typeof catalog.clearCache === "function" ? catalog.clearCache() : null,
        provider: typeof provider.clearCache === "function" ? provider.clearCache() : null,
      };
      console.log(JSON.stringify({ event: "cache_clear", cleared }));
      return json(200, { ok: true, cleared });
    }],

    // ---- 播放通道监控告警 ----
    ["GET", /^\/api\/alerts$/, ({ json }) =>
      json(200, monitor ? monitor.snapshot() : { enabled: false, status: "disabled", alerts: [] })],
    ["POST", /^\/api\/alerts\/check$/, async ({ json }) => {
      if (!monitor) throw fail("NOT_FOUND", "播放监控未启用");
      return json(200, await monitor.checkNow());
    }],

    // ---- 账号（注册 / 登录 / 会话） ----
    ["POST", /^\/api\/auth\/register$/, async (ctx) => {
      if (!users) throw fail("NOT_FOUND", "账号系统未启用");
      rateLimit(ctx.req);
      const body = parseJsonBody(await readBody(ctx.req));
      return ctx.json(200, users.register(body.username, body.password));
    }],
    ["POST", /^\/api\/auth\/login$/, async (ctx) => {
      if (!users) throw fail("NOT_FOUND", "账号系统未启用");
      rateLimit(ctx.req);
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
      const limit = Math.min(200, Math.max(1, Math.floor(Number(ctx.q.get("limit") || 100) || 100)));
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
      const follows = users.listFollows(u.id);
      const due = follows.filter((fo) => force || !fo.lastChecked || now - fo.lastChecked >= 10 * 60 * 1000);
      const updates = [];
      let cursor = 0;
      // 最多 4 路并发，避免追剧多时逐个串行拖到超时。
      const worker = async () => {
        while (cursor < due.length) {
          const fo = due[cursor++];
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
      };
      await Promise.all(Array.from({ length: Math.min(4, due.length) }, () => worker()));
      return ctx.json(200, { updates, follows: users.listFollows(u.id) });
    }],

    // ---- 我的数据：偏好设置（播放倍速，跨设备同步） ----
    ["GET", /^\/api\/me\/prefs$/, (ctx) => ctx.json(200, { prefs: users.getPrefs(requireUser(ctx).id) })],
    ["PUT", /^\/api\/me\/prefs$/, async (ctx) => {
      const u = requireUser(ctx);
      const body = parseJsonBody(await readBody(ctx.req));
      return ctx.json(200, { ok: true, prefs: users.setPrefs(u.id, body) });
    }],

    // ---- 猜你喜欢（基于观看历史的推荐；登录用服务端历史，未登录用本地历史兜底） ----
    ["POST", /^\/api\/for-you$/, async (ctx) => {
      if (!recommend) throw fail("NOT_FOUND", "推荐服务未启用");
      const body = parseJsonBody(await readBody(ctx.req));
      const user = currentUser(ctx);
      return ctx.json(200, await recommend.forYou({ user, seeds: body.seeds }));
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
    ["POST", /^\/api\/sources\/check-updates$/, async ({ json, req }) => {
      const body = parseJsonBody(await readBody(req));
      const results = await sources.checkAllUpdates({ force: body.force !== false });
      return json(200, { ok: true, results, sources: sources.list() });
    }],
    ["POST", /^\/api\/sources\/([\w.\-]+)\/check-update$/, async ({ json, params }) => {
      const result = await sources.checkUpdate(params[0], { force: true });
      return json(200, { ok: true, result, sources: sources.list() });
    }],
    ["POST", /^\/api\/sources\/([\w.\-]+)\/auto-update$/, async ({ json, params, req }) => {
      const body = parseJsonBody(await readBody(req));
      return json(200, { ok: true, ...sources.setAutoUpdate(params[0], Boolean(body.enabled)) });
    }],
    ["GET", /^\/api\/sources\/([\w.\-]+)\/log$/, ({ json, params }) =>
      json(200, { id: params[0], log: sources.logs(params[0]) })],
    ["GET", /^\/api\/sources\/([\w.\-]+)\/health$/, async ({ json, params, q }) =>
      json(200, await catalog.health(params[0], { deep: q.get("deep") === "1" }))],
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
      const rawExtend = q.get("extend");
      if (rawExtend) {
        if (rawExtend.length > 2000) throw fail("BAD_INPUT", "分类筛选参数过长");
        extend = parseJsonBody(rawExtend);
      }
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
    // 播放降级：当前源播放失败时，按剧名到其它源找同一部剧
    ["GET", /^\/api\/play\/fallback$/, async ({ json, q }) => {
      const id = (q.get("id") || "").trim();
      if (!id) throw fail("BAD_INPUT", "缺少剧 id");
      const index = Number(q.get("index") || 0);
      return json(200, await catalog.playFallback(q.get("source") || undefined, {
        id,
        index: Number.isFinite(index) ? index : 0,
      }));
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
      await proxyMedia(req, res, { url: target, referer: q.get("r") || "", ua: q.get("ua") || "" });
    }],
    ["GET", /^\/api\/hls$/, async ({ req, res, q }) => {
      const target = q.get("u");
      if (!target) throw fail("BAD_INPUT", "缺少 u");
      const accessToken = q.get("token") || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      await proxyHls(req, res, { url: target, referer: q.get("r") || "", token: accessToken, ua: q.get("ua") || "" });
    }],

    // ---- 内置红果：服务端解密流 ----
    ["GET", /^\/api\/stream\/(\d{1,30})$/, async ({ req, res, params, q }) => {
      // tc=1：该档是 H.266/VVC，交给服务端 ffmpeg 转成 H.264（浏览器没有 VVC 解码器）。
      if (q.get("tc") === "1")
        return transcodeToResponse({
          provider,
          epId: params[0],
          quality: q.get("q") || "auto",
          req,
          res,
          logger: (entry) => console.log(JSON.stringify(entry)),
        });
      return serveStream(req, res, params[0], q.get("q") || "auto", q.get("vvc") === "1");
    }],
  ];

  async function dispatch(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const json = (status, value) => sendJson(res, status, value);
    const ctx = { req, res, url, q: url.searchParams, json, params: [] };

    if (token && url.pathname.startsWith("/api/")) requireToken(req, token, url);

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
    // 浏览器即使页面已声明 data: 图标仍会固定请求 /favicon.ico，这里用 PWA 图标兜底，避免每次刷新多一条 404。
    if (url.pathname === "/favicon.ico") return serveStatic(req, res, "/icons/icon-192.png");
    return serveStatic(req, res, url.pathname);
  }

  return http.createServer((req, res) => {
    const startedAt = Date.now();
    // 访问日志：只记 API 与失败的静态请求。一个页面几十个静态资源，全记会把日志刷爆，
    // 而 4xx/5xx 的静态请求（缺文件、路径拼错）恰恰是最需要看到的。
    res.on("finish", () => {
      let pathname = req.url || "/";
      try { pathname = new URL(pathname, "http://localhost").pathname; } catch { /* 非法 URL 原样记 */ }
      const isApi = pathname.startsWith("/api/");
      if (!isApi && res.statusCode < 400) return;
      console.log(JSON.stringify({
        event: "access",
        method: req.method,
        path: pathname,
        status: res.statusCode,
        ms: Date.now() - startedAt,
      }));
    });
    // 统一安全响应头（静态页、媒体、流也覆盖）。
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    dispatch(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (!error || !error.code) {
        console.error(JSON.stringify({ event: "request_failed", path: req.url, message: String((error && error.message) || error) }));
      }
      const code = (error && error.code) || "UPSTREAM_ERROR";
      sendJson(
        res,
        statusOf(code),
        { error: publicMessage(error), code },
        headersOf(code, error)
      );
    });
  });
}
