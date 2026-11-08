/**
 * 七猫短剧 CatPawOpen Spider (qimao.js)
 * 写法对齐官方 hongguo.js：
 *   - category/search 返回 { page, pagecount: hasMore ? page+1 : page, hasMore, list }
 *   - 翻页失败自动降级成「没有下一页」，不把错误抛回首页（避免 App 反复重试）
 *   - 统一错误对象带 code（MISSING_EPISODE / INVALID_RESPONSE ...）
 *   - 分页状态带 TTL 缓存，页数超过上限即收尾
 * 沙箱没有 btoa / crypto，MD5 与 Base64 在本文件内自带实现。
 */
const meta = {
  id: "qimao",
  name: "七猫短剧",
  version: "1.1.0",
  description: "七猫短剧官方接口，支持分类、搜索、详情与直链播放",
  author: "THL adapter",
  type: "video",
  icon: "",
  features: ["search", "categories"]
};

const HOST = "https://api-store.qmplaylet.com";
const HOST_READ = "https://api-read.qmplaylet.com";
const KEYS = "d3dGiJc651gSQ8w1";
const TRACK_ID = "ec1280db127955061754851657967";
const UA = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_PAGE = 20;
const TTL = 30 * 60 * 1000;
const states = new Map();

/* ---------------- 基础工具 ---------------- */
const text = (v) => (v === null || v === undefined ? "" : String(v));
const number = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
};
const cleanText = (v) => text(v).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const failure = (message, code) => Object.assign(new Error(message), { code: code });

/* ---------------- Base64 / MD5（纯 JS） ---------------- */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return out;
}

function base64(bytes) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += chars.charAt(b0 >> 2);
    out += chars.charAt(((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4));
    out += b1 === undefined ? "=" : chars.charAt(((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6));
    out += b2 === undefined ? "=" : chars.charAt(b2 & 63);
  }
  return out;
}

const MD5_S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
const MD5_K = (() => {
  const k = [];
  for (let i = 0; i < 64; i++) k[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;
  return k;
})();

const rotl = (x, n) => (x << n) | (x >>> (32 - n));

function md5Hex(str) {
  const msg = utf8Bytes(str);
  const len = msg.length;
  const words = [];
  for (let i = 0; i < len; i++) words[i >> 2] = (words[i >> 2] || 0) | (msg[i] << ((i % 4) * 8));
  words[len >> 2] = (words[len >> 2] || 0) | (0x80 << ((len % 4) * 8));
  const totalWords = (((len + 8) >> 6) + 1) * 16;
  while (words.length < totalWords) words.push(0);
  words[totalWords - 2] = (len * 8) >>> 0;
  words[totalWords - 1] = Math.floor((len * 8) / 4294967296);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let block = 0; block < words.length; block += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      let F, g;
      if (j < 16) { F = (B & C) | (~B & D); g = j; }
      else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * j) % 16; }
      F = (F + A + MD5_K[j] + (words[block + g] | 0)) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, MD5_S[j])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const hex = (v) => {
    let s = "";
    for (let i = 0; i < 4; i++) {
      const b = (v >>> (i * 8)) & 0xff;
      s += (b < 16 ? "0" : "") + b.toString(16);
    }
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

/* ---------------- 七猫请求头 ---------------- */
const CHAR_MAP = {"+":"P","/":"X","0":"M","1":"U","2":"l","3":"E","4":"r","5":"Y","6":"W","7":"b","8":"d","9":"J","A":"9","B":"s","C":"a","D":"I","E":"0","F":"o","G":"y","H":"_","I":"H","J":"G","K":"i","L":"t","M":"g","N":"N","O":"A","P":"8","Q":"F","R":"k","S":"3","T":"h","U":"f","V":"R","W":"q","X":"C","Y":"4","Z":"p","a":"m","b":"B","c":"O","d":"u","e":"c","f":"6","g":"K","h":"x","i":"5","j":"T","k":"-","l":"2","m":"z","n":"S","o":"Z","p":"1","q":"V","r":"v","s":"j","t":"Q","u":"7","v":"D","w":"w","x":"n","y":"L","z":"e"};

function qmHeaders() {
  const data = {
    "static_score": "0.8",
    "uuid": "00000000-7fc7-08dc-0000-000000000000",
    "device-id": "20250220125449b9b8cac84c2dd3d035c9052a2572f7dd0122edde3cc42a70",
    "mac": "",
    "sourceuid": "aa7de295aad621a6",
    "refresh-type": "0",
    "model": "22021211RC",
    "wlb-imei": "",
    "client-id": "aa7de295aad621a6",
    "brand": "Redmi",
    "oaid": "",
    "oaid-no-cache": "",
    "sys-ver": "12",
    "trusted-id": "",
    "phone-level": "H",
    "imei": "",
    "wlb-uid": "aa7de295aad621a6",
    "session-id": String(Date.now())
  };
  const encoded = base64(utf8Bytes(JSON.stringify(data)));
  let qmParams = "";
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded.charAt(i);
    qmParams += CHAR_MAP[ch] || ch;
  }
  const sign = md5Hex("AUTHORIZATION=app-version=10001application-id=com.duoduo.readchannel=unknownis-white=net-env=5platform=androidqm-params=" + qmParams + "reg=" + KEYS);
  return {
    "net-env": "5",
    "reg": "",
    "channel": "unknown",
    "is-white": "",
    "platform": "android",
    "application-id": "com.duoduo.read",
    "authorization": "",
    "app-version": "10001",
    "user-agent": "webviewversion/0",
    "qm-params": qmParams,
    "sign": sign
  };
}

