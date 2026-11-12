import { fail } from "./errors.mjs";
import { transcodeAvailable } from "./transcode.mjs";

// 统一目录层：把「内置红果解密源」与「糖葫芦 / CatPawOpen 风格 JS 源」归一成同一套接口。
// 约定：所有对外方法都返回 { source, items|lines|episodes, ... }，字段缺失一律给空值而不是 undefined。

const TIMEOUT_HOME = 40000;
// 首页 stale-while-revalidate：新鲜期内直出；过期先回上次成功的结果、后台刷新。
// 上游偶发 502/超时不应该让首页整页报错，也不该让每个访客都等一次上游。
const HOME_FRESH_MS = 90 * 1000;
const HOME_STALE_MS = 6 * 60 * 60 * 1000;
const HOME_CACHE_MAX = 16;
const TIMEOUT_SEARCH = 60000;
const TIMEOUT_AGGREGATE = 12000; // 聚合搜索单源上限：慢源不拖住整体
// 模板/示例源不参与聚合，避免「示例剧」和 example.com 404 污染结果。
const AGGREGATE_SKIP = new Set(["template", "maccms"]);
const RECOMMEND_PER_PAGE = 24;
// 翻页硬上限：任何列表翻到第 MAX_PAGE 页一律视为「没有下一页」。
// 「本页有数据/本页条数 >= 24 就算还有下一页」这类恒真启发式是无限滚动的根源，统一在这里兜住。
const MAX_PAGE = 20;
// 源根本没按关键词检索时（红果官网无命中会返回推荐池、七猫/西饭会忽略关键词）给前端的统一提示。
const SEARCH_FALLBACK_REASON = "该源未按关键词检索，以下为源返回的热门内容";
// 翻页记忆：同一「源 + 列表 + 关键词」记住各页 id，用来判断本页是否真的在推进。
const PAGE_MEMORY_MAX = 64;
const PAGE_MEMORY_PAGES = 8;
// 跨源降级：主源取不到流时按剧名去其它源找同一部剧（模板/示例源不参与）。
const FALLBACK_SKIP = new Set(["template", "maccms"]);
const FALLBACK_TIMEOUT = 12000;
const FALLBACK_MAX = 3;
const FALLBACK_MIN_SCORE = 0.62;

function pick(...values) {
  for (const value of values) if (value !== undefined && value !== null && value !== "") return value;
  return "";
}

// 标签兼容数组与「a/b/c」「a,b,c」字符串，统一成字符串数组。
function normTags(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\/,，|]/) : [];
  return (Array.isArray(list) ? list : [])
    .map((tag) => String(tag || "").trim())
    .filter(Boolean);
}

function normVod(vod) {
  if (!vod || typeof vod !== "object") return null;
  const id = String(pick(vod.vod_id, vod.id, vod.vid));
  if (!id) return null; // 没有 id 的条目点进去必然 400，直接丢弃
  const score = Number(pick(vod.score, 0)) || 0;
  return {
    id,
    title: String(pick(vod.vod_name, vod.title, vod.name)),
    cover: String(pick(vod.vod_pic, vod.cover, vod.img, vod.pic)),
    remarks: String(pick(vod.vod_remarks, vod.badge, vod.remarks, vod.note)),
    tags: normTags(pick(vod.tags, vod.vod_tag, vod.vod_tags, vod.tag)),
    year: String(pick(vod.vod_year, vod.year)),
    area: String(pick(vod.vod_area, vod.area)),
    desc: String(pick(vod.vod_content, vod.description, vod.desc)),
    // 推荐页专用：真实评分/热度/榜名，其它源缺省为 0/空
    score,
    heat: String(pick(vod.heat)),
    bang: String(pick(vod.bang)),
    rank: Number(pick(vod.rank, 0)) || 0,
  };
}

function toItems(list) {
  return (Array.isArray(list) ? list : []).map(normVod).filter(Boolean);
}

// 兼容源返回数组或 { list: [] } 两种写法（README 两种都允许）。
function listOf(result) {
  if (Array.isArray(result)) return result;
  return result && Array.isArray(result.list) ? result.list : [];
}

// 标题归一：去掉空白/标点/「短剧」「全集」这类营销后缀，避免同一部剧在不同源写法不同而匹配不上。
function titleKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\u3000·・:：!！?？,，.。、\-—_~～|/\\()（）\[\]【】{}<>《》"'“”‘’#*+]/g, "")
    .replace(/(短剧|全集|全\d+集|已完结|更新至\d+集?|第[一二三四五六七八九十百\d]+季)/g, "");
}

// 二元组 Dice 系数：中文短剧名多为 4–8 字，重合度比编辑距离更抗「多两个字/少一个字」的写法差异。
function titleScore(a, b) {
  const x = titleKey(a);
  const y = titleKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 0.9;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (text) => {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const gram of gx) if (gy.has(gram)) hit += 1;
  return (2 * hit) / (gx.size + gy.size);
}

