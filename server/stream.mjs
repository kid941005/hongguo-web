import { fail } from "./errors.mjs";
import { probeMp4Head } from "./mp4.mjs";

const CHUNK = 1024 * 1024;
// 同一集同一档位的取址去重计数（只统计，供 /api/metrics 观察效果）。
const DEDUPE = { lookups: 0, shared: 0 };
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
  // 取址结果（含首块解密所需的 key/prepared）按 epId+档位复用：一集被多人同时点开时，
  // 只有第一个请求去打上游取址，其余共享同一个 Promise / 同一条上游流，不再各自触发一次风控。
  const inflight = new Map();

  function streamFor(epId, wanted, fresh) {
    const key = epId + "|" + wanted + (fresh ? "|fresh" : "");
    const running = inflight.get(key);
    if (running) {
      DEDUPE.shared += 1;
      return running;
    }
    DEDUPE.lookups += 1;
    const task = withTimeout(
      provider.stream(epId, fresh ? { quality: wanted, fresh: true } : { quality: wanted }),
      30000,
      "视频流初始化超时"
    ).finally(() => {
      if (inflight.get(key) === task) inflight.delete(key);
    });
    inflight.set(key, task);
    return task;
  }

  // 取流 + 解析 Range + 读首块。fresh=true 时绕过 provider 的取址缓存（换节点用）。
  async function resolveOnce(epId, wanted, rangeHeader, fresh) {
    const stream = await streamFor(epId, wanted, fresh);
    const range = byteRange(rangeHeader, stream.total);
    if (!range) return { stream, range: null, first: null };
    const [start, end] = range;
    const first = await withTimeout(
      stream.chunk(start, Math.min(start + CHUNK - 1, end)),
      20000,
      "视频分块读取超时"
    );
    return { stream, range, first };
  }

  // 明确指定档位时先查该档编码：H.266/VVC 任何浏览器都解不了，直接 415 比给一段黑屏流更诚实。
  // 只查缓存过的档位信息，查不到就放行（不为了拒绝一个请求去打上游）。
  async function codecOfTier(epId, key) {
    if (typeof provider.quality !== "function") return "";
    try {
      const info = await provider.quality(epId);
      const tier = ((info && info.tiers) || []).find((item) => item.key === key);
      return tier ? String(tier.codec || "") : "";
    } catch {
      return "";
    }
  }

  const serveStream = async function (req, res, epId, quality, allowVvc = false) {
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
    // auto/compat 由服务端选档，不会挑 VVC；显式点档位时才需要这层拦截。
    if (!allowVvc && wanted !== "auto" && wanted !== "compat") {
      const codec = await codecOfTier(epId, wanted);
      if (codec === "vvc") {
        throw fail(
          "CODEC_UNSUPPORTED",
          "该清晰度是 H.266/VVC 编码，浏览器无法解码；需要直取请加 vvc=1"
        );
      }
    }
    if (active >= limit) throw fail("BUSY", "同时播放数已达上限（" + limit + "），请稍后重试");

    active++;
    try {
      let attempt = await resolveOnce(epId, wanted, req.headers.range, false);
      if (!attempt.range) {
        res.writeHead(416, { "content-range": "bytes */" + attempt.stream.total });
        return res.end();
      }

      // 首块结构校验：只在从头取时做（Range 落在文件中间时首块本来就不是盒子头）。
      // 不合法说明取到的节点/模型已失效，清缓存重取一次，仍不对才报错。
      let headRetried = false;
      if (attempt.range[0] === 0 && attempt.first && attempt.first.length >= 8) {
        const probe = probeMp4Head(attempt.first);
        if (!probe.ok) {
          console.warn(
            JSON.stringify({
              event: "stream_head_invalid",
              epId,
              quality: wanted,
              box: probe.box,
              size: probe.size,
              bytes: probe.bytes,
              reason: probe.reason,
            })
          );
          headRetried = true;
          if (typeof provider.invalidate === "function") provider.invalidate(epId);
          attempt = await resolveOnce(epId, wanted, req.headers.range, true);
          if (!attempt.range) {
            res.writeHead(416, { "content-range": "bytes */" + attempt.stream.total });
            return res.end();
          }
          const again = attempt.first && attempt.first.length >= 8 ? probeMp4Head(attempt.first) : { ok: true };
          if (!again.ok) {
            throw fail(
              "UPSTREAM_EMPTY",
              "红果播放源返回异常数据（首块不是 MP4），已重新取址一次仍失败，请稍后重试或切换数据源"
            );
          }
        }
      }

      const { stream, range, first } = attempt;
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
      if (headRetried) headers["x-stream-head-retry"] = "1";
      if (req.headers.range) headers["content-range"] = "bytes " + start + "-" + end + "/" + stream.total;

      // 首块已经取到并校验过，这里才写头：解密失败时还能回错误码，而不是发出半截响应
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

  // 供 /api/metrics 观察去重效果：shared 越多说明并发同集请求被合并得越多。
  serveStream.dedupe = () => ({ ...DEDUPE });
  return serveStream;
}
