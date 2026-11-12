/**
 * 牛牛短剧 CatPawOpen Spider (niuniu.js)
 * 首页/分类/搜索/详情走 new.tianjinzhitongdaohe.com 的公开接口；
 * 播放走穿山甲(CSJ)签名接口，需要 AES-128-ECB + HMAC-SHA256。
 * 本文件内置纯 JS 实现，不依赖 Node crypto / Buffer。
 */
const meta = {
  id: "niuniu",
  name: "牛牛短剧",
  version: "1.0.0",
  description: "牛牛短剧官方接口，支持分类、搜索、详情与直链播放",
  author: "THL adapter",
  type: "video",
  icon: "",
  features: ["search", "categories"],
  updateUrl: "https://raw.githubusercontent.com/kid941005/hongguo-web/main/sources/builtin/niuniu.js"
};

const HOST = "https://new.tianjinzhitongdaohe.com";
const CSJ_HOST = "https://csj-sp.csjdeveloper.com";
const UA = "okhttp/4.12.0";
const PAGE_SIZE = 24;
const SEARCH_SIZE = 30;
const MAX_PAGE = 50;
const TTL = 30 * 60 * 1000;
const SESSION_TTL = 55 * 60 * 1000;
const states = new Map();
const coverCache = new Map();
const COVER_TTL = 6 * 60 * 60 * 1000;
const COVER_BAD_HOST = /cattleduanju\.oss-cn-beijing\.aliyuncs\.com/i;

const CATE_FALLBACK = ["现言", "古言", "历史", "都市", "亲情", "玄幻", "热血", "喜剧", "悬疑", "其他剧情"];
const CSJ_KEYS = {
  login: "dafdb3d2a5c343d6",
  detail: "ce49b18dd4e0a4d8",
  sign: "aceaa47f96b4875d446b2e1d97e03bbb"
};

let visitorToken = "";
let visitorAt = 0;
let accessToken = "";
let accessAt = 0;

const text = (v) => (v === null || v === undefined ? "" : String(v));
const number = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
};
const cleanText = (v) => text(v).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const failure = (message, code) => Object.assign(new Error(message), { code: code });

/* ---------------- 纯 JS AES-128-ECB / SHA-256 / HMAC ---------------- */
function gmul(a, b) {
  let p = 0;
  let x = a & 0xff;
  let y = b & 0xff;
  for (let i = 0; i < 8; i++) {
    if (y & 1) p ^= x;
    const hi = x & 0x80;
    x = (x << 1) & 0xff;
    if (hi) x ^= 0x1b;
    y >>= 1;
  }
  return p & 0xff;
}
function gpow(a, n) {
  let r = 1;
  let x = a & 0xff;
  while (n > 0) {
    if (n & 1) r = gmul(r, x);
    x = gmul(x, x);
    n >>= 1;
  }
  return r;
}
function rotl8(x, n) { return ((x << n) | (x >> (8 - n))) & 0xff; }
const SBOX = (() => {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const inv = i === 0 ? 0 : gpow(i, 254);
    box[i] = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63) & 0xff;
  }
  return box;
})();
const INV_SBOX = (() => {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[SBOX[i]] = i;
  return box;
})();

function xtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }
function expandKey(keyBytes) {
  const w = new Uint8Array(176);
  for (let i = 0; i < 16; i++) w[i] = keyBytes[i];
  let pos = 16;
  let rcon = 1;
  while (pos < 176) {
    const t0 = w[pos - 4], t1 = w[pos - 3], t2 = w[pos - 2], t3 = w[pos - 1];
    if (pos % 16 === 0) {
      w[pos] = w[pos - 16] ^ SBOX[t1] ^ rcon;
      w[pos + 1] = w[pos - 15] ^ SBOX[t2];
      w[pos + 2] = w[pos - 14] ^ SBOX[t3];
      w[pos + 3] = w[pos - 13] ^ SBOX[t0];
      rcon = xtime(rcon);
    } else {
      w[pos] = w[pos - 16] ^ t0;
      w[pos + 1] = w[pos - 15] ^ t1;
      w[pos + 2] = w[pos - 14] ^ t2;
      w[pos + 3] = w[pos - 13] ^ t3;
    }
    pos += 4;
  }
  return w;
}
function addRoundKey(state, w, round) {
  for (let i = 0; i < 16; i++) state[i] ^= w[round * 16 + i];
}
function subBytes(state, box) {
  for (let i = 0; i < 16; i++) state[i] = box[state[i]];
}
function shiftRows(state) {
  const copy = state.slice();
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) state[r + 4 * c] = copy[r + 4 * ((c + r) % 4)];
  }
}
function invShiftRows(state) {
  const copy = state.slice();
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) state[r + 4 * c] = copy[r + 4 * ((c - r + 4) % 4)];
  }
}
function mixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const a0 = state[4 * c], a1 = state[4 * c + 1], a2 = state[4 * c + 2], a3 = state[4 * c + 3];
    state[4 * c] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
    state[4 * c + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
    state[4 * c + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
    state[4 * c + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
  }
}
function invMixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const a0 = state[4 * c], a1 = state[4 * c + 1], a2 = state[4 * c + 2], a3 = state[4 * c + 3];
    state[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    state[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    state[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    state[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}
function encryptBlock(block, w) {
  const state = block.slice();
  addRoundKey(state, w, 0);
  for (let round = 1; round <= 9; round++) {
    subBytes(state, SBOX);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, w, round);
  }
  subBytes(state, SBOX);
  shiftRows(state);
  addRoundKey(state, w, 10);
  return state;
}
function decryptBlock(block, w) {
  const state = block.slice();
  addRoundKey(state, w, 10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(state);
    subBytes(state, INV_SBOX);
    addRoundKey(state, w, round);
    invMixColumns(state);
  }
  invShiftRows(state);
  subBytes(state, INV_SBOX);
  addRoundKey(state, w, 0);
  return state;
}
function utf8Bytes(str) {
  const out = [];
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = s.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}
function bytesToUtf8(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[++i] & 0x3f));
    else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f));
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[++i] & 0x3f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f);
      out += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
    }
  }
  return out;
}
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_CHARS.charAt(b0 >> 2);
    out += B64_CHARS.charAt(((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4));
    out += b1 === undefined ? "=" : B64_CHARS.charAt(((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6));
    out += b2 === undefined ? "=" : B64_CHARS.charAt(b2 & 63);
  }
  return out;
}
function base64ToBytes(value) {
  const clean = String(value).replace(/[^A-Za-z0-9+/=]/g, "");
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean.charAt(i);
    if (ch === "=") break;
    const idx = B64_CHARS.indexOf(ch);
    if (idx < 0) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}
function aesEncryptBase64(plain, key) {
  const keyBytes = utf8Bytes(key);
  const w = expandKey(keyBytes);
  const input = utf8Bytes(plain);
  const pad = 16 - (input.length % 16);
  for (let i = 0; i < pad; i++) input.push(pad);
  const out = [];
  for (let offset = 0; offset < input.length; offset += 16) {
    const block = encryptBlock(input.slice(offset, offset + 16), w);
    for (let i = 0; i < 16; i++) out.push(block[i]);
  }
  return bytesToBase64(out);
}
function aesDecryptBase64(cipher, key) {
  const keyBytes = utf8Bytes(key);
  const w = expandKey(keyBytes);
  const input = base64ToBytes(cipher);
  const out = [];
  for (let offset = 0; offset < input.length; offset += 16) {
    const block = decryptBlock(Array.prototype.slice.call(input, offset, offset + 16), w);
    for (let i = 0; i < 16; i++) out.push(block[i]);
  }
  const pad = out.length ? out[out.length - 1] : 0;
  if (pad >= 1 && pad <= 16 && pad <= out.length) out.length -= pad;
  return bytesToUtf8(out);
}

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
function sha256(bytes) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[bytes.length] = 0x80;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  m[total - 8] = (hi >>> 24) & 0xff; m[total - 7] = (hi >>> 16) & 0xff;
  m[total - 6] = (hi >>> 8) & 0xff; m[total - 5] = hi & 0xff;
  m[total - 4] = (lo >>> 24) & 0xff; m[total - 3] = (lo >>> 16) & 0xff;
  m[total - 2] = (lo >>> 8) & 0xff; m[total - 1] = lo & 0xff;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = ((m[p] << 24) | (m[p + 1] << 16) | (m[p + 2] << 8) | m[p + 3]) | 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA_K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push((h[i] >>> 24) & 0xff, (h[i] >>> 16) & 0xff, (h[i] >>> 8) & 0xff, h[i] & 0xff);
  }
  return out;
}
function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return out;
}
function hmacSha256Hex(message, key) {
  const msg = utf8Bytes(message);
  let keyBytes = utf8Bytes(key);
  if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
  const block = new Uint8Array(64);
  block.set(keyBytes);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return toHex(sha256(outer));
}

