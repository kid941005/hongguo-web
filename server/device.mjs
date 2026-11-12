import fs from "node:fs";
import path from "node:path";

// 设备身份（B3）：红果播放模型接口把「匿名注册的设备」当成风控维度。
// 同一个 device_id 被判定异常后，签名重算多少次都只会拿到 200 空正文；
// 换一份新注册的身份往往立刻恢复。所以身份要能持久、能校验、能按需轮换，
// 但轮换必须节流——每集失败都换一次身份等于主动喂风控。
//
// 边界：
// - 运维用 HONGGUO_DEVICE_ID（可选 HONGGUO_INSTALL_ID）钉死身份时不轮换，只在日志里拒绝一次；
// - 同一份身份 60 秒内最多换一次，超出直接返回 throttled，由调用方继续报错；
// - 身份只从「文件 / 注册 / 轮换」三条路来，任何来源都要过 10~20 位纯数字校验。

export const DEVICE_ID_RE = /^\d{10,20}$/;
export const ROTATE_INTERVAL_MS = 60 * 1000;

// 校验并归一化一个设备标识；不合法返回空串（调用方据此判断「没有可用身份」）。
export function validDeviceId(value) {
  const text = String(value == null ? "" : value).trim();
  return DEVICE_ID_RE.test(text) ? text : "";
}

// 日志里不落完整设备号：前后各留 4 位足够定位是哪一份身份。
export function maskDeviceId(value) {
  const text = String(value || "");
  return text.length <= 8 ? text : text.slice(0, 4) + "..." + text.slice(-4);
}

