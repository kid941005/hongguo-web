import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import axios from "axios";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PlayerSigner } = require("./sign/argus.cjs");

// 红果（番茄小说 App，aid=8662）官方播放模型接口。
// 只有 multi_video_model 这条稳定可用；video_model / video_tab 均已返回 200 空正文。
const MODEL_HOST = "https://api5-normal-sinfonlinea.fqnovel.com";
const MODEL_PATH = "/novel/player/multi_video_model/v1/";

// 请求头：仅 x-argus + x-ladon 是硬门禁（缺一个就 200 空正文），其余为陪衬。
const UA =
  "com.phoenix.read/73932 (Linux; U; Android 14; zh_CN; 23127PN0CC; Build/UKQ1.230804.001; " +
  "Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";

// 与实测成功请求完全一致的设备参数（改版本号可能触发风控，勿随意调整）。
const DEVICE_PARAMS = {
  ac: "wifi",
  channel: "xiaomi_8662_64",
  aid: "8662",
  app_name: "novelread",
  version_code: "73932",
  version_name: "7.3.9.32",
  device_platform: "android",
  os: "android",
  ssmix: "a",
  device_type: "23127PN0CC",
  device_brand: "Xiaomi",
  language: "zh",
  os_api: "34",
  os_version: "14",
  manifest_version_code: "73932",
  resolution: "1200*2670",
  dpi: "460",
  update_version_code: "73932",
  host_abi: "arm64-v8a",
  dragon_device_type: "phone",
  pv_player: "73932",
  compliance_status: "0",
  need_personal_recommend: "1",
  player_so_load: "1",
  is_android_pad_screen: "0",
};

const BIZ_PARAM = {
  detail_page_version: 0,
  device_level: 3,
  disable_digg_stat: false,
  need_all_video_definition: true,
  need_mp4_align: false,
  use_os_player: false,
  use_server_dns: false,
  video_platform: 1024,
};

const MODEL_TTL = 10 * 60 * 1000; // 模型缓存 10 分钟（签名 URL 有效期约 6 小时）
const MODEL_FAIL_TTL = 10 * 1000; // 失败缓存 10 秒，避免反复打上游风控
const DEVICE_TTL = 6 * 60 * 60 * 1000;
const MODEL_TIMEOUT = 12000;

// 质量档位：按分辨率从高到低，前端清晰度菜单直接用。
const QUALITY_KEYS = ["1080p", "720p", "540p", "480p", "360p", "compat"];

// 与 Python urllib.parse.quote / 官方客户端的编码保持一致（额外转义 !'()），
// 因为 x-argus 的 query hash 覆盖整串 query，编码方式必须与实际 URL 完全相同。
function encodeValue(value) {
  return encodeURIComponent(String(value == null ? "" : value)).replace(/[!'()*]/g, (ch) =>
    "%" + ch.charCodeAt(0).toString(16).toUpperCase()
  );
}

function buildQuery(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => encodeValue(key) + "=" + encodeValue(value))
    .join("&");
}

function dataDir() {
  const fromEnv = process.env.DATA_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
}

const DEVICE_FILE = () => path.join(dataDir(), "device.json");

function readDeviceFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEVICE_FILE(), "utf8"));
    if (raw && raw.device_id && raw.iid) return raw;
  } catch {
    /* 首次运行 / 文件损坏：当作没有档案 */
  }
  return null;
}

function writeDeviceFile(identity) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(DEVICE_FILE(), JSON.stringify(identity, null, 2));
  } catch (error) {
    console.warn(JSON.stringify({ event: "device_persist_failed", message: String((error && error.message) || error) }));
  }
}

