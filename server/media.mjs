import { Readable } from "node:stream";
import { fail } from "./errors.mjs";
import { assertPublicUrl } from "./net.mjs";

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
  assertPublicUrl(url, "不允许代理内网地址（如确需内网媒体服务器，设置 ALLOW_PRIVATE_MEDIA=1）");
  const userAgent = cleanUa(ua);
  const headers = upstreamHeaders(referer, userAgent ? { "user-agent": userAgent } : null);
  if (req.headers.range) headers.range = req.headers.range;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let upstream;
  try {
    upstream = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
  } catch (error) {
    throw fail(error && error.name === "AbortError" ? "TIMEOUT" : "UPSTREAM", "媒体上游请求失败");
  } finally {
    clearTimeout(timer);
  }
  // redirect: follow 可能跳到内网，必须在拿到最终 URL 后再校验一次。
  assertPublicUrl(upstream.url || url, "媒体上游跳转到了内网地址");

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
  body.on("error", () => res.destroy());
  res.on("close", () => body.destroy());
  body.pipe(res);
}

// HLS 清单重写：把分片与子清单全部改成本站代理地址。
// token 用于在开了访问口令时把鉴权参数带到后续分片请求（浏览器媒体请求无法带 Authorization 头）。
export async function proxyHls(req, res, { url, referer, token, ua }) {
  assertPublicUrl(url, "不允许代理内网地址（如确需内网媒体服务器，设置 ALLOW_PRIVATE_MEDIA=1）");
  const userAgent = cleanUa(ua);
  let upstream;
  try {
    upstream = await fetch(url, {
      headers: upstreamHeaders(referer, userAgent ? { "user-agent": userAgent } : null),
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw fail(error && (error.name === "AbortError" || error.name === "TimeoutError") ? "TIMEOUT" : "UPSTREAM", "清单拉取失败");
  }
  assertPublicUrl(upstream.url || url, "清单上游跳转到了内网地址");
  if (!upstream.ok) throw fail("UPSTREAM", "清单拉取失败: HTTP " + upstream.status);

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