/* ---------------- 翻页缓存 ---------------- */
function pageState(key) {
  let state = states.get(key);
  if (state && Date.now() - state.updated < TTL) return state;
  state = { pages: new Map(), updated: Date.now() };
  states.delete(key);
  states.set(key, state);
  while (states.size > 32) states.delete(states.keys().next().value);
  return state;
}
function packPage(state, page, list, hasMore, pageCount) {
  const more = hasMore === undefined
    ? (list.length > 0 && page < MAX_PAGE)
    : (Boolean(hasMore) && list.length > 0 && page < MAX_PAGE);
  // pagecount 只回真实总页数（0 = 源端不提供），不再用 page+1 伪造。
  const result = { page: page, pagecount: Number(pageCount) || 0, hasMore: more, list: list };
  state.pages.set(page, result);
  state.updated = Date.now();
  return result;
}

/* ---------------- 牛牛公开接口 ---------------- */
const BASE_HEADERS = {
  "Cache-Control": "no-cache",
  "Content-Type": "application/json;charset=UTF-8",
  "User-Agent": UA
};
async function requestJson(url, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({}, BASE_HEADERS, opts.headers || {});
  opts.timeoutMs = opts.timeoutMs || 15000;
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw failure("牛牛请求失败", "REQUEST_FAILED");
  }
  const raw = await res.text();
  if (!res.ok) throw failure("牛牛接口返回 HTTP " + res.status, "HTTP_" + res.status);
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { throw failure("牛牛接口返回非 JSON", "INVALID_RESPONSE"); }
  if (data && data.code !== undefined && number(data.code) !== 200) {
    throw failure(text(data.msg) || "牛牛接口拒绝请求", "REJECTED");
  }
  return data || {};
}

/* ---------------- CSJ 登录 / 加密请求 ---------------- */
async function ensureVisitorToken(force) {
  if (!force && visitorToken && Date.now() - visitorAt < SESSION_TTL) return visitorToken;
  const res = await fetch(HOST + "/api/v1/app/user/visitorInfo", {
    headers: {
      "deviceid": "aa11fc54-ba9c-3980-add5-447d3fa5b939",
      "token": "",
      "User-Agent": UA,
      "client": "app",
      "devicetype": "Android"
    },
    timeoutMs: 15000
  });
  const raw = await res.text();
  if (!res.ok) throw failure("牛牛访客登录返回 HTTP " + res.status, "HTTP_" + res.status);
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { throw failure("牛牛访客登录返回非 JSON", "INVALID_RESPONSE"); }
  const value = data && data.data && data.data.token;
  if (!value) throw failure("牛牛访客登录失败", "LOGIN_FAILED");
  visitorToken = text(value);
  visitorAt = Date.now();
  return visitorToken;
}

