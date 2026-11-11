import net from "node:net";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { fail } from "./errors.mjs";

// 网络地址策略：默认拒绝内网/本机地址，避免把本服务当作 SSRF 跳板。
// ALLOW_PRIVATE_MEDIA=1 仅放行 /api/media、/api/hls（确有内网媒体服务器时）。
// ALLOW_PRIVATE_FETCH=1 放行 JS 源 fetch 与「按 URL 导入源」，默认关闭。
const ALLOW_MEDIA = process.env.ALLOW_PRIVATE_MEDIA === "1";
export const PRIVATE_FETCH_ALLOWED = process.env.ALLOW_PRIVATE_FETCH === "1";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function isPrivateIPv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const [a, b, c, d] = parts.map((part) => Number(part));
  if (![a, b, c, d].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false;
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8、10/8、127/8
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24、192.0.2/24
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24
  if (a >= 224) return true; // 224/4 multicast、240/4 reserved、255.255.255.255
  return false;
}

export function isPrivateHost(hostname) {
  let host = String(hostname || "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;

  const version = net.isIP(host);
  if (version === 4) return isPrivateIPv4(host);
  if (version === 6) {
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) return true; // IPv6 ULA fc00::/7
    if (/^fe[89ab][0-9a-f]?:/i.test(host)) return true; // IPv6 link-local fe80::/10
    if (/^ff[0-9a-f]{0,2}:/i.test(host)) return true; // IPv6 multicast ff00::/8
    if (/^2001:db8:/i.test(host)) return true; // documentation
    let mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
    if (mapped) return isPrivateIPv4(mapped[1]);
    mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return isPrivateIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
    }
  }
  return false;
}

function parseHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw fail("BAD_URL", "地址无效");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw fail("BAD_URL", "仅支持 http(s) 地址");
  return parsed;
}

function bareHost(hostname) {
  return String(hostname || "").replace(/^\[|\]$/g, "");
}

async function resolvePublicHost(hostname, message) {
  const host = bareHost(hostname);
  if (isPrivateHost(host)) throw fail("BAD_URL", message);
  if (net.isIP(host)) return [host];
  let records;
  try {
    // 获取全部 A/AAAA，任一解析到内网都拒绝，防止 DNS 记录混入内网地址。
    records = await dnsPromises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw fail("BAD_URL", message);
  }
  if (!records.length) throw fail("BAD_URL", message);
  for (const record of records) {
    if (isPrivateHost(record.address)) throw fail("BAD_URL", message);
  }
  return records.map((record) => record.address);
}

// 兼容旧调用：显式校验 URL 及其 DNS 解析结果。真正的请求请优先用 safeFetch，
// 它会在建立连接时用自定义 lookup 固定使用已校验的地址，避免 DNS Rebinding 的 TOCTOU。
export async function assertPublicUrl(url, message = "不允许访问内网地址", allowPrivate = ALLOW_MEDIA) {
  const parsed = parseHttpUrl(url);
  if (!allowPrivate) await resolvePublicHost(parsed.hostname, message);
  return parsed;
}

function normalizeHeaders(input) {
  const out = {};
  if (!input) return out;
  if (typeof input.forEach === "function" && typeof input.get === "function") {
    input.forEach((value, key) => { out[key] = String(value); });
    return out;
  }
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (pair && pair[0] != null && pair[1] != null) out[String(pair[0])] = String(pair[1]);
    }
    return out;
  }
  for (const [key, value] of Object.entries(input)) {
    if (value != null) out[key] = String(value);
  }
  return out;
}

function createPinnedLookup(message, allowPrivate) {
  return function pinnedLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const lookupOptions = { ...(options || {}), all: true, verbatim: true };
    dns.lookup(hostname, lookupOptions, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 6 }];
      if (!list.length) return callback(fail("BAD_URL", message));
      if (!allowPrivate && list.some((item) => isPrivateHost(item.address))) {
        return callback(fail("BAD_URL", message));
      }
      if (options && options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function responseHeaders(res) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value != null) {
      headers.set(key, value);
    }
  }
  return headers;
}

const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

