import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import zlib from "node:zlib";
import axios from "axios";
import { fail } from "./errors.mjs";
import { createOfficial } from "./official.mjs";

// ---- vendored 源加载（A1：显式依赖注入 + 导出白名单） ----
// server/vendor/hongguo.cjs 与 drpys 上游逐字节一致，不在这里改源本体；
// 加载点收敛成一处 loadVendor()，避免「谁都能往 vm 里塞东西」。
// 依赖只给真正需要的：node:crypto / node:zlib 与一个关掉代理的 axios 实例。
// 导出只暴露本服务实际调用的成员，新增调用必须先加进 VENDOR_EXPORTS，否则加载即失败。
const VENDOR_FILE = new URL("./vendor/hongguo.cjs", import.meta.url);

const VENDOR_EXPORTS = [
  "categoryPage",
  "categoryData",
  "itemToCard",
  "appSearchPage",
  "websiteSearch",
  "routerData",
  "resolveStream",
  "prepareHeader",
  "remoteRange",
  "decryptPartial",
  "streamCache",
  "videoInfoCache",
  "pageCache",
  "appSearchCache",
  "rankPageRich",
  "rule",
  "CATEGORIES",
  "CATEGORY_CONFIG",
  "FILTERS",
  "channelStats",
  "registerPlaybackDevice",
  "deriveContentKey",
];

function loadVendor() {
  const source = fs.readFileSync(VENDOR_FILE, "utf8");
  const context = vm.createContext({
    require: (name) => {
      if (name === "node:crypto") return crypto;
      if (name === "node:zlib") return zlib;
      throw new Error("Unsupported module: " + name);
    },
    Buffer,
    URL,
    URLSearchParams,
    log: () => {},
    setResult: (value) => value,
    // proxy:false 是关键：宿主机配了 HTTP(S)_PROXY 时 axios 默认会走代理，
    // 上游是字节系 CDN，经代理只会拿到 403 / 空正文，表现成「播放源不可用」。
    axios: axios.create({
      timeout: 30000,
      maxContentLength: 16 * 1024 * 1024,
      maxBodyLength: 1024 * 1024,
      proxy: false,
    }),
  });
  vm.runInContext(
    source + "\nthis.api = {" + VENDOR_EXPORTS.join(", ") + "};",
    context,
    { timeout: 5000 }
  );
  const loaded = context.api || {};
  // 上游文件被替换/改名时立刻失败，而不是等到某个接口调用点抛 "xxx is not a function"。
  const missing = VENDOR_EXPORTS.filter((name) => loaded[name] === undefined);
  if (missing.length) throw new Error("vendor 导出缺失：" + missing.join(", "));
  console.log(
    JSON.stringify({
      event: "vendor_loaded",
      file: "server/vendor/hongguo.cjs",
      bytes: Buffer.byteLength(source),
      sha256_12: crypto.createHash("sha256").update(source).digest("hex").slice(0, 12),
      exports: VENDOR_EXPORTS.length,
    })
  );
  return loaded;
}

const api = loadVendor();
// 官方播放模型（多档 HEVC）：设备身份注册与内容密钥派生都复用 vendor 里已验证的实现。
const official = createOfficial({
  register: () => api.registerPlaybackDevice(),
  deriveContentKey: (value) => api.deriveContentKey(value),
});
const SITE = "https://hongguoduanju.com";
const card = (row) => ({
  id: String(row.url),
  title: row.title,
  cover: row.img || "",
  description: row.content || "",
  badge: row.desc || "",
  tags: row.tname || "",
});
const cards = (rows) =>
  Array.from(rows)
    .filter((r) => /^\d+$/.test(String(r.url)) && r.title)
    .map(card);

