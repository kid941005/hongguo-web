import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fail, statusOf, publicMessage, headersOf } from "./errors.mjs";
import { createStaticHandler } from "./static.mjs";
import { createStreamHandler } from "./stream.mjs";
import { serveTranscodePlaylist, serveTranscodeFile, hlsTranscodeStats } from "./hls-tc.mjs";
import { transcodeStats } from "./transcode.mjs";
import { proxyMedia, proxyHls } from "./media.mjs";
import { isPrivateHost } from "./net.mjs";

const MAX_BODY = 3 * 1024 * 1024;
const MAX_PAGE_PARAM = 500; // 分页参数上限（与 catalog 的 MAX_PAGE=20 翻页硬上限不是一回事）

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
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw fail("BAD_JSON", "请求体不是合法 JSON");
  }
  // 所有写接口的 body 都按对象读取（body.xxx）。JSON 的 null/数组/标量也能解析成功，
  // 放行后会在各处抛 TypeError 变成 500，这里统一按格式错误处理。
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("BAD_JSON", "请求体必须是 JSON 对象");
  return value;
}

function pageOf(q) {
  const page = Number(q.get("page") || 1);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE_PARAM) throw fail("BAD_INPUT", "分页参数无效（1–" + MAX_PAGE_PARAM + "）");
  return page;
}