// ---------------- 关键词相关性 ----------------
// 归一化：小写 + 去掉空白与常见标点（与 titleKey 同一套噪声字符）。
const KW_NOISE = /[\s\u3000·・:：!！?？,，.。、\-—_~～|/\\()（）\[\]【】{}<>《》"'“”‘’#*+]/g;
const KW_CJK = /[\u4e00-\u9fff]/;

export function normKeyword(value) {
  return String(value == null ? "" : value).toLowerCase().replace(KW_NOISE, "");
}

// 片段阈值：中文按字取 ceil(字数/2)（至少 2 字），英文/数字只认完整包含。
// 为什么不是「任一 2 字 bigram」：q=「zzqxjw没有这部剧」时 bigram「没有」会把
// 「没有道侣就会死」「冰美式没有回头客」判成命中，等于没过滤（推荐池里这类标题很多）。
function keywordNeed(keyword) {
  const cjk = normKeyword(keyword).replace(/[a-z0-9]/g, "").length;
  return Math.max(2, Math.ceil(cjk / 2));
}

// 相关性判定：命中 = 标题（归一化后）包含完整关键词，或关键词里足够长的连续片段出现在标题里。
function matchKeyword(text, keyword) {
  const hay = normKeyword(text);
  const kw = normKeyword(keyword);
  if (!hay || !kw) return false;
  if (hay.includes(kw)) return true; // 完整命中（英文/数字也是整段命中）
  if (!KW_CJK.test(kw)) return false; // 纯英文/数字：只认完整包含，不做片段匹配
  const need = keywordNeed(kw);
  if (need >= kw.length) return false;
  for (let i = 0; i + need <= kw.length; i += 1) {
    if (hay.includes(kw.slice(i, i + need))) return true;
  }
  return false;
}

// 匹配面：标题为主，另外看 remarks/tags（红果的 tags 里常写着「总裁」，标题却不写）。
function matchText(item) {
  const tags = Array.isArray(item.tags) ? item.tags.join(" ") : String(item.tags || "");
  return [item.title, item.remarks, tags].filter(Boolean).join(" ");
}

// 统一后置过滤：所有源（内置红果 + JS 源）的 search 结果都要过这里。
export function matchItems(items, keyword) {
  const list = Array.isArray(items) ? items : [];
  const kw = String(keyword == null ? "" : keyword).trim();
  if (!kw) return list.slice();
  return list.filter((item) => item && matchKeyword(matchText(item), kw));
}

// vod_play_url: 线路用 $$$ 分隔，集用 # 分隔，每集「集名$集ID」
export function splitPlayUrl(vodPlayUrl, vodPlayFrom) {
  const urlStr = String(vodPlayUrl || "");
  if (!urlStr) return [];
  const froms = String(vodPlayFrom || "").split("$$$");

  return urlStr
    .split("$$$")
    .map((line, lineIndex) => {
      const episodes = line
        .split("#")
        .map((chunk, epIndex) => {
          const text = String(chunk || "").trim();
          if (!text) return null;
          const cut = text.indexOf("$");
          const name = cut === -1 ? "" : text.slice(0, cut).trim();
          const id = cut === -1 ? text : text.slice(cut + 1).trim();
          if (!id) return null;
          return { id, name: name || "第 " + (epIndex + 1) + " 集" };
        })
        .filter(Boolean);
      const flag = froms[lineIndex] || "flag";
      return { flag, name: froms[lineIndex] || "线路 " + (lineIndex + 1), episodes };
    })
    .filter((line) => line.episodes.length);
}

function headerValue(headers, name) {
  const target = String(name).toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === target) return String(headers[key] == null ? "" : headers[key]).trim();
  }
  return "";
}

// 翻页记忆：按「源 + 列表 + 关键词」记住各页 id 与该列表见过的最大页大小。
// 源没给 pagecount 时，「本页是否满页 + 是否出现上一页没有的 id」只能靠它判断。
const pageMemory = new Map();
function rememberPage(key, page, items) {
  const ids = new Set(items.map((item) => String(item.id)));
  let slot = pageMemory.get(key);
  if (!slot) slot = { pages: new Map(), size: 0 };
  pageMemory.delete(key); // 重新插入队尾：Map 迭代顺序≈最近使用，淘汰时先丢最久没用的
  slot.pages.set(page, ids);
  if (items.length > slot.size) slot.size = items.length;
  while (slot.pages.size > PAGE_MEMORY_PAGES) slot.pages.delete(slot.pages.keys().next().value);
  pageMemory.set(key, slot);
  while (pageMemory.size > PAGE_MEMORY_MAX) pageMemory.delete(pageMemory.keys().next().value);
  return { prevIds: slot.pages.get(page - 1) || null, size: slot.size };
}

// 统一翻页判定（内置源与 JS 源共用一套规则，禁止「本页条数 >= 24/20 就算还有下一页」的恒真启发式）：
//   1) 空页一律结束（保留原有判定，避免不规范源一直返回 hasMore=true 造成无限滚动）；
//   2) page >= MAX_PAGE 一律结束（硬上限）；
//   3) 源明确声明 hasMore=false（JS 源自己的判断）：直接结束，不再猜；
//   4) 源给了真实 pagecount：page < pagecount 才算有下一页；
//   5) 源没给 pagecount：本页必须满页（达到该列表见过的最大页大小），且出现上一页没有的 id；
//   6) 都判断不了就当作结束。
function nextPage(items, current, pageCount, memory, explicitHasMore) {
  if (!items.length) return false;
  const page = Number(current) || 1;
  if (page >= MAX_PAGE) return false;
  if (explicitHasMore === false) return false;
  const count = Number(pageCount) || 0;
  if (count > 0) return page < count;
  if (!memory) return false;
  if (items.length < memory.size) return false;
  if (!memory.prevIds || !memory.prevIds.size) return true; // 首页没有对照：满页就先给下一页，下一页再判重
  for (const item of items) if (!memory.prevIds.has(String(item.id))) return true;
  return false;
}