export function createDeviceStore(options = {}) {
  const file = options.file ? String(options.file) : "";
  const register = options.register;
  const logger = typeof options.logger === "function" ? options.logger : (line) => console.log(line);
  if (typeof register !== "function") throw new Error("createDeviceStore 需要 register");
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : 6 * 60 * 60 * 1000;
  const rotateIntervalMs =
    Number(options.rotateIntervalMs) >= 0 ? Number(options.rotateIntervalMs) : ROTATE_INTERVAL_MS;

  const pinnedId = validDeviceId(options.envId);
  const pinnedIid = validDeviceId(options.envIid);
  if (String(options.envId || "").trim() && !pinnedId) {
    logger(
      JSON.stringify({ event: "device_env_invalid", message: "HONGGUO_DEVICE_ID 必须是 10~20 位纯数字，已忽略" })
    );
  }

  const stats = {
    source: pinnedId ? "env" : "none",
    registers: 0,
    rotates: 0,
    throttled: 0,
    rejected: 0,
    invalidFile: 0,
    lastRotateAt: 0,
    lastError: "",
  };

  let current = null;
  let currentAt = 0;
  let pending = null;
  let badFileLogged = false;
  let lastRotateAt = 0;
  let lastRotatedFrom = "";
  let envPartialWarned = false;

  function adopt(identity, source) {
    current = {
      device_id: identity.device_id,
      iid: identity.iid,
      time: Number(identity.time) || Date.now(),
      source,
    };
    currentAt = current.time;
    stats.source = source;
    return current;
  }

  // 档案文件是「长期身份」，读出来就认，不按时间过期：
  // 每次 TTL 到期都重新注册等于主动制造设备churn，只会更快撞风控。
  function readFile() {
    if (!file) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const device_id = validDeviceId(raw && raw.device_id);
      const iid = validDeviceId(raw && raw.iid);
      if (!device_id || !iid) {
        stats.invalidFile += 1;
        if (!badFileLogged) {
          badFileLogged = true;
          logger(JSON.stringify({ event: "device_file_invalid", file, message: "device_id / iid 不是 10~20 位纯数字" }));
        }
        return null;
      }
      return { device_id, iid, time: Number(raw.time) || 0 };
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        stats.invalidFile += 1;
        if (!badFileLogged) {
          badFileLogged = true;
          logger(
            JSON.stringify({
              event: "device_file_unreadable",
              file,
              message: String((error && error.message) || error),
            })
          );
        }
      }
      return null;
    }
  }

  function persist(identity) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(identity, null, 2));
    } catch (error) {
      logger(
        JSON.stringify({ event: "device_persist_failed", message: String((error && error.message) || error) })
      );
    }
  }

  // 只注册、不改状态：调用方决定这份身份是「新建」还是「轮换」。
  async function registerOnce() {
    const registered = await register();
    const device_id = validDeviceId(registered && registered.device_id);
    const iid = validDeviceId(registered && registered.iid);
    if (!device_id || !iid) throw new Error("设备注册返回了非法身份");
    stats.registers += 1;
    return { device_id, iid };
  }

  async function refresh(reason) {
    if (pending) return pending;
    pending = (async () => {
      const pair = await registerOnce();
      const identity = adopt({ ...pair, time: Date.now() }, reason === "rotate" ? "rotated" : "generated");
      persist(identity);
      return identity;
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  // 取当前身份：env 钉死 > 内存新鲜 > 文件 > 现注册。
  async function get(options = {}) {
    if (pinnedId) {
      if (pinnedIid) {
        return adopt({ device_id: pinnedId, iid: pinnedIid, time: Date.now() }, "env");
      }
      const stored = readFile();
      if (stored && stored.device_id === pinnedId) {
        const adopted = adopt(stored, "env");
        currentAt = Date.now();
        return adopted;
      }
      if (!envPartialWarned) {
        envPartialWarned = true;
        logger(
          JSON.stringify({
            event: "device_env_partial",
            message: "只钉了 HONGGUO_DEVICE_ID、没有 HONGGUO_INSTALL_ID：install id 由注册补一次",
          })
        );
      }
      const pair = await registerOnce();
      return adopt({ device_id: pinnedId, iid: pair.iid, time: Date.now() }, "env");
    }
    const maxAge = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : ttlMs;
    if (current && Date.now() - currentAt < maxAge) return current;
    const stored = readFile();
    if (stored) {
      const adopted = adopt(stored, "file");
      currentAt = Date.now();
      return adopted;
    }
    return refresh("missing");
  }

  // 换一份身份。返回 { rotated, reason }，调用方按结果决定错误文案。
  async function rotate(reason) {
    const why = String(reason || "risk");
    if (pinnedId) {
      stats.rejected += 1;
      logger(JSON.stringify({ event: "device_rotate_refused", reason: why, message: "env 钉死身份，不轮换" }));
      return { rotated: false, reason: "env" };
    }
    const now = Date.now();
    const elapsed = now - lastRotateAt;
    if (lastRotateAt && elapsed < rotateIntervalMs) {
      stats.throttled += 1;
      return { rotated: false, reason: "throttled", retryAfter: Math.ceil((rotateIntervalMs - elapsed) / 1000) };
    }
    const from = current ? current.device_id : "";
    lastRotateAt = now;
    lastRotatedFrom = from;
    stats.lastRotateAt = now;
    try {
      const identity = await refresh("rotate");
      stats.rotates += 1;
      logger(
        JSON.stringify({
          event: "device_rotated",
          reason: why,
          from: maskDeviceId(from),
          to: maskDeviceId(identity.device_id),
        })
      );
      return { rotated: true, reason: why, from, identity };
    } catch (error) {
      stats.lastError = String((error && error.message) || error).slice(0, 300);
      logger(JSON.stringify({ event: "device_rotate_failed", reason: why, message: stats.lastError }));
      return { rotated: false, reason: "error", error };
    }
  }

  return {
    get,
    refresh,
    rotate,
    valid: (value) => validDeviceId(value),
    stats() {
      return {
        ...stats,
        source: pinnedId ? "env" : current ? current.source : "none",
        device: maskDeviceId(pinnedId || (current ? current.device_id : "")),
        lastRotatedFrom: maskDeviceId(lastRotatedFrom),
        pinned: Boolean(pinnedId),
      };
    },
  };
}