/* ---------------- 网络 ---------------- */
async function requestJson(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: qmHeaders(), timeoutMs: 15000 });
      const body = await res.text();
      if (!res.ok) throw failure("七猫接口返回 HTTP " + res.status, "HTTP_" + res.status);
      let data = null;
      try { data = JSON.parse(body); } catch (e) { throw failure("七猫接口返回非 JSON", "INVALID_RESPONSE"); }
      if (data && data.errors) {
        throw failure(text(data.errors.details || data.errors.title || "接口拒绝请求"), "REJECTED");
      }
      return data || {};
    } catch (err) {
      lastError = err;
      if (err && err.code === "INVALID_RESPONSE") break;
    }
  }
  throw lastError || failure("七猫接口请求失败", "REQUEST_FAILED");
}

/* ---------------- 列表映射 ---------------- */
function toItem(vod) {
  const id = text(vod.playlet_id || vod.id).trim();
  const remarks = [];
  const episodes = number(vod.total_episode_num);
  if (episodes > 0) remarks.push(episodes + "集");
  if (number(vod.is_over) === 1) remarks.push("已完结");
  return {
    vod_id: id,
    vod_name: cleanText(vod.title) || ("短剧 " + id),
    vod_pic: text(vod.image_link),
    vod_remarks: remarks.join(" · ")
  };
}

function mapList(rows) {
  const list = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const item = toItem(rows[i]);
    if (item.vod_id) list.push(item);
  }
  return list;
}

/* ---------------- 分页状态 ---------------- */
function pageState(key) {
  let state = states.get(key);
  if (state && Date.now() - state.updated < TTL) return state;
  state = { pages: new Map(), updated: Date.now() };
  states.delete(key);
  states.set(key, state);
  while (states.size > 32) states.delete(states.keys().next().value);
  return state;
}

function packPage(state, page, list, hasMore) {
  // 有下一页游标、且本页确实有数据、且没到页数上限，才算还有更多
  const more = Boolean(hasMore) && list.length > 0 && page < MAX_PAGE;
  const result = { page: page, pagecount: more ? page + 1 : page, hasMore: more, list: list };
  state.pages.set(page, result);
  state.updated = Date.now();
  return result;
}

/* ---------------- Spider 接口 ---------------- */
function init(extend) {
  states.clear();
}

async function home(filter) {
  const sign = md5Hex("operation=1playlet_privacy=1tag_id=0" + KEYS);
  const response = await requestJson(HOST + "/api/v1/playlet/index?tag_id=0&playlet_privacy=1&operation=1&sign=" + sign);
  const payload = response.data || {};
  const classes = [];
  const seen = {};
  const groups = payload.tag_categories || [];
  for (let i = 0; i < groups.length; i++) {
    const tags = (groups[i] && groups[i].tags) || [];
    for (let k = 0; k < tags.length; k++) {
      const tag = tags[k];
      if (!tag || tag.tag_id === undefined) continue;
      const id = text(tag.tag_id);
      if (seen[id]) continue;
      seen[id] = true;
      classes.push({ type_id: id, type_name: cleanText(tag.tag_name) || id });
    }
  }
  if (classes.length === 0) {
    const flat = payload.tag_items || [];
    for (let i = 0; i < flat.length; i++) {
      const id = text(flat[i].tag_id);
      if (seen[id]) continue;
      seen[id] = true;
      classes.push({ type_id: id, type_name: cleanText(flat[i].tag_name) || id });
    }
  }
  return { class: classes, filters: {} };
}