export function classifyUrl(url) {
  const value = String(url || "");
  if (/\.m3u8(\?|#|$)/i.test(value) || /\/m3u8/i.test(value) || /format=m3u8/i.test(value)) return "hls";
  if (/\.(mp4|m4v|mov)(\?|#|$)/i.test(value)) return "mp4";
  if (/\.(flv)(\?|#|$)/i.test(value)) return "flv";
  return "mp4";
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(fail("TIMEOUT", message)), ms);
    if (timer && timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 内置红果搜索：官网 JSON 搜索接口（/api/search/result）为主通道，
// 只有它真的不可用时才退化为「首页推荐池本地检索」（结果不全，会带 fallback 标记给前端提示）。
function createBuiltinSearch(provider) {
  const POOL_PAGES = 8;
  const BATCH = 4;
  const CACHE_MS = 30 * 60 * 1000;
  const PER_PAGE = 24;
  const WEB_TIMEOUT = 15000;
  let cache = { time: 0, items: [] };
  let refreshing = null;

  function refresh() {
    // 同一时刻只跑一份刷新，避免多条搜索同时触发重复抓取。
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const items = [];
      const seen = new Set();
      for (let start = 1; start <= POOL_PAGES; start += BATCH) {
        const pages = [];
        for (let page = start; page < start + BATCH && page <= POOL_PAGES; page++) pages.push(page);
        const batches = await Promise.all(
          pages.map((page) => provider.home(page).then((r) => toItems(r.items)).catch(() => [])),
        );
        for (const batch of batches) {
          for (const item of batch) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              items.push(item);
            }
          }
        }
      }
      if (items.length) cache = { time: Date.now(), items };
      return cache;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  // 官网 JSON 搜索：命中即返回，失败才退化到推荐池，最后才抛错。
  async function builtinSearch(keyword, page) {
    let webError = null;
    try {
      const result = await withTimeout(
        provider.search(String(keyword), page),
        WEB_TIMEOUT,
        "内置源检索超时",
      );
      const items = toItems(result.items);
      return {
        source: "hongguo",
        items,
        page: Number(result.page) || page,
        // 只透传源给的真实总页数（官网 totalPages），翻页判定统一交给 nextPage。
        pageCount: Number(result.pageCount) || 0,
        total: Number(result.total) || 0,
        channel: result.channel || "web",
      };
    } catch (error) {
      webError = error;
    }

    // 官网搜索不可用：退回推荐池本地过滤（stale-while-revalidate，避免每次都卡住）。
    if (!cache.items.length) await refresh();
    else if (Date.now() - cache.time > CACHE_MS) refresh().catch(() => {});
    if (!cache.items.length) {
      throw fail(
        "UPSTREAM_ERROR",
        "红果搜索暂不可用：" + String((webError && webError.message) || "上游无响应"),
      );
    }
    const kw = String(keyword).toLowerCase();
    const hits = cache.items.filter((item) =>
      String(item.title).toLowerCase().includes(kw) ||
      String(item.desc).toLowerCase().includes(kw) ||
      String(item.remarks).toLowerCase().includes(kw),
    );
    const start = (page - 1) * PER_PAGE;
    return {
      source: "hongguo",
      items: hits.slice(start, start + PER_PAGE),
      page,
      pageCount: Math.ceil(hits.length / PER_PAGE),
      poolSize: cache.items.length,
      fallback: true,
      channel: "pool",
      error: String((webError && webError.message) || ""),
    };
  }
  builtinSearch.warmup = () => refresh().catch(() => {});
  return builtinSearch;
}

export function createCatalog({ provider, sources }) {
  const builtinSearch = createBuiltinSearch(provider);
  // 推荐池最后一次成功的结果：上游整批失败时用它兜底。
  let recommendGood = null;

  function entryOf(sourceId) {
    const entry = sources.get(sourceId);
    if (!entry) throw fail("NOT_FOUND", "源不存在");
    return entry;
  }

  // 缓存键：不同源、不同页各自一份，避免切源时串味。
  const homeCache = new Map(); // key -> { at, payload }
  const homePending = new Map(); // key -> Promise（防重入：并发只打一次上游）
  const homeKey = (sourceId, pageNo) => sourceId + ":" + pageNo;

  // 真正的取数逻辑（原 home 主体）：只负责取，不碰缓存。
  async function fetchHome(entry, pageNo) {
    if (entry.type === "builtin") {
      const data = await withTimeout(provider.home(pageNo), 30000, "首页加载超时");
      const items = toItems(data.items);
      const classes = Array.isArray(data.classes)
        ? data.classes
          .filter((c) => c && c.id !== undefined)
          .map((c) => ({ id: String(c.id), name: String(c.name || c.id) }))
        : [];
      return {
        source: entry.id,
        kind: "builtin",
        classes,
        items,
        page: pageNo,
        // 首页看官网 loaderData 里的真实 totalPages；拿不到才按「满页 + 新 id」判。
        hasMore: nextPage(items, pageNo, data.pageCount, rememberPage("home:" + entry.id, pageNo, items)),
        filters: data.filters || {},
      };
    }
    const runtime = sources.runtime(entry.id);
    const result = await runtime.call("home", [{}, false], TIMEOUT_HOME);
    const classes = Array.isArray(result && result.class)
      ? result.class
        .filter((c) => c && (c.type_id !== undefined || c.id !== undefined))
        .map((c) => ({ id: String(pick(c.type_id, c.id)), name: String(pick(c.type_name, c.name)) }))
      : [];
    let items = toItems(listOf(result));
    // 多数 JS 源的 home 只给分类、把列表放在 category 里（官方 hongguo.js 也是如此）。
    // 这里兜底取第一个分类的第一页，避免切到这类源时首页一片空白。
    if (!items.length && classes.length) {
      try {
        const first = await runtime.call("category", [classes[0].id, 1, {}, {}], TIMEOUT_HOME);
        items = toItems(listOf(first));
      } catch {
        items = []; // 兜底失败只影响首页推荐位，分类照常可用
      }
    }
    return {
      source: entry.id,
      kind: "js",
      classes,
      items,
      page: 1,
      hasMore: false,
      filters: (result && !Array.isArray(result) && result.filters) || {},
    };
  }

  // 刷新并落缓存；同一 key 并发只跑一份。
  function refreshHome(entry, pageNo) {
    const key = homeKey(entry.id, pageNo);
    const running = homePending.get(key);
    if (running) return running;
    const task = fetchHome(entry, pageNo)
      .then((payload) => {
        // 重新插入到队尾，让 Map 的迭代顺序≈最近使用顺序，淘汰时先丢最久没刷新的。
        homeCache.delete(key);
        homeCache.set(key, { at: Date.now(), payload });
        while (homeCache.size > HOME_CACHE_MAX) homeCache.delete(homeCache.keys().next().value);
        return payload;
      })
      .finally(() => {
        if (homePending.get(key) === task) homePending.delete(key);
      });
    homePending.set(key, task);
    return task;
  }

  async function home(sourceId, page = 1, options = {}) {
    const entry = entryOf(sourceId);
    const pageNo = Number(page) || 1;
    const key = homeKey(entry.id, pageNo);
    const cached = options && options.force ? null : homeCache.get(key);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < HOME_FRESH_MS) return { ...cached.payload, stale: false, age };
    if (cached && age < HOME_STALE_MS) {
      // 过期但还能用：先回上次成功的结果，后台刷新；刷新失败也不影响这次返回。
      refreshHome(entry, pageNo).catch(() => {});
      return { ...cached.payload, stale: true, age };
    }
    try {
      return { ...(await refreshHome(entry, pageNo)), stale: false, age: 0 };
    } catch (error) {
      // 冷缓存 + 刷新失败才真的报错；有历史结果就退回旧首页（可能已很旧）。
      if (cached) return { ...cached.payload, stale: true, age };
      throw error;
    }
  }

  async function category(sourceId, tid, page, extend) {
    const entry = entryOf(sourceId);
    const pageNo = Number(page) || 1;
    if (entry.type === "builtin") {
      if (typeof provider.category === "function") {
        const data = await withTimeout(
          provider.category(String(tid), pageNo, extend || {}),
          40000,
          "分类加载超时"
        );
        const items = toItems(data.items);
        return {
          source: entry.id,
          tid,
          items,
          page: pageNo,
          hasMore: nextPage(
            items,
            pageNo,
            data.pageCount,
            rememberPage("category:" + entry.id + ":" + tid, pageNo, items),
          ),
        };
      }
      const data = await withTimeout(provider.home(pageNo), 30000, "分类加载超时");
      const items = toItems(data.items);
      return {
        source: entry.id,
        tid,
        items,
        page: pageNo,
        hasMore: nextPage(
          items,
          pageNo,
          data.pageCount,
          rememberPage("category:" + entry.id + ":home", pageNo, items),
        ),
        classes: [],
      };
    }
    const result = await sources.runtime(entry.id).call("category", [String(tid), pageNo, {}, extend || {}], TIMEOUT_HOME);
    const items = toItems(listOf(result));
    const current = Number(result && result.page) || pageNo;
    const pageCount = Number(result && result.pagecount) || 0;
    const sourceHasMore = result && typeof result.hasMore === "boolean" ? result.hasMore : undefined;
    return {
      source: entry.id,
      tid,
      items,
      page: current,
      hasMore: nextPage(
        items,
        current,
        pageCount,
        rememberPage("category:" + entry.id + ":" + tid, current, items),
        sourceHasMore,
      ),
    };
  }

  // 搜索三态（内置源与 JS 源统一，前端不用再自己判断）：
  //   a) 过滤后非空：返回过滤结果，hasMore 按源的真实分页判断；
  //   b) 过滤后为空但源有返回：说明这个源根本没按关键词检索（红果无命中会回推荐池、七猫/西饭忽略关键词），
  //      原样返回但打 fallback 标记 + 可读提示，并且 hasMore=false（不许再宣称还有下一页）；
  //   c) 源也没返回：空列表、hasMore=false。
  function finalizeSearch(payload, keyword, pageNo, key) {
    const raw = Array.isArray(payload.items) ? payload.items : [];
    const current = Number(payload.page) || pageNo;
    // 翻页判定用「原始条数」：过滤只决定这一页给什么，不改变源还有没有下一页。
    const hasMore = nextPage(
      raw,
      current,
      payload.pageCount,
      rememberPage(key, current, raw),
      payload.hasMore,
    );
    const base = {
      source: payload.source,
      page: current,
      total: Number(payload.total) || 0,
      channel: payload.channel || "",
    };
    if (payload.poolSize) base.poolSize = payload.poolSize;
    if (!raw.length) return { ...base, items: [], hasMore: false, fallback: false };

    const matched = matchItems(raw, keyword);
    if (matched.length) {
      const result = { ...base, items: matched, hasMore, fallback: false };
      if (matched.length < raw.length) {
        result.filtered = true;
        result.matched = matched.length;
        result.note = "已按关键词过滤：「" + keyword + "」命中 " + matched.length + "/" + raw.length + " 条。";
      }
      if (payload.fallback)
        result.note = (result.note ? result.note + " " : "") + "官网搜索接口暂不可用，已改用推荐池检索。";
      return result;
    }
    if (current > 1) {
      // 翻到后面才发现整页都跟关键词无关：直接收尾，别再塞一页热门剧。
      return { ...base, items: [], hasMore: false, fallback: false, note: "该页没有与「" + keyword + "」匹配的内容。" };
    }
    return {
      ...base,
      items: raw,
      hasMore: false,
      total: raw.length,
      fallback: true,
      fallbackReason: SEARCH_FALLBACK_REASON,
      note: "没有找到与「" + keyword + "」相关的内容，以下是该源返回的热门内容，可换个关键词再试。",
    };
  }

  async function search(sourceId, keyword, page) {
    const entry = entryOf(sourceId);
    const pageNo = Number(page) || 1;
    const kw = String(keyword == null ? "" : keyword);
    if (entry.type === "builtin") {
      const payload = await withTimeout(builtinSearch(kw, pageNo), 30000, "内置源检索超时");
      return finalizeSearch(payload, kw, pageNo, "search:" + entry.id + ":" + normKeyword(kw));
    }

    const result = await sources.runtime(entry.id).call("search", [kw, false, pageNo], TIMEOUT_SEARCH);
    return finalizeSearch(
      {
        source: entry.id,
        items: toItems(listOf(result)),
        page: Number(result && result.page) || pageNo,
        pageCount: Number(result && result.pagecount) || 0,
        hasMore: result && typeof result.hasMore === "boolean" ? result.hasMore : undefined,
      },
      kw,
      pageNo,
      "search:" + entry.id + ":" + normKeyword(kw),
    );
  }

  async function detail(sourceId, id) {
    const entry = entryOf(sourceId);
    if (entry.type === "builtin") {
      // 内置源的 id 是纯数字分集/剧 id；不校验就把它拼进上游请求，
      // 上游对 "__nope__" 这类值回 500，最终变成 502 + axios 英文（review D1/S3）。
      if (!/^\d{1,30}$/.test(String(id))) throw fail("BAD_INPUT", "剧集 id 无效");
      let data;
      try {
        data = await withTimeout(provider.detail(String(id)), 30000, "详情加载超时");
      } catch (error) {
        // 上游对无效 id 会抛 axios 的英文 "Request failed with status code 404"，
        // 原样冒泡会变成 502 + 英文；这里统一成 404 NOT_FOUND，和 /api/play 的判定一致。
        const message = String((error && error.message) || "");
        if (/404|不存在|无效|下架|not found/i.test(message)) throw fail("NOT_FOUND", "剧集不存在或已下架");
        throw error;
      }
      const episodes = (data.episodes || []).map((ep, index) => ({
        id: String(ep.id),
        name: ep.title || "第 " + (index + 1) + " 集",
      }));
      // 用户看详情页时顺手预热第一集的官方清晰度（不阻塞详情返回）：
      // 点播放时 /api/play 直接命中缓存，起播少等 1–2 秒，也不会因超时误判「没有高清档」。
      if (episodes.length && typeof provider.quality === "function") {
        Promise.resolve(provider.quality(episodes[0].id)).catch(() => {});
      }
      return {
        source: entry.id,
        id: String(id),
        title: data.title,
        cover: data.cover,
        desc: data.description || "",
        remarks: data.badge || "",
        tags: normTags(data.tags),
        lines: episodes.length ? [{ flag: "hg", name: "红果（服务端解密）", episodes }] : [],
        episodes,
      };
    }

    const result = await sources.runtime(entry.id).call("detail", [String(id)], TIMEOUT_HOME);
    const vod = Array.isArray(result)
      ? result[0]
      : result && Array.isArray(result.list)
        ? result.list[0]
        : null;
    const norm = normVod(
      vod && typeof vod === "object" ? { ...vod, vod_id: pick(vod.vod_id, vod.id, vod.vid, id) } : null,
    );
    if (!norm) throw fail("EMPTY", "详情为空");
    const lines = splitPlayUrl(vod.vod_play_url, vod.vod_play_from);
    return {
      source: entry.id,
      id: String(id),
      title: norm.title,
      cover: norm.cover,
      desc: norm.desc,
      remarks: norm.remarks,
      tags: norm.tags,
      lines,
      episodes: lines.length ? lines[0].episodes : [],
    };
  }

  async function play(sourceId, { flag, id }) {
    const entry = entryOf(sourceId);
    if (!id) throw fail("BAD_INPUT", "缺少剧集 id");
    if (entry.type === "builtin") {
      if (!/^\d{1,30}$/.test(String(id))) throw fail("BAD_INPUT", "剧集 id 无效");
      // 官方接口能取到真实多档（360P–1080P，全部 HEVC + CENC），服务端解密后按 Range 转发。
      // 菜单要如实反映可用档位：查不到档位时只列 360P 兼容档，不伪造点不开的高清项。
      // 档位信息只用于渲染菜单：它失败（超时/上游抖动/熔断）不能连累取流地址，否则本来能播的剧也 502。
      let info = null;
      try {
        info = await provider.quality(String(id));
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "play_quality_failed",
            id: String(id),
            message: String((error && error.message) || error),
          })
        );
      }
      // 分集不存在时官方接口回「model 返回错误码 101000」（实测假 id/把剧 id 当集 id 都是它）。
      // 以前只 warn 就当能播，于是假 id 也返回 200 + 可播地址。这里只把「明确的缺失/无效」映射成 404；
      // 超时、限流、风控、HTTP 5xx 等上游故障不匹配，仍按原样降级成兼容档（不能掩盖成 404）。
      const qualityError = String((info && info.error) || "");
      if (qualityError && /不存在|无效|404|下架|not found|101000/i.test(qualityError)) {
        throw fail("NOT_FOUND", "剧集不存在或已下架");
      }
      const all = info && Array.isArray(info.tiers) && info.tiers.length ? info.tiers : null;
      // 1080P 是 HEVC（设备/浏览器支持时可硬解）；360P–720P 是 H.266/VVC，浏览器一定解不了。
      // 只有服务端装了 7.1+ 的 ffmpeg 时，VVC 档才以「服务端边转码成 H.264」的形式提供（可播放但不可拖动）。
      const canTranscode = transcodeAvailable();
      const vvcCount = all ? all.filter((tier) => tier.codec === "vvc").length : 0;
      const tiers = all ? all.filter((tier) => tier.codec !== "vvc" || canTranscode) : null;
      // 「自动」实际上等价于最高档：把它的 codec 标成最高档编码，前端才能按本机解码能力
      // 正确置灰/回落（否则无 HEVC 的浏览器会默认起播必然黑屏的 1080P HEVC 流）。
      const topTier = tiers && tiers.length ? tiers[0] : null;
      const options = [
        {
          key: "auto",
          label: "自动（最高）",
          height: topTier ? topTier.height : 0,
          codec: topTier ? topTier.codec : "",
          transcode: false,
          url: "/api/stream/" + id + "?q=auto",
        },
        ...(tiers || []).map((tier) => {
          const transcoded = tier.codec === "vvc";
          return {
            key: tier.key,
            label: tier.label,
            height: tier.height,
            codec: tier.codec,
            transcode: transcoded,
            url: "/api/stream/" + id + "?q=" + encodeURIComponent(tier.key) + (transcoded ? "&tc=1" : ""),
          };
        }),
        { key: "compat", label: "360P 兼容", height: 360, codec: "h264", transcode: false, url: "/api/stream/" + id + "?q=compat" },
      ];
      const noteParts = [];
      if (tiers) noteParts.push("1080P 为 HEVC 编码：设备支持 HEVC 时可硬解，不支持时自动回落到 360P 兼容线路。");
      if (canTranscode && vvcCount)
        noteParts.push("360P–720P 是 H.266/VVC，浏览器无法解码，已由服务端边转码成 H.264（可播放，但不能拖动进度）。");
      else if (vvcCount)
        noteParts.push("官方 360P–720P 档位是 H.266/VVC 编码，浏览器无法解码，且服务端未启用转码（安装 ffmpeg 7.1+ 后可用），未列入菜单。");
      return {
        type: "native",
        url: "/api/stream/" + id + "?q=auto",
        contentType: "video/mp4",
        quality: {
          options,
          note: noteParts.length ? noteParts.join(" ") : "未取到高清档（官方接口暂不可用），当前仅提供 360P 兼容线路。",
        },
      };
    }

    const out = await sources.runtime(entry.id).call("play", [String(flag || "flag"), String(id), []], TIMEOUT_SEARCH);
    let url = "";
    let headers = {};
    if (typeof out === "string") {
      url = out;
    } else if (out && typeof out === "object") {
      if (out.parse && Number(out.parse) !== 0)
        throw fail("NEED_PARSE", "该源需要 webview 嗅探解析（parse=1），网页版无法直接播放");
      const rawUrl = pick(out.url, out.playUrl, out.play_url);
      url = rawUrl == null ? "" : String(rawUrl).trim();
      const rawHeaders = out.header || out.headers;
      headers = rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders) ? rawHeaders : {};
    }
    if (!url) {
      // 源用 error 字段说明原因（内置源约定的 MISSING_EPISODE 等）。区分两件事：
      //   - 上游网络/限流故障 -> 502（UPSTREAM_ERROR），不能伪装成 404；
      //   - 其余（没有这一集/分集不存在）-> 404 NOT_FOUND，不能 200 返回空地址。
      const sourceError = String((out && !Array.isArray(out) && (out.error || out.err || out.msg)) || "");
      if (/UPSTREAM_FAILED|UPSTREAM|TIMEOUT|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|TLS|HTTP\s*\d{3}|限流|风控|网络/i.test(sourceError)) {
        throw fail("UPSTREAM_ERROR", "该源上游暂时不可用：" + (sourceError || "无响应"));
      }
      throw fail("NOT_FOUND", "该源没有这一集（分集可能不存在）");
    }
    if (/^[0-9a-f]{32}$/i.test(url)) throw fail("ENCRYPTED", "该源返回加密标识而非播放地址，网页版暂不支持");
    // 很多源返回协议相对地址（//cdn/x.m3u8），浏览器能识别但服务端 new URL 会失败。
    if (url.startsWith("//")) url = "https:" + url;

    const type = classifyUrl(url);
    const referer = headerValue(headers, "referer");
    // 部分源只接受自己的 UA（如 okhttp/牛牛），把 UA 也带到代理参数里。
    const userAgent = headerValue(headers, "user-agent").replace(/[\r\n]/g, "").slice(0, 300);
    const encoded = encodeURIComponent(url);
    const proxyBase = type === "hls" ? "/api/hls?u=" : "/api/media?u=";
    return {
      type,
      url: proxyBase + encoded +
        (referer ? "&r=" + encodeURIComponent(referer) : "") +
        (userAgent ? "&ua=" + encodeURIComponent(userAgent) : ""),
      sourceUrl: url,
      headers,
    };
  }

  // 播放降级：主源取不到流时，用剧名到其它源找同一部剧，返回可直接跳转的候选（含对应集序号）。
  // 只做检索与详情校验，不预先取流——换源是否可播由前端实际播放时判定。
  async function playFallback(sourceId, { id, index } = {}) {
    const entry = entryOf(sourceId);
    const targetId = String(id || "").trim();
    if (!targetId) throw fail("BAD_INPUT", "缺少剧 id");
    const epIndex = Math.max(0, Math.floor(Number(index) || 0));
    const base = await withTimeout(detail(entry.id, targetId), 30000, "详情加载超时");
    const title = String(base.title || "").trim();
    if (!title) throw fail("EMPTY", "无法确定剧名，不能自动换源");
    const others = sources.list().sources.filter((item) => item.id !== entry.id && !FALLBACK_SKIP.has(item.id));
    const found = await Promise.all(
      others.map(async (item) => {
        try {
          const result = await withTimeout(search(item.id, title, 1), FALLBACK_TIMEOUT, "换源检索超时");
          let best = null;
          for (const candidate of result.items || []) {
            const score = titleScore(candidate.title, title);
            if (!best || score > best.score) best = { id: candidate.id, title: candidate.title, score };
          }
          if (!best || best.score < FALLBACK_MIN_SCORE) return null;
          const data = await withTimeout(detail(item.id, best.id), FALLBACK_TIMEOUT, "换源详情超时");
          const episodes = (data.lines && data.lines[0] && data.lines[0].episodes) || data.episodes || [];
          if (!episodes.length) return null;
          const target = Math.min(epIndex, episodes.length - 1);
          return {
            source: item.id,
            name: item.name || item.id,
            id: best.id,
            title: data.title || best.title || title,
            episodeCount: episodes.length,
            targetIndex: target,
            episodeName: String((episodes[target] && episodes[target].name) || ""),
            score: Math.round(best.score * 1000) / 1000,
          };
        } catch {
          return null; // 单个源失败只少一个候选，不影响整体降级
        }
      }),
    );
    const candidates = found
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.episodeCount - a.episodeCount)
      .slice(0, FALLBACK_MAX);
    return { source: entry.id, id: targetId, title, epIndex, candidates };
  }

  // 聚合搜索：并发问所有源（各取同一页），轮转交错合并，单源失败不影响整体。
  async function searchAll(keyword, page = 1) {
    const pageNo = Number(page) || 1;
    const groups = await Promise.all(
      sources.list().sources.filter((source) => !AGGREGATE_SKIP.has(source.id)).map(async (source) => {
        const started = Date.now();
        const kw = String(keyword == null ? "" : keyword);
        try {
          // 内置源走同一套 finalizeSearch，聚合结果与单源搜索的 fallback/hasMore 语义完全一致。
          const result = source.type === "builtin"
            ? finalizeSearch(
              await withTimeout(builtinSearch(kw, pageNo), 30000, "内置源检索超时"),
              kw,
              pageNo,
              "search:" + source.id + ":" + normKeyword(kw),
            )
            : await withTimeout(search(source.id, kw, pageNo), TIMEOUT_AGGREGATE, "聚合检索超时");
          return {
            source: source.id,
            name: source.name,
            ms: Date.now() - started,
            items: (result.items || []).map((item) => ({ ...item, source: source.id, sourceName: source.name })),
            hasMore: Boolean(result.hasMore),
            fallback: Boolean(result.fallback),
            fallbackReason: result.fallbackReason || "",
            note: result.note || "",
            poolSize: result.poolSize || 0,
          };
        } catch (error) {
          return {
            source: source.id,
            name: source.name,
            ms: Date.now() - started,
            items: [],
            hasMore: false,
            error: String((error && error.message) || error).replace(/https?:\/\/\S+/g, "上游地址"),
          };
        }
      }),
    );

    const items = [];
    const longest = groups.reduce((max, group) => Math.max(max, group.items.length), 0);
    for (let i = 0; i < longest; i++) for (const group of groups) if (group.items[i]) items.push(group.items[i]);

    return {
      aggregate: true,
      q: keyword,
      page: pageNo,
      items,
      // 聚合整体还有下一页 = 至少一组还有，且没到翻页硬上限。
      hasMore: pageNo < MAX_PAGE && groups.some((group) => group.hasMore),
      groups: groups.map((group) => ({
        source: group.source,
        name: group.name,
        count: group.items.length,
        ms: group.ms,
        hasMore: group.hasMore,
        fallback: group.fallback,
        fallbackReason: group.fallbackReason || "",
        note: group.note || "",
        poolSize: group.poolSize,
        error: group.error,
      })),
    };
  }

  // 运维：清空目录层缓存（首页 SWR 各页 + 推荐页上次成功结果）。
  // homePending 里的在途请求不清：清掉反而会让同一次刷新跑两份，它自己结束就会出队。
  function clearCache() {
    const homes = homeCache.size;
    homeCache.clear();
    const recommend = recommendGood ? 1 : 0;
    recommendGood = null;
    return { homes, recommend };
  }

  // 启动预热：把内置红果推荐池先抓进缓存，避免用户第一次搜索等 5–10 秒。
  function warmup() {
    return builtinSearch.warmup ? builtinSearch.warmup() : Promise.resolve();
  }

  // 源健康检查：默认只校验首页/详情可达（快）；deep=1 时额外真实取流校验首块是否为 ftyp。
  async function health(sourceId, options = {}) {
    const entry = entryOf(sourceId);
    const deep = Boolean(options && options.deep);
    const started = Date.now();
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // 健康检查要探真实上游：force 绕过首页缓存，否则缓存命中会把故障源判成正常。
        const homeData = await withTimeout(home(entry.id, 1, { force: true }), 15000, "健康检查超时");
        let playback = null;
        if (deep && entry.type === "builtin" && homeData.items.length) {
          const first = homeData.items[0];
          try {
            playback = await withTimeout((async () => {
              const detail = await withTimeout(provider.detail(String(first.id)), 15000, "健康检查详情超时");
              const episode = detail.episodes && detail.episodes[0];
              if (!episode) return null;
              const stream = await withTimeout(provider.stream(String(episode.id), { track: false }), 20000, "健康检查取流超时");
              const chunk = await stream.chunk(0, Math.min(15, Math.max(0, stream.total - 1)));
              const head = Buffer.from(chunk).subarray(4, 8).toString("ascii");
              return {
                ok: chunk.length >= 8 && head === "ftyp",
                bytes: chunk.length,
                total: stream.total,
                head,
              };
            })(), 15000, "深度自检超时");
          } catch (error) {
            playback = { ok: false, error: String((error && error.message) || error) };
          }
        }
        return {
          source: entry.id,
          name: entry.name,
          ok: true,
          ms: Date.now() - started,
          items: homeData.items.length,
          playback,
          degraded: Boolean(playback && !playback.ok),
        };
      } catch (error) {
        lastError = String((error && error.message) || error);
        // 首页本身是网络瞬断时重试一次；语义错误不重试。
        if (attempt === 0 && /ENOTFOUND|EAI_AGAIN|ECONN|socket|TLS|disconnected|timeout|超时/i.test(lastError)) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        break;
      }
    }
    return {
      source: entry.id,
      name: entry.name,
      ok: false,
      ms: Date.now() - started,
      items: 0,
      error: lastError.replace(/https?:\/\/\S+/g, "上游地址"),
    };
  }

  // 推荐页：红果各榜单按真实评分合并后的稳定列表，按页切分给前端。
  async function recommend(page = 1) {
    const pageNo = Number(page) || 1;
    let pool = null;
    let stale = false;
    try {
      pool = await withTimeout(provider.recommendPool(), 45000, "推荐加载超时");
      recommendGood = { at: Date.now(), pool };
    } catch (error) {
      // 四条榜整批失败（上游风控/网络）时回落上次成功的结果，推荐页不至于整页报错。
      if (!recommendGood) throw error;
      pool = recommendGood.pool;
      stale = true;
    }
    const start = (pageNo - 1) * RECOMMEND_PER_PAGE;
    const slice = pool.slice(start, start + RECOMMEND_PER_PAGE);
    return {
      source: "hongguo",
      sourceName: "红果推荐",
      recommend: true,
      page: pageNo,
      items: slice.map((row) => {
        const item = normVod(row);
        if (!item) return null;
        return {
          ...item,
          source: "hongguo",
          sourceName: row.bang || "红果热播榜",
          score: row.score,
          heat: row.heat,
          bang: row.bang,
          rank: row.rank,
        };
      }).filter(Boolean),
      // 池子按真实长度判定，并同样受 MAX_PAGE 硬上限约束（空页/末页都为 false）。
      hasMore: pageNo < MAX_PAGE && start + slice.length < pool.length,
      total: pool.length,
      stale,
    };
  }

  return { home, category, search, searchAll, recommend, detail, play, playFallback, health, warmup, clearCache };
}