function wrapResponse(res, url, method, timeoutMs) {
  const headers = responseHeaders(res);
  const noBody = method === "HEAD" || res.statusCode < 200 || res.statusCode === 204 || res.statusCode === 304;
  const body = noBody ? null : Readable.toWeb(res);
  let bufferPromise = null;
  const readBuffer = () => {
    if (noBody) return Promise.resolve(Buffer.alloc(0));
    if (!bufferPromise) {
      bufferPromise = (async () => {
        const chunks = [];
        let total = 0;
        let idleTimer = null;
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => res.destroy(timeoutError()), timeoutMs > 0 ? timeoutMs : 30000);
          if (idleTimer.unref) idleTimer.unref();
        };
        armIdle();
        try {
          for await (const chunk of res) {
            armIdle();
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.length;
            if (total > MAX_BUFFERED_BYTES) throw fail("TOO_BIG", "上游响应超过 64MB 上限");
            chunks.push(buffer);
          }
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
        return Buffer.concat(chunks);
      })();
    }
    return bufferPromise;
  };
  res.on("error", () => {});
  return {
    status: res.statusCode,
    statusText: res.statusMessage || "",
    ok: res.statusCode >= 200 && res.statusCode < 300,
    url,
    headers,
    body,
    discard: () => res.resume(),
    text: async () => (await readBuffer()).toString("utf8"),
    json: async () => JSON.parse((await readBuffer()).toString("utf8")),
    arrayBuffer: async () => {
      const buffer = await readBuffer();
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function timeoutError() {
  const error = new Error("网络请求超时");
  error.name = "TimeoutError";
  error.code = "TIMEOUT";
  return error;
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function requestOnce(parsed, { method, headers, body, signal, timeoutMs, allowPrivate, message }) {
  return new Promise((resolve, reject) => {
    const host = bareHost(parsed.hostname);
    if (!allowPrivate && isPrivateHost(host)) {
      reject(fail("BAD_URL", message));
      return;
    }
    const transport = parsed.protocol === "https:" ? https : http;
    const requestHeaders = normalizeHeaders(headers);
    const bufferBody = body != null && method !== "GET" && method !== "HEAD"
      ? (typeof body === "string" || Buffer.isBuffer(body) || ArrayBuffer.isView(body) || body instanceof ArrayBuffer ? Buffer.from(body) : null)
      : null;
    if (bufferBody && !hasHeader(requestHeaders, "content-length")) {
      requestHeaders["content-length"] = String(bufferBody.length);
    }
    const options = {
      protocol: parsed.protocol,
      hostname: host,
      port: parsed.port ? Number(parsed.port) : undefined,
      path: parsed.pathname + parsed.search,
      method,
      headers: requestHeaders,
      lookup: createPinnedLookup(message, allowPrivate),
    };
    if (parsed.username || parsed.password) {
      options.auth = decodeURIComponent(parsed.username) + ":" + decodeURIComponent(parsed.password);
    }
    if (parsed.protocol === "https:") {
      options.servername = net.isIP(host) ? undefined : host;
    }

    let req;
    try {
      req = transport.request(options);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => req.destroy(timeoutError()), timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      const error = new Error("请求已取消");
      error.name = "AbortError";
      req.destroy(error);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    req.once("response", (res) => {
      cleanup();
      resolve(wrapResponse(res, parsed.toString(), method, timeoutMs));
    });
    req.once("error", (error) => {
      cleanup();
      reject(error);
    });

    if (body == null || method === "GET" || method === "HEAD") {
      req.end();
    } else if (bufferBody) {
      req.end(bufferBody);
    } else if (body instanceof Readable) {
      body.pipe(req);
    } else {
      req.end(String(body));
    }
  });
}

// 安全 fetch：支持重定向、超时与流式响应；每个跳转都在连接时校验 DNS 结果，
// 并把连接固定到校验过的地址，避免「先检查域名、后连接时被换成内网 IP」的 DNS Rebinding。
export async function safeFetch(input, {
  method = "GET",
  headers = {},
  body,
  signal,
  timeoutMs = 15000,
  redirect = "follow",
  allowPrivate = ALLOW_MEDIA,
  maxRedirects = 5,
  message = "不允许访问内网地址",
} = {}) {
  let parsed = parseHttpUrl(input);
  if (!allowPrivate && isPrivateHost(parsed.hostname)) throw fail("BAD_URL", message);
  let currentMethod = String(method || "GET").toUpperCase();
  let currentBody = body;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await requestOnce(parsed, {
      method: currentMethod,
      headers,
      body: currentBody,
      signal,
      timeoutMs,
      allowPrivate,
      message,
    });
    const location = response.headers.get("location");
    const follow = redirect === "follow" && REDIRECT_STATUS.has(response.status) && location;
    if (!follow) return response;

    response.discard();
    if (redirects === maxRedirects) throw fail("UPSTREAM", "上游重定向次数过多");
    let next;
    try {
      next = new URL(location, parsed).toString();
    } catch {
      throw fail("UPSTREAM", "上游重定向地址无效");
    }
    parsed = parseHttpUrl(next);
    if (!allowPrivate && isPrivateHost(parsed.hostname)) throw fail("BAD_URL", message);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== "GET" && currentMethod !== "HEAD")) {
      currentMethod = "GET";
      currentBody = undefined;
    }
  }
  throw fail("UPSTREAM", "上游重定向次数过多");
}