function requireToken(req, token, url) {
  const expected = Buffer.from("Bearer " + token);
  const candidates = [req.headers.authorization || ""];
  // 查询参数鉴权只为「浏览器媒体请求带不了自定义头」这条路径存在：
  // at 是前端自己的参数名，token 仅作老链接兼容（两者都不再被当作上游 token 转发）。
  const queryToken = url && (url.searchParams.get("at") || url.searchParams.get("token"));
  if (queryToken) candidates.push("Bearer " + queryToken);
  const ok = candidates.some((value) => {
    const actual = Buffer.from(value);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  // 用独立业务码：前端据此弹「访问口令」输入框（PWA 无地址栏，只能靠界面填）。
  if (!ok) throw fail("TOKEN_REQUIRED", "服务访问口令不正确");
}

// 未设 TOKEN 的部署（本机自用最常见）不能让管理接口裸奔到公网：
// 源导入会把脚本送进 vm 执行，等价于「谁能调谁就能跑代码」，因此这类写操作
// 只允许内网/回环来源。Docker 端口映射后容器看到的对端是网桥地址（私有），不受影响。
//
// 例外：POST /api/sources/active 只是「选择当前源」（顶栏下拉框的普通操作），不执行任何
// 脚本，因此不算管理写——否则未设 TOKEN 的公网反代部署下，前端一切源就被 403 拦掉。
// 源导入/删除/更新/自检/日志这些会跑代码或改源包的接口仍然只对内网开放。
const ADMIN_WRITE = [/^\/api\/sources(?!\/active$)(?:\/|$)/, /^\/api\/cache\/clear$/, /^\/api\/alerts\/check$/];

function isAdminWrite(pathname) {
  return ADMIN_WRITE.some((pattern) => pattern.test(pathname));
}

function badMethod(allowed) {
  const error = fail("BAD_METHOD", "Method not allowed");
  error.allow = Array.from(allowed).join(", ");
  return error;
}

// 认证接口的内存滑动窗口限流：默认每个 IP 每分钟 10 次，降低口令爆破风险。
const RATE_WINDOW = 60 * 1000;
const RATE_MAX = 10;
const rateBuckets = new Map();
// 放在反向代理/网关后面时，remoteAddress 永远是代理地址，所有用户会挤进同一个
// 限流桶（一个人试错就把全站锁住）。X-Forwarded-For 可以被任意伪造，所以默认不采信，
// 只有部署者显式设置 TRUST_PROXY=1 才取第一跳。
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ""));
function clientIp(req) {
  if (TRUST_PROXY) {
    const first = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}
function rateLimit(req) {
  const ip = clientIp(req);
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

// force=1 会对「全部追剧」立刻打上游（4 路并发），没有冷却就是一个按钮打挂上游；
// 单次检查的条目也必须有上限，否则追剧几百部时一次请求要跑几分钟。
const FORCE_COOLDOWN_MS = 60 * 1000;
const FOLLOW_DUE_MAX = 20;

export function createServer({ provider, sources, catalog, users = null, monitor = null, recommend = null, webDir, token = "", version = "0.0.0", maxStreams = 6 }) {
  const forceCheckedAt = new Map();
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
        // 只暴露「要不要口令」，不暴露口令本身；前端据此在启动时决定是否弹口令框。
        tokenRequired: Boolean(token),
      })],

    ["GET", /^\/api\/metrics$/, ({ json }) =>
      json(200, {
        uptime: Math.round(process.uptime()),
        rss: process.memoryUsage().rss,
        ...(typeof provider.metrics === "function" ? provider.metrics() : {}),
        ...(typeof serveStream.dedupe === "function" ? { dedupe: serveStream.dedupe() } : {}),
        transcode: transcodeStats(),
        hlsTranscode: hlsTranscodeStats(),
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
    ["DELETE", /^\/api\/me\/history\/([^/]*)\/([^/]+)$/, (ctx) => {
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
    ["DELETE", /^\/api\/me\/favorites\/([^/]*)\/([^/]+)$/, (ctx) => {
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
    ["DELETE", /^\/api\/me\/follows\/([^/]*)\/([^/]+)$/, (ctx) => {
      const u = requireUser(ctx);
      return ctx.json(200, users.removeFollow(u.id, decode(ctx.params[0]), decode(ctx.params[1])));
    }],
    // 检查追更：默认 10 分钟节流，?force=1 强制立即检查
    ["GET", /^\/api\/me\/follows\/updates$/, async (ctx) => {
      const u = requireUser(ctx);
      const force = ctx.q.get("force") === "1";
      const now = Date.now();
      if (force) {
        const last = forceCheckedAt.get(u.id) || 0;
        if (now - last < FORCE_COOLDOWN_MS) {
          const error = fail("RATE_LIMITED", "追更检查过于频繁，请稍后再试");
          error.retryAfter = Math.ceil((FORCE_COOLDOWN_MS - (now - last)) / 1000);
          throw error;
        }
        forceCheckedAt.set(u.id, now);
      }
      const follows = users.listFollows(u.id);
      // 到期检查按「最久没查过的先查」，超出上限的留到下一轮，避免单请求超时。
      const due = follows
        .filter((fo) => force || !fo.lastChecked || now - fo.lastChecked >= 10 * 60 * 1000)
        .sort((a, b) => (a.lastChecked || 0) - (b.lastChecked || 0))
        .slice(0, FOLLOW_DUE_MAX);
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
            count = 0;
          }
          if (count > 0) {
            if (fo.epCount > 0 && count > fo.epCount) {
              updates.push({ source: fo.source, id: fo.id, title: fo.title, cover: fo.cover, epCount: count, prevCount: fo.epCount, added: count - fo.epCount });
            }
            users.touchFollow(u.id, fo.source, fo.id, count);
          } else {
            // 上游失败或详情为空也记一次检查时间，否则这个条目每次请求都会重打同一个上游。
            users.markFollowChecked(u.id, fo.source, fo.id);
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
      // st 是「源自己在上游地址里声明的 token」，会原样带给上游 CDN；
      // at 是本站访问口令，只出现在重写后的本站地址上（上游地址整体作为 u 参数编码，
      // 口令不会进入上游请求），用于让 hls.js 后续的分片/子清单请求也能通过鉴权。
      await proxyHls(req, res, {
        url: target,
        referer: q.get("r") || "",
        token: q.get("st") || "",
        auth: q.get("at") || q.get("token") || "",
        ua: q.get("ua") || "",
      });
    }],

    // ---- 内置红果：服务端解密流 ----
    ["GET", /^\/api\/stream\/(\d{1,30}|v1_[A-Za-z0-9_-]{20,40})$/, async ({ req, res, params, q }) => {
      return serveStream(req, res, params[0], q.get("q") || "auto", q.get("vvc") === "1");
    }],

    // ---- 内置红果：VVC 档位的服务端 HLS 转码（可拖动进度）----
    // 清单里写的是绝对路径分片地址；带访问口令的部署要把 at 一路带到分片请求上，
    // 否则 hls.js 请求分片时没有口令，全部 401。
    ["GET", /^\/api\/tc\/(\d{1,30})\/([^/]+)\/index\.m3u8$/, async ({ req, res, params, url }) => {
      const at = url.searchParams.get("at");
      await serveTranscodePlaylist({
        provider,
        epId: params[0],
        quality: decode(params[1]),
        req,
        res,
        logger: (entry) => console.log(JSON.stringify(entry)),
        authSuffix: at ? "?at=" + encodeURIComponent(at) : "",
      });
    }],
    ["GET", /^\/api\/tc\/(\d{1,30})\/([^/]+)\/([^/]+)$/, async ({ req, res, params }) => {
      await serveTranscodeFile({
        epId: params[0],
        quality: decode(params[1]),
        file: decode(params[2]),
        req,
        res,
        logger: (entry) => console.log(JSON.stringify(entry)),
      });
    }],
  ];

  async function dispatch(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const json = (status, value) => sendJson(res, status, value);
    const ctx = { req, res, url, q: url.searchParams, json, params: [] };

    if (token && url.pathname.startsWith("/api/")) requireToken(req, token, url);

    // 没有口令时，管理写接口与 /api/metrics 只对内网开放（见 ADMIN_WRITE 注释）。
    // 反代部署下 remoteAddress 恒为代理私网地址，不能据此判内网：未声明信任代理却带
    // X-Forwarded-For 的请求一律按外网处理，避免「公网经反代调用管理接口」。
    if (!token && url.pathname.startsWith("/api/")) {
      const isWrite = !["GET", "HEAD"].includes(req.method) && isAdminWrite(url.pathname);
      const isSensitiveRead = url.pathname === "/api/metrics";
      if (isWrite || isSensitiveRead) {
        // 未声明信任代理却带 X-Forwarded-For：无法判定真实来源，直接按外网处理。
        // 注意不能把 ip 置空再交给 isPrivateHost —— 空主机名会被判为内网，等于放行。
        if (!TRUST_PROXY && req.headers["x-forwarded-for"]) {
          throw fail("PROTECTED", "对外网开放的管理接口需要先设置 TOKEN 环境变量");
        }
        if (!isPrivateHost(clientIp(req))) {
          throw fail("PROTECTED", "对外网开放的管理接口需要先设置 TOKEN 环境变量");
        }
      }
    }

    let pathMatched = false;
    const allowed = new Set();
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (method === "GET") {
        allowed.add("GET");
        allowed.add("HEAD");
      } else {
        allowed.add(method);
      }
      // HEAD 视作 GET（Node 会自动丢弃响应体）
      if (method !== req.method && !(method === "GET" && req.method === "HEAD")) continue;
      ctx.params = match.slice(1);
      return handler(ctx);
    }
    if (pathMatched) throw badMethod(allowed);
    if (url.pathname.startsWith("/api/")) throw fail("NOT_FOUND", "接口不存在");
    if (!["GET", "HEAD"].includes(req.method)) throw badMethod(["GET", "HEAD"]);
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
        let failedPath = req.url || "/";
        try { failedPath = new URL(failedPath, "http://localhost").pathname; } catch { /* 非法 URL 原样记 */ }
        console.error(JSON.stringify({ event: "request_failed", path: failedPath, message: String((error && error.message) || error) }));
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
