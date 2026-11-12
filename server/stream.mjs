import { fail } from "./errors.mjs";

const CHUNK = 1024 * 1024;
// 允许的清晰度参数：auto=最高可用档，compat=官网 360P 明文兜底，其余按档位名精确匹配。
const QUALITIES = new Set(["auto", "1080p", "720p", "540p", "480p", "360p", "compat"]);

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(fail("TIMEOUT", message)), ms);
    if (timer && timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 解析 Range 头；非法或不满足返回 null（调用方回 416）。
export function byteRange(value, total) {
  if (!value) return [0, total - 1];
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
  const end = m[1] ? (m[2] ? Math.min(Number(m[2]), total - 1) : total - 1) : total - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < total
    ? [start, end]
    : null;
}

// 内置红果分集流：服务端分块解密后按 Range 吐出，浏览器只连本站。
export function createStreamHandler({ provider, limit = 6 }) {
  let active = 0;

  return async function serveStream(req, res, epId, quality) {
    const wanted = String(quality || "auto").toLowerCase();
    if (!QUALITIES.has(wanted)) throw fail("BAD_INPUT", "清晰度参数无效");
    if (!["GET", "HEAD"].includes(req.method)) throw fail("BAD_METHOD", "只支持 GET / HEAD");
    if (!/^[1-9]\d{0,29}$/.test(epId)) throw fail("BAD_INPUT", "剧集 id 无效");

    // HEAD 只回元数据：不去解析播放地址（要打上游取址接口）、不占用播放槽位。
    // 旧实现 HEAD 也会跑一遍 provider.stream，等于探活就触发一次上游风控。
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      });
      return res.end();
    }
    if (active >= limit) throw fail("BUSY", "同时播放数已达上限（" + limit + "），请稍后重试");

    active++;
    try {
      const stream = await withTimeout(provider.stream(epId, { quality: wanted }), 30000, "视频流初始化超时");
      const range = byteRange(req.headers.range, stream.total);
      if (!range) {
        res.writeHead(416, { "content-range": "bytes */" + stream.total });
        return res.end();
      }
      const [start, end] = range;
      const headers = {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        "cache-control": "no-store",
        // 实际选中的档位与编码：前端/测试可据此判断是否发生了降级（如 1080p → 360P）。
        "x-stream-quality": String(stream.quality || wanted),
        "x-stream-codec": String(stream.codec || ""),
      };
      if (req.headers.range) headers["content-range"] = "bytes " + start + "-" + end + "/" + stream.total;

      // 先取首块：解密失败时还能回错误码，而不是发出半截响应
      const first = await withTimeout(stream.chunk(start, Math.min(start + CHUNK - 1, end)), 20000, "视频分块读取超时");
      res.writeHead(req.headers.range ? 206 : 200, headers);

      for (let offset = start; offset <= end && !res.destroyed; offset += CHUNK) {
        const chunk = offset === start
          ? first
          : await withTimeout(stream.chunk(offset, Math.min(offset + CHUNK - 1, end)), 20000, "视频分块读取超时");
        if (res.destroyed) break;
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
            res.once("drain", done);
            res.once("close", done);
          });
        }
      }
      res.end();
    } finally {
      active--;
    }
  };
}
