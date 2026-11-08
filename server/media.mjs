import { Readable } from "node:stream";
import { fail } from "./errors.mjs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// 默认禁止把代理当内网跳板；确有内网媒体服务器时用 ALLOW_PRIVATE_MEDIA=1 放行。
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_MEDIA === "1";
const PRIVATE_HOST = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/i,
  /^\[::1\]$/i,
  /\.local$/i,
  /\.internal$/i,
];

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (PRIVATE_HOST.some((re) => re.test(host))) return true;
  const m = /^172\.(\d{1,3})\./.exec(host);
  return Boolean(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}

function assertFetchable(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw fail("BAD_URL", "地址无效");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw fail("BAD_URL", "仅支持 http(s) 地址");
  if (!ALLOW_PRIVATE && isPrivateHost(parsed.hostname))
    throw fail("BAD_URL", "不允许代理内网地址（如确需内网媒体服务器，设置 ALLOW_PRIVATE_MEDIA=1）");
  return parsed;
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
export async function proxyMedia(req, res, { url, referer }) {
  assertFetchable(url);
  const headers = upstreamHeaders(referer);
  if (req.headers.range) headers.range = req.headers.range;

  const upstream = await fetch(url, { headers, redirect: "follow" });
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
export async function proxyHls(req, res, { url, referer }) {
  assertFetchable(url);
  const upstream = await fetch(url, {
    headers: upstreamHeaders(referer),
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!upstream.ok) throw fail("UPSTREAM", "清单拉取失败: HTTP " + upstream.status);

  const base = upstream.url || url;
  const text = await upstream.text();
  const ref = referer ? "&r=" + encodeURIComponent(referer) : "";
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
    return (isManifest ? "/api/hls?u=" : "/api/media?u=") + encodeURIComponent(abs) + ref;
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
