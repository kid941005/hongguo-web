import { Readable } from "node:stream";
import { fail } from "./errors.mjs";
import { safeFetch } from "./net.mjs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function cleanUa(value) {
  return String(value || "").replace(/[\r\n]/g, "").trim().slice(0, 300);
}

function upstreamHeaders(referer, extra) {
  const headers = { "user-agent": UA, ...(extra || {}) };
  if (referer) {
    headers.referer = referer;
    try { headers.origin = new URL(referer).origin; } catch { /* referer 不是合法 URL 就不带 origin */ }
  }
  return headers;
}

// 浏览器习惯用开放式 Range（bytes=0-）要整段，但部分上游 CDN（如西饭的 dj.youlishipin.com）
// 对无上界的 Range 会直接挂起不响应，客户端等到超时变 502。这里统一归一化成有界块，
// 浏览器拿到 content-range 后会自然续发下一段，行为与整段响应一致。
const RANGE_CHUNK = 2 * 1024 * 1024;

function boundRange(value) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(value || "").trim());
  if (!m || m[2]) return value;
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start)) return value;
  return "bytes=" + start + "-" + (start + RANGE_CHUNK - 1);
}

// 图片代理失败时回内置占位图（200）而不是错误码：
// 海报上游 403（如牛牛的图床）经代理变成 502 后，浏览器里是整屏破图 + 控制台一片红；
// 回一张灰底占位图，用户看到的只是「这张海报没有」，页面其余部分照常。
const FALLBACK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320" viewBox="0 0 240 320">' +
  '<rect width="240" height="320" fill="#1b1b22"/>' +
  '<rect x="60" y="130" width="120" height="8" rx="4" fill="#33333d"/>' +
  '<rect x="80" y="152" width="80" height="8" rx="4" fill="#2a2a33"/>' +
  '<text x="120" y="196" font-family="sans-serif" font-size="16" fill="#4a4a57" text-anchor="middle">暂无海报</text>' +
  "</svg>";

const IMAGE_PATH = /\.(?:jpe?g|png|webp|gif|avif|bmp|ico)$/i;

// 是不是图片请求：先看 Accept（<img> 会带 image/*），再看路径后缀（部分源用无后缀的图床地址）。
function wantsImage(req, url) {
  const accept = String(req.headers.accept || "");
  if (/image\//i.test(accept)) return true;
  try {
    return IMAGE_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function sendFallbackImage(res, reason) {
  const body = Buffer.from(FALLBACK_SVG);
  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "content-length": body.length,
    // 短缓存：上游恢复后一分钟内就能换回真海报，不会一直占位。
    "cache-control": "public, max-age=60",
    "access-control-allow-origin": "*",
    "x-media-fallback": String(reason || "error").slice(0, 40),
  });
  res.end(body);
}

// 透传 Range 的视频代理：浏览器只连本站，避免 CORS 与防盗链。
export async function proxyMedia(req, res, { url, referer, ua }) {
  const image = wantsImage(req, url);
  const userAgent = cleanUa(ua);
  const headers = upstreamHeaders(referer, userAgent ? { "user-agent": userAgent } : null);
  if (req.headers.range) headers.range = boundRange(req.headers.range);

  let upstream;
  try {
    // safeFetch 对每次连接和每次重定向都做 DNS 校验，并把连接固定到已校验的地址。
    upstream = await safeFetch(url, {
      headers,
      redirect: "follow",
      timeoutMs: 20000,
      message: "不允许代理内网地址（如确需内网媒体服务器，设置 ALLOW_PRIVATE_MEDIA=1）",
    });
  } catch (error) {
    if (error && error.code === "BAD_URL") throw error;
    // 图片请求连不上上游时回占位图，别让整排海报因为一个图床挂掉而全红。
    if (image) return sendFallbackImage(res, "error");
    throw fail(error && error.code === "TIMEOUT" ? "TIMEOUT" : "UPSTREAM", "媒体上游请求失败");
  }

  // 上游 4xx/5xx（416 除外）不是可透传的媒体内容，直接按代理失败处理，避免浏览器把错误页当视频。
  if (!upstream.ok && upstream.status !== 416) {
    try { upstream.discard(); } catch {}
    if (image) return sendFallbackImage(res, "http-" + upstream.status);
    throw fail("UPSTREAM", "媒体上游返回 HTTP " + upstream.status);
  }

  const out = {};
  for (const key of ["content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(key);
    if (value) out[key] = value;
  }
  if (!out["accept-ranges"]) out["accept-ranges"] = "bytes";
  out["cache-control"] = "public, max-age=1800";
  out["access-control-allow-origin"] = "*";
  res.writeHead(upstream.status, out);
  if (req.method === "HEAD" || !upstream.body) return res.end();

  const body = Readable.fromWeb(upstream.body);
  // 上游只回了响应头却不再吐数据时，20 秒空闲就断开，别让连接与播放槽位永久挂住。
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => body.destroy(new Error("媒体上游读取超时")), 20000);
    if (idleTimer.unref) idleTimer.unref();
  };
  armIdle();
  body.on("data", armIdle);
  body.on("end", () => { if (idleTimer) clearTimeout(idleTimer); });
  body.on("error", () => { if (idleTimer) clearTimeout(idleTimer); res.destroy(); });
  res.on("close", () => { if (idleTimer) clearTimeout(idleTimer); body.destroy(); });
  body.pipe(res);
}