async function ensureAccessToken(force) {
  if (!force && accessToken && Date.now() - accessAt < SESSION_TTL) return accessToken;
  await ensureVisitorToken(false);
  const t = String(Math.floor(Date.now() / 1000));
  const nonce = "VX1KKGtoBDCi1fB1";
  const body = "ac=wifi&os=Android&vod_version=1.10.21.6-tob&os_version=9&type=1&clientVersion=v5.2.5" +
    "&uuid=Y4WNZ3SAWK7MAJMH7CXCDHJ4VMPVFRZQTBSIA4XTYO4AWEUHIK6Q01&resolution=1280*2618" +
    "&openudid=889edced38f1069b&dt=Pixel%204&sha1=46121F77CE2FCAD3DBC3B9EC8A24908C1A8AD6D9" +
    "&os_api=28&install_id=1549688030634536&device_brand=google&sdk_version=1.1.3.0" +
    "&package_name=com.niuniu.ztdh.app&siteid=5627189&dev_log_aid=667431&oaid=&timestamp=" + t;
  const res = await fetch(CSJ_HOST + "/csj_sp/api/v1/user/login?siteid=5627189", {
    method: "POST",
    headers: {
      "X-Salt": "786774955F",
      "X-Nonce": nonce,
      "X-Timestamp": t,
      "X-Signature": hmacSha256Hex(t + nonce + body, CSJ_KEYS.sign),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: aesEncryptBase64(body, CSJ_KEYS.login),
    timeoutMs: 15000
  });
  const raw = await res.text();
  if (!res.ok) throw failure("牛牛 CSJ 登录返回 HTTP " + res.status, "HTTP_" + res.status);
  let data = null;
  try { data = JSON.parse(aesDecryptBase64(raw, CSJ_KEYS.login)); } catch (e) {
    throw failure("牛牛 CSJ 登录响应解密失败", "INVALID_RESPONSE");
  }
  const value = data && data.data && data.data.access_token;
  if (!value) throw failure("牛牛 CSJ 登录失败", "LOGIN_FAILED");
  accessToken = text(value);
  accessAt = Date.now();
  return accessToken;
}

async function csjDetail(thirdPlayId, index, retried) {
  const access = await ensureAccessToken(false);
  const t = String(Math.floor(Date.now() / 1000));
  const nonce = "X9UknYKtLa3DmtjC";
  const body = "not_include=0&lock_free=1&type=1&clientVersion=v5.2.5" +
    "&uuid=6IDYUSASPQY5BBVACWQW3LLTPV4V7DE26UOCX5TZTVUGX4VUJNXQ01&resolution=1080*2320" +
    "&openudid=82f4175d577a2939&dt=22021211RC&os_api=31&install_id=1496879012031075" +
    "&sdk_version=1.1.3.0&siteid=5627189&dev_log_aid=667431&oaid=abec0dfff623201b" +
    "&timestamp=" + t + "&direction=0&ac=mobile&os=Android&vod_version=1.10.21.6-tob" +
    "&os_version=12&count=1&index=" + index + "&shortplay_id=" + thirdPlayId +
    "&sha1=46121F77CE2FCAD3DBC3B9EC8A24908C1A8AD6D9&device_brand=Redmi&package_name=com.niuniu.ztdh.app";
  const res = await fetch(CSJ_HOST + "/csj_sp/api/v1/shortplay/detail?siteid=5627189", {
    method: "POST",
    headers: {
      "X-Salt": "FD8188A8D5",
      "X-Nonce": nonce,
      "X-Timestamp": t,
      "X-Access-Token": access,
      "X-Signature": hmacSha256Hex(t + nonce + body, CSJ_KEYS.sign),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: aesEncryptBase64(body, CSJ_KEYS.detail),
    timeoutMs: 15000
  });
  const raw = await res.text();
  if (!res.ok) throw failure("牛牛 CSJ 接口返回 HTTP " + res.status, "HTTP_" + res.status);
  let data = null;
  try { data = JSON.parse(aesDecryptBase64(raw, CSJ_KEYS.detail)); } catch (e) {
    if (!retried) { await ensureAccessToken(true); return await csjDetail(thirdPlayId, index, true); }
    throw failure("牛牛 CSJ 响应解密失败", "INVALID_RESPONSE");
  }
  if (data && data.ret !== undefined && number(data.ret) !== 0) {
    if (!retried) { await ensureAccessToken(true); return await csjDetail(thirdPlayId, index, true); }
    throw failure(text(data.msg) || "牛牛 CSJ 接口拒绝请求", "REJECTED");
  }
  return data || {};
}

/* ---------------- 封面修复（上游图床已停用，改从 CSJ 取封面） ---------------- */
function cachedCover(id) {
  const entry = coverCache.get(id);
  if (entry && Date.now() - entry.at < COVER_TTL) return entry.url;
  if (entry) coverCache.delete(id);
  return "";
}
function cacheCover(id, url) {
  if (!url) return;
  coverCache.set(id, { url: url, at: Date.now() });
  while (coverCache.size > 600) coverCache.delete(coverCache.keys().next().value);
}
async function fetchCsjCover(thirdPlayId) {
  const data = await csjDetail(thirdPlayId, 1, false);
  const item = data && data.data && data.data.list && data.data.list[0];
  if (!item) return "";
  const v2 = item.cover_image_v2s;
  if (Array.isArray(v2) && v2.length) {
    for (let i = v2.length - 1; i >= 0; i--) {
      const node = v2[i] || {};
      const url = text(node.main_url) || text(node.backup_url);
      if (/^https?:\/\//i.test(url)) return url;
    }
  }
  return text(item.cover_image);
}
async function resolveCover(id) {
  const did = text(id).trim();
  if (!did) return "";
  const hit = cachedCover(did);
  if (hit) return hit;
  let thirdPlayId = "";
  try {
    const r = await requestJson(HOST + "/api/v1/app/play/movieDetails", {
      method: "POST",
      body: JSON.stringify({ id: did, source: 0, typeId: "S1", userId: "223664" })
    });
    thirdPlayId = text(r && r.data && r.data.thirdPlayId);
  } catch (e) {}
  if (!thirdPlayId) return "";
  try {
    const url = await fetchCsjCover(thirdPlayId);
    if (url) { cacheCover(did, url); return url; }
  } catch (e) {}
  return "";
}
function needsCover(item) {
  const cover = text(item && item.vod_pic);
  return !cover || COVER_BAD_HOST.test(cover);
}
async function enrichCovers(list) {
  const targets = list.filter(needsCover);
  if (!targets.length) return list;
  let cursor = 0;
  const limit = Math.min(5, targets.length);
  const worker = async function () {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      try {
        const url = await resolveCover(item.vod_id);
        if (url) item.vod_pic = url;
      } catch (e) {}
    }
  };
  const jobs = [];
  for (let i = 0; i < limit; i++) jobs.push(worker());
  await Promise.all(jobs);
  return list;
}
function extractVideoUrl(videoModel) {
  try {
    const list = videoModel && videoModel.video_list;
    if (!list) return "";
    const candidates = ["video_1", "video_2", "video_3"];
    for (let i = 0; i < candidates.length; i++) {
      const node = list[candidates[i]];
      if (node && node.main_url) {
        const decoded = bytesToUtf8(base64ToBytes(node.main_url));
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
  } catch (e) {}
  return "";
}

/* ---------------- 列表映射 ---------------- */
function toItem(item) {
  const id = text(item.id).trim();
  const remarks = [];
  const total = number(item.totalEpisode);
  if (total > 0) remarks.push(total + "集");
  if (item.type) remarks.push(text(item.type));
  else if (item.year) remarks.push(text(item.year));
  return {
    vod_id: id,
    vod_name: cleanText(item.name) || ("短剧 " + id),
    vod_pic: text(item.cover),
    vod_remarks: remarks.join(" · ")
  };
}
async function mapRecords(rows) {
  const list = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const item = toItem(rows[i]);
    if (item.vod_id) list.push(item);
  }
  return await enrichCovers(list);
}

function init(extend) {
  states.clear();
  visitorToken = "";
  visitorAt = 0;
  accessToken = "";
  accessAt = 0;
}

async function home(filter) {
  let classes = [];
  try {
    const data = await requestJson(HOST + "/api/v1/app/screen/screenType", { method: "POST", body: "{}" });
    const groups = data.data || [];
    for (let i = 0; i < groups.length; i++) {
      const children = (groups[i] && groups[i].children) || [];
      for (let j = 0; j < children.length; j++) {
        const items = (children[j] && children[j].children) || [];
        for (let k = 0; k < items.length; k++) {
          const name = cleanText(items[k].name);
          if (name && !classes.some(function (c) { return c.type_id === name; })) {
            classes.push({ type_id: name, type_name: name });
          }
        }
      }
    }
  } catch (e) {}
  if (classes.length === 0) {
    classes = CATE_FALLBACK.map(function (name) { return { type_id: name, type_name: name }; });
  }
  return { class: classes, filters: {} };
}

async function category(tid, page, filter, extend) {
  const area = text(tid) || "现言";
  const current = Math.max(1, number(page) || 1);
  const state = pageState("niuniu:" + area);
  if (state.pages.has(current)) return state.pages.get(current);
  try {
    const data = await requestJson(HOST + "/api/v1/app/screen/screenMovie", {
      method: "POST",
      body: JSON.stringify({ condition: { classify: area, typeId: "S1" }, pageNum: current, pageSize: PAGE_SIZE })
    });
    const payload = data.data || {};
    const list = await mapRecords(payload.records || []);
    const total = number(payload.total);
    // total 可信时用真实总页数；拿不到就交给 catalog 的「满页 + 新 id」规则，禁止用条数猜。
    const hasMore = total > 0 ? current * PAGE_SIZE < total : undefined;
    return packPage(state, current, list, hasMore, total > 0 ? Math.ceil(total / PAGE_SIZE) : 0);
  } catch (err) {
    if (current > 1) return { page: current, pagecount: current, hasMore: false, list: [] };
    throw err;
  }
}

async function search(keyword, quick, page) {
  const word = cleanText(keyword).slice(0, 60);
  const current = Math.max(1, number(page) || 1);
  if (!word) return { page: 1, pagecount: 1, hasMore: false, list: [] };
  const state = pageState("niuniu:search:" + word);
  if (state.pages.has(current)) return state.pages.get(current);
  try {
    const data = await requestJson(HOST + "/api/v1/app/search/searchMovie", {
      method: "POST",
      body: JSON.stringify({ condition: { value: word, typeId: "S1" }, pageNum: current, pageSize: SEARCH_SIZE })
    });
    const payload = data.data || {};
    const list = await mapRecords(payload.records || []);
    const total = number(payload.total);
    const hasMore = total > 0 ? current * SEARCH_SIZE < total : undefined;
    return packPage(state, current, list, hasMore, total > 0 ? Math.ceil(total / SEARCH_SIZE) : 0);
  } catch (err) {
    if (current > 1) return { page: current, pagecount: current, hasMore: false, list: [] };
    throw err;
  }
}

async function detail(id) {
  const did = text(id).replace(/^niuniu:/, "").trim();
  if (!did) throw failure("无效的短剧 ID", "INVALID_ID");
  let desc = {};
  let info = {};
  try {
    const r = await requestJson(HOST + "/api/v1/app/play/movieDesc", {
      method: "POST",
      body: JSON.stringify({ id: did, typeId: "S1" })
    });
    desc = r.data || {};
  } catch (e) {}
  try {
    const r = await requestJson(HOST + "/api/v1/app/play/movieDetails", {
      method: "POST",
      body: JSON.stringify({ id: did, source: 0, typeId: "S1", userId: "223664" })
    });
    info = r.data || {};
  } catch (e) {}

  const episodes = [];
  const oldList = info.episodeList || [];
  for (let i = 0; i < oldList.length; i++) {
    const ep = oldList[i];
    const playUrl = text(ep.url || ep.playUrl);
    if (/^https?:\/\//i.test(playUrl)) {
      episodes.push("第" + (number(ep.episode) || i + 1) + "集$" + playUrl);
    } else if (ep.id) {
      episodes.push("第" + (number(ep.episode) || i + 1) + "集$" + did + "+" + ep.id);
    }
  }

  if (episodes.length === 0 && info.thirdPlayId) {
    try {
      const data = await csjDetail(info.thirdPlayId, 1, false);
      const rights = data && data.data && data.data.episode_right_list;
      if (rights && rights.length > 0) {
        for (let i = 0; i < rights.length; i++) {
          const it = rights[i];
          const index = number(it.index) || (i + 1);
          const lock = text(it.lock_type) || "free";
          episodes.push("第" + index + "集$" + index + "+" + lock + "+" + info.thirdPlayId);
        }
      }
    } catch (e) {}
  }

  let cover = text(desc.cover) || text(info.cover);
  if (!cover || COVER_BAD_HOST.test(cover)) {
    const thirdPlayId = text(info.thirdPlayId);
    if (thirdPlayId) {
      try { const fixed = await fetchCsjCover(thirdPlayId); if (fixed) { cover = fixed; cacheCover(did, fixed); } } catch (e) {}
    }
    if (!cover || COVER_BAD_HOST.test(cover)) {
      const fixed = await resolveCover(did);
      if (fixed) cover = fixed;
    }
  }

  const total = number(desc.totalEpisode) || number(info.totalEpisode) || episodes.length;
  const remarks = [];
  if (total > 0) remarks.push("共" + total + "集");
  if (desc.classify) remarks.push(cleanText(desc.classify));
  if (desc.score) remarks.push("评分" + text(desc.score));

  return {
    list: [{
      vod_id: did,
      vod_name: cleanText(desc.name) || cleanText(info.name) || ("短剧 " + did),
      vod_pic: cover,
      vod_content: cleanText(desc.introduce) || cleanText(info.introduce),
      vod_remarks: remarks.join(" · "),
      vod_play_from: "牛牛短剧",
      vod_play_url: episodes.length > 0 ? episodes.join("#") : "暂无播放地址$0"
    }]
  };
}

async function play(flag, id, flags) {
  const raw = text(id).trim();
  if (/^https?:\/\//i.test(raw)) {
    return { parse: 0, url: raw, header: { "User-Agent": UA } };
  }
  const parts = raw.split("+");
  try {
    if (parts.length === 2) {
      // detail 里拼的是 did + "+" + ep.id，所以第一个是剧 id、第二个是集 id。
      const did = parts[0];
      const ep = (parts[1].match(/\d+/) || [""])[0];
      const data = await requestJson(HOST + "/api/v1/app/play/movieDetails", {
        method: "POST",
        body: JSON.stringify({ episodeId: ep, id: did, source: 0, typeId: "S1", userId: "223664" })
      });
      const url = text(data && data.data && data.data.url);
      if (/^https?:\/\//i.test(url)) return { parse: 0, url: url, header: { "User-Agent": UA } };
    } else if (parts.length === 3) {
      const index = (parts[0].match(/\d+/) || ["1"])[0];
      const lock = parts[1];
      const thirdPlayId = parts[2];
      if (lock === "free" || !lock) {
        const data = await csjDetail(thirdPlayId, index, false);
        const list = data && data.data && data.data.list;
        const url = extractVideoUrl(list && list[0] && list[0].video_model);
        if (/^https?:\/\//i.test(url)) return { parse: 0, url: url, header: { "User-Agent": UA } };
      }
    }
  } catch (e) {
    // 上游网络/限流故障不能当成「没有这一集」：打上 UPSTREAM_FAILED 让 catalog 回 502。
    const message = text(e && e.message) || String(e || "");
    if (/ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|TLS|HTTP\s*\d{3}|timeout|超时|限流|风控/i.test(message)) {
      return { parse: 0, url: "", header: {}, error: "UPSTREAM_FAILED: " + message.slice(0, 200) };
    }
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

globalThis.spider = spider;
