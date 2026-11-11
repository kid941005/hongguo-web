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

// 透传 Range 的视频代理：浏览器只连本站，避免 CORS 与防盗链。
export async function proxyMedia(req, res, { url, referer, ua }) {
  const userAgent = cleanUa(ua);
  const headers = upstreamHeaders(referer, userAgent ? { "user-agent": userAgent } : null);
  if (req.headers.range) headers.range = req.headers.range;

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
    throw fail(error && error.code === "TIMEOUT" ? "TIMEOUT" : "UPSTREAM", "媒体上游请求失败");
  }

  // 上游 4xx/5xx（416 除外）不是可透传的媒体内容，直接按代理失败处理，避免浏览器把错误页当视频。
  if (!upstream.ok && upstream.status !== 416) {
    try { upstream.discard(); } catch {}
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
  const suffix =
    (referer ? "&r=" + encodeURIComponent(referer) : "") +
    (token ? "&token=" + encodeURIComponent(token) : "") +
    (userAgent ? "&ua=" + encodeURIComponent(userAgent) : "");
  const rewrite = (raw) => {
    let abs;
    try {
      abs = new URL(raw, base).toString();
    } catch {
      return raw;
    }
    let isManifest = false;
    try {
      const pathname = new URL(abs).pathname;
      isManifest = /\.m3u8$/i.test(pathname) || /m3u8/i.test(pathname);
    } catch { /* 解析失败按分片处理 */ }
    return (isManifest ? "/api/hls?u=" : "/api/media?u=") + encodeURIComponent(abs) + suffix;
  };

  const rewritten = text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) return line.replace(/URI="([^"]*)"/g, (_m, u) => 'URI="' + rewrite(u) + '"');
      return rewrite(trimmed);
    })
    .join("\n");

  res.writeHead(200, {
    "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(rewritten);
}