// HLS 清单重写：把分片与子清单全部改成本站代理地址。
// token 用于在开了访问口令时把鉴权参数带到后续分片请求（浏览器媒体请求无法带 Authorization 头）。
//
// 判定子清单不能只看 URL 里有没有 "m3u8"：EXT-X-KEY 的 URI 是密钥、EXT-X-MAP 的 URI 是 init 段，
// 即使地址里带 m3u8 字样也必须当媒体代理。这里按标签语义分三类：
//   manifest —— EXT-X-STREAM-INF 的下一行，一定是子清单
//   media    —— 密钥 / init 段 / fMP4 part / preload hint，一定是二进制
//   auto     —— 其它（EXT-X-MEDIA、I-FRAME-STREAM-INF 等），按路径后缀判断
const MEDIA_URI_TAGS = /^#EXT-X-(?:KEY|SESSION-KEY|MAP|PART|PRELOAD-HINT):/i;

function classifyManifest(abs, hint) {
  if (hint === "manifest") return true;
  if (hint === "media") return false;
  try {
    return /\.m3u8?$/i.test(new URL(abs).pathname);
  } catch {
    return false;
  }
}

export async function proxyHls(req, res, { url, referer, token, ua }) {
  const userAgent = cleanUa(ua);
  let upstream;
  try {
    upstream = await safeFetch(url, {
      headers: upstreamHeaders(referer, userAgent ? { "user-agent": userAgent } : null),
      redirect: "follow",
      timeoutMs: 15000,
      message: "不允许代理内网地址（如确需内网媒体服务器，设置 ALLOW_PRIVATE_MEDIA=1）",
    });
  } catch (error) {
    if (error && error.code === "BAD_URL") throw error;
    throw fail(error && error.code === "TIMEOUT" ? "TIMEOUT" : "UPSTREAM", "清单拉取失败");
  }
  if (!upstream.ok) {
    upstream.discard();
    throw fail("UPSTREAM", "清单拉取失败: HTTP " + upstream.status);
  }

  const base = upstream.url || url;
  const text = await upstream.text();
  // 上游把错误页（HTML/JSON）当清单返回时直接报错，别重写后喂给播放器。
  if (!/^\uFEFF?\s*#EXTM3U/.test(text)) {
    throw fail("UPSTREAM", "上游返回的不是 HLS 清单");
  }

  const suffix =
    (referer ? "&r=" + encodeURIComponent(referer) : "") +
    (token ? "&token=" + encodeURIComponent(token) : "") +
    (userAgent ? "&ua=" + encodeURIComponent(userAgent) : "");
  const rewrite = (raw, hint) => {
    let abs;
    try {
      abs = new URL(raw, base).toString();
    } catch {
      return raw;
    }
    return (classifyManifest(abs, hint) ? "/api/hls?u=" : "/api/media?u=") + encodeURIComponent(abs) + suffix;
  };

  let expectVariant = false;
  const rewritten = text
    .split(/\r\n|\n|\r/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        // 变体清单的 URI 在 EXT-X-STREAM-INF 的下一行，这里只做标记。
        expectVariant = /^#EXT-X-STREAM-INF:/i.test(trimmed);
        const hint = MEDIA_URI_TAGS.test(trimmed) ? "media" : "auto";
        if (trimmed.indexOf('URI="') === -1) return line;
        return line.replace(/URI="([^"]*)"/g, (_m, u) => 'URI="' + rewrite(u, hint) + '"');
      }
      const hint = expectVariant ? "manifest" : "auto";
      expectVariant = false;
      return rewrite(trimmed, hint);
    })
    .join("\n");

  res.writeHead(200, {
    "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(rewritten);
}