async function category(tid, page, filter, extend) {
  const tagId = text(tid) || "0";
  const current = Math.max(1, number(page) || 1);
  const state = pageState("qimao:" + tagId);
  if (state.pages.has(current)) return state.pages.get(current);

  // 翻页用上一页响应里的 next_id 游标，而不是页码本身
  const cursor = current <= 1 ? "" : text(state.cursor);
  if (current > 1 && !cursor) return { page: current, pagecount: current, hasMore: false, list: [] };

  try {
    let url;
    if (current <= 1) {
      url = HOST + "/api/v1/playlet/index?tag_id=" + encodeURIComponent(tagId) +
        "&playlet_privacy=1&operation=1&sign=" + md5Hex("operation=1playlet_privacy=1tag_id=" + tagId + KEYS);
    } else {
      url = HOST + "/api/v1/playlet/index?tag_id=" + encodeURIComponent(tagId) +
        "&next_id=" + encodeURIComponent(cursor) + "&playlet_privacy=1&operation=1&sign=" +
        md5Hex("next_id=" + cursor + "operation=1playlet_privacy=1tag_id=" + tagId + KEYS);
    }
    const response = await requestJson(url);
    const data = response.data || {};
    state.cursor = text(data.next_id);
    const list = mapList(data.list);
    return packPage(state, current, list, state.cursor !== "");
  } catch (err) {
    // 与官方一致：后续页失败时降级成「没有下一页」，不把错误抛回首页
    if (current > 1) {
      return { page: current, pagecount: current, hasMore: false, list: [] };
    }
    throw err;
  }
}

async function detail(id) {
  const playletId = text(id).replace(/^qimao:/, "").trim();
  if (!/^\d+$/.test(playletId)) throw failure("无效的短剧 ID", "INVALID_ID");

  const url = HOST_READ + "/player/api/v1/playlet/info?playlet_id=" + encodeURIComponent(playletId) +
    "&sign=" + md5Hex("playlet_id=" + playletId + KEYS);
  const response = await requestJson(url);
  const data = response.data || {};

  const plays = (data.play_list || []).slice();
  plays.sort((a, b) => number(a.sort) - number(b.sort));

  const episodes = [];
  for (let i = 0; i < plays.length; i++) {
    const epUrl = text(plays[i].video_url);
    if (!/^https?:\/\//i.test(epUrl)) continue;
    const sort = number(plays[i].sort);
    const name = sort > 0 ? "第" + sort + "集" : "第" + (episodes.length + 1) + "集";
    episodes.push(name + "$" + epUrl);
  }

  const remarks = [];
  const total = number(data.total_episode_num);
  if (total > 0) remarks.push(total + "集");
  if (episodes.length > 0 && total === 0) remarks.push("全" + episodes.length + "集");
  if (data.tags) remarks.push(cleanText(data.tags));

  return {
    list: [{
      vod_id: playletId,
      vod_name: cleanText(data.title) || ("短剧 " + playletId),
      vod_pic: text(data.image_link),
      vod_content: cleanText(data.intro),
      vod_remarks: remarks.join(" · "),
      vod_play_from: "七猫短剧",
      vod_play_url: episodes.join("#")
    }]
  };
}

async function search(keyword, quick, page) {
  const word = cleanText(keyword).slice(0, 60);
  const current = Math.max(1, number(page) || 1);
  if (!word) return { page: 1, pagecount: 1, hasMore: false, list: [] };

  const state = pageState("qimao:search:" + word);
  if (state.pages.has(current)) return state.pages.get(current);

  try {
    const sign = md5Hex("extend=page=" + current + "read_preference=0track_id=" + TRACK_ID + "wd=" + word + KEYS);
    const url = HOST + "/api/v1/playlet/search?extend=&page=" + current +
      "&wd=" + encodeURIComponent(word) + "&read_preference=0&track_id=" + TRACK_ID + "&sign=" + sign;
    const response = await requestJson(url);
    const list = mapList((response.data || {}).list);
    // 搜索接口不给游标：本页有数据就当还有下一页，直到拉回空页为止
    return packPage(state, current, list, current < MAX_PAGE);
  } catch (err) {
    if (current > 1) {
      return { page: current, pagecount: current, hasMore: false, list: [] };
    }
    throw err;
  }
}

async function play(flag, id, flags) {
  const target = text(id).replace(/^qimao:/, "").trim();
  if (/^https?:\/\/[^\s]+$/i.test(target)) {
    return { parse: 0, url: target, header: { "User-Agent": UA } };
  }
  return { parse: 0, url: "", header: {}, error: "MISSING_EPISODE" };
}

var spider = {
  meta: meta,
  init: init,
  home: home,
  category: category,
  detail: detail,
  search: search,
  play: play
};