// ---- 推荐页数据源：红果四条榜单（真实评分） ----
const RANK_ROUTES = ["hot-drama", "hot-real-drama", "hot-comic-drama", "hot-ai-drama"];
const RECOMMEND_POOL_PAGES = 5; // 每条榜抓 5 页（每页 20 条）
const RECOMMEND_TTL = 10 * 60 * 1000;
let recommendPool = null;
let recommendPoolAt = 0;
let recommendPoolPending = null;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (timer && timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const rankCard = (row) => ({
  id: String(row.url || ""),
  title: String(row.title || ""),
  cover: row.img || "",
  remarks: row.desc || "",
  description: row.content || "",
  tags: row.tname || "",
  score: Number(row.score) || 0,
  heat: row.heat || "",
  bang: row.bang || "",
  rank: Number(row.rank) || 0,
});

// 并发抓四条榜的全部分页，按 seriesId 去重、按真实评分降序（同分比热度）。
// 单页失败只丢该页，不让整批推荐失败。
async function buildRecommendPool() {
  const jobs = [];
  for (const route of RANK_ROUTES)
    for (let page = 1; page <= RECOMMEND_POOL_PAGES; page += 1) jobs.push([route, page]);
  const rows = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const [route, page] = jobs[cursor++];
      try {
        const data = await withTimeout(api.rankPageRich(route, page), 20000, "榜单页超时");
        for (const item of data.list) rows.push(item);
      } catch {
        /* 单页失败/超时忽略 */
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  const seen = new Map();
  for (const row of rows) {
    const key = String(row.url || "");
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev || row.score > prev.score || (row.score === prev.score && row.heatValue > prev.heatValue))
      seen.set(key, row);
  }
  const list = Array.from(seen.values())
    .sort((a, b) => b.score - a.score || b.heatValue - a.heatValue || a.rank - b.rank)
    .map(rankCard);
  if (!list.length) throw new Error("推荐榜单暂不可用");
  return list;
}

export const provider = {
  async home(page = 1) {
    const data = await api.categoryPage("tab=1&sort_type=1", page);
    const pageData =
      data?.loaderData?.category_page || data?.loaderData?.["category_$"];
    if (!Array.isArray(pageData?.recommendList))
      throw new Error("首页数据结构已变化");
    return {
      items: cards(pageData.recommendList.map(api.itemToCard)),
      page,
      classes: api.CATEGORIES.map((entry) => ({
        id: String(entry.type_id),
        name: String(entry.type_name || entry.type_id),
      })),
      filters: api.FILTERS,
    };
  },
  async category(typeId, page = 1, filters = {}) {
    const id = String(typeId || "short");
    const config = api.CATEGORY_CONFIG[id] || api.CATEGORY_CONFIG.short;
    if (!config) throw new Error("未知分类");
    if (config.kind === "category") {
      const query = new URLSearchParams(config.query || "");
      for (const [key, value] of Object.entries(filters || {})) {
        if (value === undefined || value === null || value === "") continue;
        query.set(key, String(value));
      }
      const data = await api.categoryPage(query.toString(), page);
      const pageData =
        data?.loaderData?.category_page || data?.loaderData?.["category_$"];
      const rows = pageData?.recommendList || pageData?.categoryData?.recommendList;
      if (!Array.isArray(rows)) throw new Error("分类数据结构已变化");
      const pagination = pageData?.pagination || {};
      const totalPages = Number(pagination.totalPages) || 0;
      return {
        items: cards(rows.map(api.itemToCard)),
        page,
        hasMore: totalPages ? page < totalPages : rows.length >= 24,
      };
    }
    const rows = await api.rule["一级"](id, page, {}, filters || {});
    const items = cards(Array.isArray(rows) ? rows : []);
    return { items, page, hasMore: items.length >= 20 };
  },
  // 官网 /api/search/result 是搜索页自身的 CSR 数据源：只校验 UA，既不走 App 签名，
  // 也不依赖 SSR（搜索页已被 sdk-glue 反爬壳换成 CSR）。App 签名接口与 SSR 解析降为兜底。
  async search(keyword, page = 1) {
    let webError = null;
    try {
      const result = await api.websiteSearch(keyword, page);
      // 200 + searchList 是权威结果（空列表=确实没有），直接返回，不再让别的通道给出不一致答案
      return {
        items: cards(result.list),
        page: result.page || page,
        hasMore: Boolean(result.hasMore),
        total: result.total || 0,
        channel: "web",
      };
    } catch (error) {
      webError = error;
    }
    try {
      const result = await api.appSearchPage(keyword, 11, page, 20);
      if (result.list.length)
        return { items: cards(result.list), page, channel: "app" };
    } catch {
      /* App 签名接口被风控时继续走 SSR 兜底 */
    }
    try {
      const data = await api.routerData(
        `${SITE}/search/${encodeURIComponent(keyword)}?page=${page}`
      );
      const pageData =
        data?.loaderData?.["search_(keyword)/page"] ||
        data?.loaderData?.search_page;
      if (Array.isArray(pageData?.searchList))
        return { items: cards(pageData.searchList.map(api.itemToCard)), page, channel: "ssr" };
    } catch {
      /* 搜索页已 CSR 化，SSR 兜底通常不可用 */
    }
    throw new Error(
      `红果搜索暂不可用：${(webError && webError.message) || "所有通道均失败"}`
    );
  },
  async detail(id) {
    const data = await api.routerData(`${SITE}/detail?series_id=${id}`);
    const series = data?.loaderData?.detail_page?.seriesDetail;
    if (!series || !Array.isArray(series.vid_list) || !series.vid_list.length)
      throw new Error("剧集不存在或分集暂不可用");
    const episodes = Array.from(series.vid_list, (vid, index) => ({
      id: String(vid),
      title: `第 ${index + 1} 集`,
      number: index + 1,
    }));
    if (
      episodes.some((e) => !/^\d+$/.test(e.id)) ||
      new Set(episodes.map((e) => e.id)).size !== episodes.length
    )
      throw new Error("分集数据异常");
    return { ...card(api.itemToCard(series)), id, episodes };
  },
  async recommendPool() {
    if (recommendPool && Date.now() - recommendPoolAt < RECOMMEND_TTL) return recommendPool;
    if (!recommendPoolPending) {
      recommendPoolPending = buildRecommendPool()
        .then((list) => {
          recommendPool = list;
          recommendPoolAt = Date.now();
          recommendPoolPending = null;
          return list;
        })
        .catch((error) => {
          recommendPoolPending = null;
          throw error;
        });
    }
    return recommendPoolPending;
  },
  // 取流：quality = auto | 1080p | 720p | 540p | 480p | 360p | compat
  // 官方 App 通道优先（真实多档、HEVC + CENC）；失败或显式 compat 时回落官网明文 360P（H.264）。
  async stream(id, { fresh = false, quality = "auto", track = true } = {}) {
    const wanted = String(quality || "auto").toLowerCase();
    if (fresh) {
      api.streamCache.delete(`${id}|auto`);
      api.videoInfoCache.delete(id);
    }
    if (wanted !== "compat") {
      try {
        const picked = await official.stream(id, wanted);
        const prepared = await api.prepareHeader(picked.stream);
        if (track) {
          STREAM_BREAKER.fails = 0;
          STREAM_BREAKER.openUntil = 0;
        }
        return {
          total: prepared.total,
          channel: "official",
          quality: picked.tier.key,
          codec: picked.tier.codec,
          chunk: async (start, end) =>
            api.decryptPartial(
              (await api.remoteRange(picked.stream, start, end)).data,
              start,
              picked.stream.key,
              prepared
            ),
        };
      } catch (error) {
        // 高清通道失败只降级，不计入官网通道熔断：360P 兜底通常仍然可用。
        METRICS.officialFails += 1;
        METRICS.lastOfficialError = String((error && error.message) || error).slice(0, 300);
        METRICS.lastOfficialErrorAt = Date.now();
      }
    }
    if (STREAM_BREAKER.openUntil > Date.now()) {
      throw fail("UPSTREAM_EMPTY", "红果播放源暂不可用，正在自动恢复，请切换数据源或稍后重试");
    }
    if (track) METRICS.attempts += 1;
    // 上游 CDN 偶发 DNS/TLS 抖动（getaddrinfo EAI_AGAIN、socket hang up 等），
    // 这类错误跟身份/风控无关，立刻重试一次就能救回来，没必要把 502 抛给播放器。
    const resolve = async () => {
      const stream = await api.resolveStream(id, "auto");
      const prepared = await api.prepareHeader(stream);
      return { stream, prepared };
    };
    try {
      let resolved;
      try {
        resolved = await resolve();
      } catch (error) {
        if (!isTransientNetworkError(error)) throw error;
        METRICS.retries += 1;
        resolved = await resolve();
      }
      const { stream, prepared } = resolved;
      if (track) {
        STREAM_BREAKER.fails = 0;
        STREAM_BREAKER.openUntil = 0;
      }
      return {
        total: prepared.total,
        channel: stream.channel || "app",
        quality: "compat",
        codec: "h264",
        chunk: async (start, end) =>
          api.decryptPartial(
            (await api.remoteRange(stream, start, end)).data,
            start,
            stream.key,
            prepared
          ),
      };
    } catch (error) {
      const message = String((error && error.message) || error);
      if (track) {
        STREAM_BREAKER.fails += 1;
        STREAM_BREAKER.lastError = message;
        METRICS.failures += 1;
        METRICS.lastError = message;
        METRICS.lastErrorAt = Date.now();
      }
      if (/空响应|video_model|video_tab|device_register|web 播放/.test(message)) {
        if (track) METRICS.empty += 1;
        if (track && STREAM_BREAKER.fails >= STREAM_BREAKER_THRESHOLD) {
          STREAM_BREAKER.openUntil = Date.now() + STREAM_BREAKER_COOLDOWN;
        }
        throw fail("UPSTREAM_EMPTY", "红果播放源暂不可用：" + message);
      }
      throw fail("UPSTREAM_ERROR", "红果播放源异常：" + message);
    }
  },
  // 清晰度清单：给 /api/play 用，失败不抛错（前端只显示 360P 兼容档）。
  // timeoutMs 有上限：/api/play 不能为了菜单把起播拖住。
  async quality(id, timeoutMs = 6000) {
    try {
      const info = await withTimeout(official.info(String(id)), timeoutMs, "清晰度查询超时");
      return {
        tiers: info.tiers.map((tier) => ({
          key: tier.key,
          label: tier.label,
          height: tier.height,
          codec: tier.codec,
          size: tier.size,
          bitrate: tier.bitrate,
        })),
        expire: info.expire,
      };
    } catch (error) {
      return { tiers: [], expire: 0, error: String((error && error.message) || error) };
    }
  },
  // 节点/模型失效时清掉这一集的取址缓存，下一次 stream() 会重新走上游取址（A3 首块校验失败时调用）。
  // 只清这一集，不动 pageCache/appSearchCache：那两类与播放地址无关。
  invalidate(id) {
    const key = String(id);
    api.streamCache.delete(`${key}|auto`);
    api.videoInfoCache.delete(key);
    if (typeof official.invalidate === "function") official.invalidate(key);
    METRICS.invalidations += 1;
    METRICS.lastInvalidationAt = Date.now();
    return true;
  },
  metrics() {
    return {
      stream: {
        attempts: METRICS.attempts,
        failures: METRICS.failures,
        empty: METRICS.empty,
        retries: METRICS.retries,
        lastError: METRICS.lastError,
        lastErrorAt: METRICS.lastErrorAt,
        officialFails: METRICS.officialFails,
        lastOfficialError: METRICS.lastOfficialError,
        lastOfficialErrorAt: METRICS.lastOfficialErrorAt,
        invalidations: METRICS.invalidations,
        lastInvalidationAt: METRICS.lastInvalidationAt,
      },
      official: official.stats,
      breaker: {
        fails: STREAM_BREAKER.fails,
        open: STREAM_BREAKER.openUntil > Date.now(),
        openUntil: STREAM_BREAKER.openUntil,
        lastError: STREAM_BREAKER.lastError,
      },
      // 通道级计数：web=官网明文通道（主），app=App CENC 通道（回落）
      channels: api.channelStats || null,
    };
  },
};

// 上游 CDN 侧的瞬时网络故障：DNS 抖动、连接被断、连接重置、读超时。
// 与「200 空正文」这类身份/风控问题区分开，前者可以立刻重试，后者重试也没用。
const TRANSIENT_NETWORK = /EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|socket hang up|TLS|Client network socket|getaddrinfo|网络|超时/i;

function isTransientNetworkError(error) {
  const text = String((error && (error.code ? error.code + " " : "") + ((error && error.message) || error)));
  return TRANSIENT_NETWORK.test(text);
}

// Limit the pinned upstream's otherwise unbounded caches during long-lived home use.
const STREAM_BREAKER_THRESHOLD = 3;
const STREAM_BREAKER_COOLDOWN = 45000;
const STREAM_BREAKER = { fails: 0, openUntil: 0, lastError: "" };
const METRICS = {
  attempts: 0, failures: 0, empty: 0, retries: 0, lastError: "", lastErrorAt: 0,
  officialFails: 0, lastOfficialError: "", lastOfficialErrorAt: 0,
  // 首块校验失败后清缓存重取的次数（A3）：持续增长说明上游签名/CDN 在频繁变化。
  invalidations: 0, lastInvalidationAt: 0,
};

const CACHE_TTL = 300000;
const CACHE_MAX = 100;
setInterval(() => {
  for (const cache of [api.streamCache, api.videoInfoCache, api.pageCache, api.appSearchCache]) {
    // 上游实现变更时某个缓存可能不存在或不是 Map：跳过而不是让定时器抛异常拖垮进程。
    if (!(cache instanceof Map)) continue;
    for (const [key, value] of cache) {
      const time = value && typeof value.time === "number" ? value.time : 0;
      if (Date.now() - time > CACHE_TTL) cache.delete(key);
    }
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
}, 60000).unref();