export function createOfficial({ register, deriveContentKey } = {}) {
  if (typeof register !== "function" || typeof deriveContentKey !== "function")
    throw new Error("createOfficial 需要 register / deriveContentKey");

  const cache = new Map(); // epId -> { time, value } | { time, error }
  const inflight = new Map(); // epId -> Promise（同一集并发请求只打一次上游）
  let identity = readDeviceFile();
  let identityAt = identity ? Number(identity.time) || 0 : 0;
  let identityPending = null;

  const stats = { requests: 0, ok: 0, empty: 0, failed: 0, lastError: "", lastErrorAt: 0, registered: 0, invalidated: 0 };

  function markError(error) {
    stats.failed += 1;
    stats.lastError = String((error && error.message) || error).slice(0, 300);
    stats.lastErrorAt = Date.now();
  }

  async function getIdentity(fresh = false) {
    if (!fresh && identity && Date.now() - identityAt < DEVICE_TTL) return identity;
    if (identityPending) return identityPending;
    identityPending = (async () => {
      const registered = await register();
      const next = {
        device_id: String(registered.device_id),
        iid: String(registered.iid),
        time: Date.now(),
      };
      identity = next;
      identityAt = next.time;
      stats.registered += 1;
      writeDeviceFile(next);
      return next;
    })().finally(() => {
      identityPending = null;
    });
    return identityPending;
  }

  function parseModel(text, epId) {
    const root = JSON.parse(text);
    if (!root || typeof root !== "object") throw new Error("model 响应不是对象");
    const code = Number(root.code != null ? root.code : root.Code != null ? root.Code : 0);
    if (code !== 0) throw new Error("model 返回错误码 " + code);
    const data = root.data || {};
    const entry = data[String(epId)] || Object.values(data)[0];
    if (!entry || typeof entry !== "object") throw new Error("model 响应缺少条目");
    let model = entry.video_model;
    if (typeof model === "string") model = JSON.parse(model);
    if (!model || !Array.isArray(model.video_list) || !model.video_list.length)
      throw new Error("model 没有 video_list");
    return model;
  }

  async function requestModel(epId, options = {}) {
    const id = await getIdentity(Boolean(options.freshIdentity));
    const ts = Math.floor(Date.now() / 1000);
    const ticket = ts * 1000;
    const query = buildQuery({
      ...DEVICE_PARAMS,
      device_id: id.device_id,
      iid: id.iid,
      cdid: options.withCdid ? options.withCdid : undefined,
      openudid: options.withOpenudid ? options.withOpenudid : undefined,
      ts: String(ts),
      _rticket: String(ticket),
    });
    const body = JSON.stringify({
      biz_param: BIZ_PARAM,
      mixed_video_id_map: { 1004: [String(epId)] },
    });
    const headers = {
      "User-Agent": UA,
      Accept: "application/json; charset=utf-8,application/x-protobuf",
      "Content-Type": "application/json; charset=UTF-8",
      ...PlayerSigner.headers(query, body, ts),
    };
    stats.requests += 1;
    const resp = await axios.post(MODEL_HOST + MODEL_PATH + "?" + query, body, {
      headers,
      timeout: MODEL_TIMEOUT,
      responseType: "text",
      validateStatus: () => true,
    });
    const text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    if (resp.status !== 200) throw new Error("model HTTP " + resp.status);
    if (!text.trim()) {
      stats.empty += 1;
      throw new Error("model 空响应（签名或设备身份被风控）");
    }
    return parseModel(text, epId);
  }

  // 三级降级：普通身份 → 补 cdid/openudid → 重新注册设备身份。
  // 并发合并：/api/play 和 /api/stream 常同时要同一集的 model，合并成一次上游请求，
  // 也避免「play 侧超时放弃、stream 侧又看到失败缓存」直接掉到 360P。
  async function fetchModel(epId, options = {}) {
    const key = String(epId);
    if (!options.force) {
      const cached = cache.get(key);
      if (cached) {
        if (cached.value && Date.now() - cached.time < MODEL_TTL) return cached.value;
        if (cached.error && Date.now() - cached.time < MODEL_FAIL_TTL) throw cached.error;
      }
      const running = inflight.get(key);
      if (running) return running;
    }
    const task = runFetch(key, options);
    inflight.set(key, task);
    try {
      return await task;
    } finally {
      if (inflight.get(key) === task) inflight.delete(key);
    }
  }

  async function runFetch(key, options) {
    const attempts = [
      () => requestModel(key),
      () =>
        requestModel(key, {
          withCdid: crypto.randomUUID(),
          withOpenudid: crypto.randomBytes(8).toString("hex"),
        }),
      () => requestModel(key, { freshIdentity: true }),
    ];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        const model = await attempt();
        cache.set(key, { time: Date.now(), value: model });
        stats.ok += 1;
        return model;
      } catch (error) {
        lastError = error;
        // 网络类错误没必要换身份重试，直接抛给上层回落 360P。
        if (!/空响应|错误码|缺少条目|video_list/.test(String((error && error.message) || error))) break;
      }
    }
    cache.set(key, { time: Date.now(), error: lastError });
    markError(lastError);
    throw lastError;
  }

  // 红果官方档位的编码：bytevc1 = H.265/HEVC，bytevc2 = H.266/VVC。
  // VVC 目前没有任何浏览器能解，必须单独标出来，否则会被误当成 HEVC 去试。
  function codecOf(raw) {
    const s = String(raw || "").toLowerCase();
    if (/bytevc2|vvc|h266/.test(s)) return "vvc";
    if (/bytevc1|hevc|hev|hvc|h265/.test(s)) return "hevc";
    if (/avc|h264/.test(s)) return "h264";
    return "unknown";
  }

  function tiersOf(model) {
    const list = Array.isArray(model.video_list) ? model.video_list : [];
    const tiers = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const meta = item.video_meta || {};
      const url = String(item.main_url || item.backup_url || "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      const pixelHeight = Number(meta.vheight) || 0;
      const pixelWidth = Number(meta.vwidth) || 0;
      if (!pixelHeight) continue;
      const definition = String(meta.definition || "").trim().toLowerCase();
      // definition 是「1080p」这类档位名；vwidth/vheight 是竖屏像素（1080x1920）。
      // 菜单里按习惯用档位名（1080P/720P），像素尺寸单独保留。
      const matched = /^(\d{3,4})p$/.exec(definition);
      const nominal = matched ? Number(matched[1]) : pixelHeight;
      const key = nominal + "p";
      const spade = item.spade_a || (item.encrypt_info && item.encrypt_info.spade_a) || "";
      let contentKey = null;
      if (spade) {
        try {
          contentKey = deriveContentKey(spade);
        } catch {
          contentKey = null; // 派生失败说明该档不是 CENC，按明文处理
        }
      }
      const codec = codecOf(meta.codec_type);
      tiers.push({
        key,
        label: nominal + "P",
        height: nominal,
        width: pixelWidth,
        pixelWidth,
        pixelHeight,
        codec,
        bitrate: Number(meta.bitrate) || 0,
        size: Number(meta.size) || 0,
        url,
        contentKey,
      });
    }
    // 去重（同一 definition 只留码率最高的一条），按高度降序。
    const best = new Map();
    for (const tier of tiers) {
      const prev = best.get(tier.key);
      if (!prev || tier.bitrate > prev.bitrate) best.set(tier.key, tier);
    }
    return Array.from(best.values()).sort((a, b) => b.height - a.height);
  }

  function pickTier(tiers, quality) {
    if (!tiers.length) return null;
    const wanted = String(quality || "auto").toLowerCase();
    if (wanted === "compat") return null;
    if (wanted === "auto") {
      // 默认档优先给浏览器能解的（HEVC / H.264）；全是 VVC 时才退回最高档。
      return tiers.find((tier) => tier.codec !== "vvc") || tiers[0];
    }
    const exact = tiers.find((tier) => tier.key === wanted);
    if (exact) return exact;
    const height = Number(wanted.replace(/p$/, ""));
    if (Number.isFinite(height) && height > 0) {
      const lower = tiers.filter((tier) => tier.height <= height);
      if (lower.length) return lower[0]; // 已按高度降序，取不超过目标的最大档
      return tiers[tiers.length - 1]; // 目标高于全部可用档，退到最小档
    }
    return tiers[0];
  }

  return {
    stats,
    // 首块解密出来不是 MP4 时，说明这份播放模型（签名 URL + 内容密钥）已失效，
    // 清掉这一集的缓存，让下一次取址重新打上游（A3）。失败缓存同样清掉，
    // 否则 MODEL_FAIL_TTL 内的重取会直接命中上次的错误。
    invalidate(epId) {
      const key = String(epId);
      cache.delete(key);
      stats.invalidated += 1;
      return true;
    },
    async info(epId) {
      const model = await fetchModel(epId);
      const tiers = tiersOf(model);
      return { tiers, expire: Number(model.url_expire) || 0, duration: Number(model.video_duration) || 0 };
    },
    // 返回可直接交给 vendor 的 prepareHeader/remoteRange/decryptPartial 的 stream 对象。
    async stream(epId, quality = "auto") {
      const model = await fetchModel(epId);
      const tiers = tiersOf(model);
      const tier = pickTier(tiers, quality);
      if (!tier) throw new Error("官方接口没有可用清晰度");
      return {
        tier,
        tiers,
        stream: {
          url: tier.url,
          key: tier.contentKey,
          codec: tier.codec,
          quality: tier.label,
          ua: UA,
          referer: "https://novel.snssdk.com/",
          channel: "official",
        },
      };
    },
  };
}

export { QUALITY_KEYS };
