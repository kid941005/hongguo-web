import net from "node:net";
import { fail } from "./errors.mjs";

// 网络地址策略：默认拒绝内网/本机地址，避免把本服务当作 SSRF 跳板。
// ALLOW_PRIVATE_MEDIA=1 仅放行 /api/media、/api/hls（确有内网媒体服务器时）。
// ALLOW_PRIVATE_FETCH=1 放行 JS 源 fetch 与「按 URL 导入源」，默认关闭。
const ALLOW_MEDIA = process.env.ALLOW_PRIVATE_MEDIA === "1";
export const PRIVATE_FETCH_ALLOWED = process.env.ALLOW_PRIVATE_FETCH === "1";

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

export function assertPublicUrl(url, message = "不允许访问内网地址", allowPrivate = ALLOW_MEDIA) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw fail("BAD_URL", "地址无效");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw fail("BAD_URL", "仅支持 http(s) 地址");
  if (!allowPrivate && isPrivateHost(parsed.hostname)) throw fail("BAD_URL", message);
  return parsed;
}
