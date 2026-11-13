#!/usr/bin/env node
// 离线自测（B1）：node server/selftest.mjs
//
// 目的：给「改一行就可能让所有播放失效」的纯逻辑上锁——
// 内容密钥派生、分块解密、播放签名、播放地址拆分/分类、MP4 首块校验、
// 熔断状态机、错误码映射。全部离线，不联网、不读 data/、不依赖容器。
//
// 约定：黄金向量是「钉住当前已验证行为」，不是重新推导算法。
// 若上游 vendor 换了算法，这里失败是预期结果——先人工确认新算法正确，再更新向量。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { vendor } from "./provider.mjs";
import { splitPlayUrl, classifyUrl } from "./catalog.mjs";
import { probeMp4Head } from "./mp4.mjs";
import {
  acquire,
  breakerSeconds,
  breakerState,
  breakerSummary,
  createBreaker,
  releaseProbe,
  reportOk,
  reportReject,
} from "./breaker.mjs";
import { fail, headersOf, publicMessage, statusOf } from "./errors.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let passed = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) {
    passed += 1;
    return;
  }
  failures.push(name + (detail ? " | " + detail : ""));
}

function eq(actual, expected, name) {
  ok(
    Object.is(actual, expected),
    name,
    "expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual)
  );
}

function throwsWith(fn, pattern, name) {
  try {
    fn();
    ok(false, name, "没有抛错");
  } catch (error) {
    ok(pattern.test(String(error && error.message)), name, "message=" + (error && error.message));
  }
}

function section(title) {
  console.log("\n## " + title);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- vendor 本体

section("vendor 文件与导出白名单");

const VENDOR_BYTES = 90363;
const VENDOR_SHA12 = "1f81793cf9b3";
const raw = fs.readFileSync(path.join(HERE, "vendor", "hongguo.cjs"));
eq(raw.length, VENDOR_BYTES, "vendor 文件字节数未变");
eq(crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12), VENDOR_SHA12, "vendor 文件 sha256 前缀未变");

const EXPECTED_EXPORTS = [
  "categoryPage",
  "categoryData",
  "itemToCard",
  "appSearchPage",
  "APP_DEVICE",
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
eq(Object.keys(vendor).length, EXPECTED_EXPORTS.length, "导出数量等于白名单长度");
eq(Object.keys(vendor).sort().join(","), EXPECTED_EXPORTS.slice().sort().join(","), "导出名与白名单一致");
eq(typeof vendor.deriveContentKey, "function", "deriveContentKey 是函数");
eq(typeof vendor.decryptPartial, "function", "decryptPartial 是函数");
eq(typeof vendor.remoteRange, "function", "remoteRange 是函数");
eq(typeof vendor.prepareHeader, "function", "prepareHeader 是函数");
eq(typeof vendor.registerPlaybackDevice, "function", "registerPlaybackDevice 是函数");
ok(Array.isArray(vendor.CATEGORIES) && vendor.CATEGORIES.length > 0, "CATEGORIES 是非空数组");

// ------------------------------------------------------------ 内容密钥派生

section("deriveContentKey（内容密钥派生）");

const SPADE = "oLMT9VuyEvtZshL5X7UR+0G2DvlfqSbQXakm0luuJdClrOLrqqzi5Kuj4+uqo+Pqqa3h5ait4eSrrOLlqKzi5g==";
const KEY_HEX = "00112233445566778899aabbccddeeff";

const derived = vendor.deriveContentKey(SPADE);
eq(Buffer.isBuffer(derived), true, "派生结果是 Buffer");
eq(derived.length, 16, "派生密钥长度 16 字节（AES-128）");
eq(derived.toString("hex"), KEY_HEX, "黄金向量：派生密钥与固定值一致");

const urlsafe = SPADE.replace(/\+/g, "-").replace(/\//g, "_");
eq(vendor.deriveContentKey(urlsafe).toString("hex"), KEY_HEX, "URL-safe base64 变体得到同一密钥");

throwsWith(
  () => vendor.deriveContentKey(Buffer.alloc(2, 0).toString("base64")),
  /spade_a too short/,
  "过短输入被拒绝"
);
throwsWith(
  () => vendor.deriveContentKey(Buffer.alloc(10, 0).toString("base64")),
  /spade_a key length invalid/,
  "有效长度不足 33 的输入被拒绝"
);

// -------------------------------------------------------------- 分块解密

section("decryptPartial（分块解密）");

const KEY = Buffer.from(KEY_HEX, "hex");
const HEADER = Buffer.alloc(32, 0x11);
const PLAIN = Buffer.from("0123456789abcdef", "hex");
const IV = Buffer.alloc(16, 0);
const CIPHER = (() => {
  const cipher = crypto.createCipheriv("aes-128-ctr", KEY, IV);
  return Buffer.concat([cipher.update(PLAIN), cipher.final()]);
})();
const PREPARED = { header: HEADER, samples: [{ start: 32, end: 48, iv: IV }] };
const BODY = Buffer.concat([Buffer.alloc(32, 0xee), CIPHER]);

const whole = vendor.decryptPartial(BODY, 0, KEY, PREPARED);
ok(whole.subarray(0, 32).equals(HEADER), "首块头部被还原（moov 等明文头覆盖密文段）");
ok(whole.subarray(32, 48).equals(PLAIN), "样本区间解密为明文");

const wrongKey = vendor.decryptPartial(BODY, 0, Buffer.alloc(16, 0x5a), PREPARED);
ok(!wrongKey.subarray(32, 48).equals(PLAIN), "错误密钥解不出明文（必须拒绝）");

const tail = vendor.decryptPartial(BODY.subarray(36), 36, KEY, PREPARED);
eq(tail.length, 4, "偏移窗口只返回请求长度");
ok(tail.equals(PLAIN.subarray(4)), "偏移窗口从正确位置续解");

const noKey = vendor.decryptPartial(BODY, 0, null, PREPARED);
ok(noKey.subarray(0, 32).equals(HEADER), "无密钥时仍还原明文头");
ok(noKey.subarray(32, 48).equals(CIPHER), "无密钥时密文段原样返回");

// -------------------------------------------------------------- 播放签名

section("Argus 播放签名与 queryParam");

const { Argus, queryParam } = require("./sign/argus.cjs");

const SIGN_QUERY = "aid=1967&device_id=7000000000000000000&iid=8000000000000000000&version_name=7.3.9";
const SIGN_GOLDEN =
  "8oEOJVdob+G/gGROki4+AIxcKSzoGhoNl5ZSQYs+qF4aneabnF0kJmoCu714X+AKR/nZ/aX7xIi4PwdYMVUYklS+s8ZNELplQ1MXAmeT035yE5wIPbLQgdaNM0kgvTkIwa3hDYzFboMDci61PNNg1pQ+Yg9/w5liX5zHAGcx0pHHJ4TYu5v9C9zdYSE9Lnz7u9Qsr/3D12sThb43T3HU4UdPixMxGvy++TfgaPigjd5yBl5j1J0/0guDwEPYyfDJlkkMFrQvEZ9uhloF/NUC5xUUYqtGnqFx8lXpBUix323M8Q==";

const signOnce = Argus.sign(SIGN_QUERY, "deadbeef", 1762600000, 1967, 1611921764, "7000000000000000000", "8000000000000000000", 123456789);
const signTwice = Argus.sign(SIGN_QUERY, "deadbeef", 1762600000, 1967, 1611921764, "7000000000000000000", "8000000000000000000", 123456789);
eq(signOnce, SIGN_GOLDEN, "黄金向量：固定入参的签名与固定值一致");
eq(signTwice, signOnce, "同入参两次签名一致（无隐藏随机源）");
eq(signOnce.length, 304, "签名长度 304");
eq(signOnce.slice(0, 3), "8oE", "签名前缀为 0xf2 0x81 的 base64 头");

eq(queryParam(SIGN_QUERY, "aid"), "1967", "queryParam 取出已有参数");
eq(queryParam(SIGN_QUERY, "device_id"), "7000000000000000000", "queryParam 取出长数字参数");
eq(queryParam(SIGN_QUERY, "missing"), null, "queryParam 缺失参数返回 null");

// ------------------------------------------------------- 播放地址拆分/分类

section("splitPlayUrl（线路 / 分集拆分）");

const twoLines = splitPlayUrl("第1集$e1#第2集$e2$$$第1集$x1", "hg$$$alt");
eq(twoLines.length, 2, "两条线路都被保留");
eq(twoLines[0].flag, "hg", "线路 1 flag 取 vod_play_from 第 1 段");
eq(twoLines[0].name, "hg", "线路 1 名称取 vod_play_from 第 1 段");
eq(twoLines[0].episodes.length, 2, "线路 1 有两集");
eq(twoLines[0].episodes[1].id, "e2", "分集 ID 取 $ 之后");
eq(twoLines[0].episodes[1].name, "第2集", "分集名取 $ 之前");
eq(twoLines[1].flag, "alt", "线路 2 flag 取第 2 段");
eq(twoLines[1].episodes[0].id, "x1", "线路 2 分集 ID 正确");

const plainUrl = splitPlayUrl("e1#e2", "");
eq(plainUrl.length, 1, "无 $$$ 时只有一条线路");
eq(plainUrl[0].flag, "flag", "缺 vod_play_from 时 flag 回落 flag");
eq(plainUrl[0].name, "线路 1", "缺 vod_play_from 时线路名回落 线路 1");
eq(plainUrl[0].episodes[0].name, "第 1 集", "无集名时按序号补 第 1 集");
eq(plainUrl[0].episodes[1].name, "第 2 集", "无集名时按序号补 第 2 集");

eq(splitPlayUrl("", "hg").length, 0, "空 vod_play_url 返回空数组");
eq(splitPlayUrl(null, null).length, 0, "null 输入返回空数组");

const dropEmptyId = splitPlayUrl("第1集$#第2集$e2", "hg");
eq(dropEmptyId[0].episodes.length, 1, "集 ID 为空的分集被丢弃");
eq(dropEmptyId[0].episodes[0].id, "e2", "保留下来的分集 ID 正确");

eq(splitPlayUrl("a$1$$$", "").length, 1, "没有任何分集的空线路被丢弃");

section("classifyUrl（播放地址分类）");

eq(classifyUrl("https://a.com/x/index.m3u8"), "hls", ".m3u8 后缀判为 hls");
eq(classifyUrl("https://a.com/x/index.m3u8?token=1"), "hls", "带查询串的 .m3u8 判为 hls");
eq(classifyUrl("https://a.com/m3u8/playlist"), "hls", "路径含 /m3u8 判为 hls（无后缀地址）");
eq(classifyUrl("https://a.com/play?format=m3u8"), "hls", "format=m3u8 判为 hls");
eq(classifyUrl("https://a.com/v/1.mp4"), "mp4", ".mp4 判为 mp4");
eq(classifyUrl("https://a.com/v/1.m4v?x=1"), "mp4", ".m4v 判为 mp4");
eq(classifyUrl("https://a.com/v/1.mov"), "mp4", ".mov 判为 mp4");
eq(classifyUrl("https://a.com/v/1.flv"), "flv", ".flv 判为 flv");
eq(classifyUrl("https://a.com/v/stream"), "mp4", "无后缀默认 mp4");
eq(classifyUrl(""), "mp4", "空地址默认 mp4");

// ---------------------------------------------------------- MP4 首块校验

section("probeMp4Head（首块结构校验）");

function makeBox(type, size) {
  const buf = Buffer.alloc(Math.max(size, 8));
  buf.writeUInt32BE(size, 0);
  buf.write(type, 4, "ascii");
  return buf;
}

const ftyp = probeMp4Head(makeBox("ftyp", 24));
eq(ftyp.ok, true, "合法 ftyp box 通过");
eq(ftyp.box, "ftyp", "解析出 box 类型 ftyp");
eq(ftyp.size, 24, "解析出 box 长度 24");

eq(probeMp4Head(makeBox("mdat", 1024)).ok, true, "合法 mdat box 通过");
eq(probeMp4Head(makeBox("free", 0)).ok, true, "size=0（延伸到文件尾）通过");

const html = probeMp4Head(Buffer.from("HTTP/1.1 403 Forbidden"));
eq(html.ok, false, "403 HTML 首块被判失败");
eq(html.reason, "unknown_box", "HTML 首块 reason=unknown_box");

const garbage = probeMp4Head(Buffer.from([0, 0, 0, 8, 0xff, 0xfe, 0x00, 0x01]));
eq(garbage.ok, false, "非可打印 box 类型被判失败");
eq(garbage.reason, "not_box", "乱码首块 reason=not_box");

const short = probeMp4Head(Buffer.from([0, 0, 0, 8, 0x66]));
eq(short.ok, false, "不足 8 字节判失败");
eq(short.reason, "too_short", "不足 8 字节 reason=too_short");

const tiny = probeMp4Head(makeBox("ftyp", 4));
eq(tiny.ok, false, "size<8 的 box 判失败");

const large = Buffer.alloc(32);
large.writeUInt32BE(1, 0);
large.write("mdat", 4, "ascii");
large.writeUInt32BE(0, 8);
large.writeUInt32BE(4096, 12);
const big = probeMp4Head(large);
eq(big.ok, true, "64 位长度（size=1）的大 box 通过");
eq(big.size, 4096, "64 位长度解析正确");

// -------------------------------------------------------------- 熔断状态机

section("breaker（熔断状态机）");

function makeBreaker(options) {
  const logs = [];
  const breaker = createBreaker("selftest", {
    failThreshold: 3,
    baseCooldownMs: 120,
    maxCooldownMs: 400,
    warnIntervalMs: 0,
    probeTtlMs: 60,
    logger: (line) => logs.push(line),
    ...(options || {}),
  });
  return { breaker, logs };
}

const first = makeBreaker();
eq(breakerState(first.breaker), "closed", "初始状态 closed");
eq(acquire(first.breaker), 0, "closed 时放行");
eq(breakerSeconds(first.breaker), 0, "closed 时无需等待");

eq(reportReject(first.breaker, "e1"), false, "第 1 次拒绝未开闸");
eq(reportReject(first.breaker, "e2"), false, "第 2 次拒绝未开闸");
eq(breakerState(first.breaker), "closed", "未达阈值仍 closed");
eq(reportReject(first.breaker, "e3"), true, "第 3 次拒绝开闸");
eq(breakerState(first.breaker), "open", "开闸后状态 open");
eq(first.breaker.cooldown, 120, "首次冷却等于 baseCooldownMs");
eq(first.logs.length, 1, "开闸只打一条日志");
const warnLine = JSON.parse(first.logs[0]);
eq(warnLine.event, "upstream_breaker", "日志 event 正确");
eq(warnLine.breaker, "selftest", "日志带 breaker 名");
eq(warnLine.state, "open", "日志 state=open");
eq(warnLine.fails, 3, "日志带连续失败次数");

const waitSec = acquire(first.breaker);
ok(waitSec > 0, "冷却期请求被挡下并给出等待秒数");
eq(first.breaker.suppressed, 1, "被挡下的请求计入 suppressed");
ok(breakerSummary(first.breaker).retryAfter >= 1, "summary.retryAfter 给出剩余秒数");

const openUntilBefore = first.breaker.openUntil;
eq(reportReject(first.breaker, "late"), true, "冷却期迟到失败返回 true");
eq(first.breaker.cooldown, 120, "迟到失败不翻倍");
eq(first.breaker.openUntil, openUntilBefore, "迟到失败不延长冷却");

await sleep(140);
eq(breakerState(first.breaker), "half-open", "冷却到期进入 half-open");
eq(acquire(first.breaker), 0, "half-open 放行一个探测");
eq(acquire(first.breaker), 1, "half-open 期间其余请求继续被挡");
eq(reportReject(first.breaker, "probe failed"), true, "探测再失败重新开闸");
eq(first.breaker.cooldown, 240, "探测失败冷却翻倍");

await sleep(260);
eq(acquire(first.breaker), 0, "翻倍冷却到期后再次放行探测");
reportOk(first.breaker);
eq(breakerState(first.breaker), "closed", "探测成功回到 closed");
eq(first.breaker.fails, 0, "成功后失败计数归零");
eq(first.breaker.cooldown, 0, "成功后冷却时长归零");
eq(breakerSeconds(first.breaker), 0, "成功后无需等待");

const capped = makeBreaker({ baseCooldownMs: 120, maxCooldownMs: 200 });
reportReject(capped.breaker, "a");
reportReject(capped.breaker, "b");
reportReject(capped.breaker, "c");
eq(capped.breaker.cooldown, 120, "封顶用例首次冷却 120");
await sleep(140);
acquire(capped.breaker);
reportReject(capped.breaker, "probe");
eq(capped.breaker.cooldown, 200, "翻倍受 maxCooldownMs 封顶");

const ttl = makeBreaker({ probeTtlMs: 40 });
reportReject(ttl.breaker, "a");
reportReject(ttl.breaker, "b");
reportReject(ttl.breaker, "c");
await sleep(140);
eq(acquire(ttl.breaker), 0, "probeTtl 用例放行探测");
eq(acquire(ttl.breaker), 1, "探测在飞时其余被挡");
await sleep(60);
eq(acquire(ttl.breaker), 0, "probeTtl 过期后允许新探测（不会卡死在半开）");

const released = makeBreaker();
reportReject(released.breaker, "a");
reportReject(released.breaker, "b");
reportReject(released.breaker, "c");
await sleep(140);
eq(acquire(released.breaker), 0, "releaseProbe 用例放行探测");
eq(acquire(released.breaker), 1, "探测占位生效");
releaseProbe(released.breaker);
eq(acquire(released.breaker), 0, "releaseProbe 后立即可再探测");

const quiet = makeBreaker({ warnIntervalMs: 60000 });
reportReject(quiet.breaker, "a");
reportReject(quiet.breaker, "b");
reportReject(quiet.breaker, "c");
eq(quiet.logs.length, 1, "节流窗口内只打一条日志");
reportReject(quiet.breaker, "d");
eq(quiet.logs.length, 1, "节流窗口内后续失败不再打印");

// -------------------------------------------------------------- 错误码映射

section("errors（错误码 → 状态码 / 重试头 / 对外文案）");

eq(statusOf("CODEC_UNSUPPORTED"), 415, "CODEC_UNSUPPORTED 映射 415");
eq(statusOf("UPSTREAM_COOLDOWN"), 503, "UPSTREAM_COOLDOWN 映射 503");
eq(statusOf("UPSTREAM_EMPTY"), 503, "UPSTREAM_EMPTY 映射 503");
eq(statusOf("NOT_FOUND"), 404, "NOT_FOUND 映射 404");
eq(statusOf("RATE_LIMITED"), 429, "RATE_LIMITED 映射 429");
eq(statusOf("TIMEOUT"), 504, "TIMEOUT 映射 504");
eq(statusOf("UPSTREAM_ERROR"), 502, "UPSTREAM_ERROR 映射 502");
eq(statusOf("SOMETHING_NEW"), 502, "未知业务码回落 502");

eq(headersOf("UPSTREAM_COOLDOWN", { retryAfter: 30.4 })["retry-after"], "31", "冷却期回 Retry-After 并向上取整");
eq(headersOf("RATE_LIMITED", { retryAfter: 60 })["retry-after"], "60", "限流回 Retry-After");
eq(Object.keys(headersOf("UPSTREAM_COOLDOWN", {})).length, 0, "无秒数时不编造 Retry-After");
eq(Object.keys(headersOf("BAD_INPUT", { retryAfter: 5 })).length, 0, "非重试类错误不带 Retry-After");
eq(Object.keys(headersOf("BUSY", { retryAfter: 0 })).length, 0, "秒数非正数时不带 Retry-After");

const coded = fail("NOT_FOUND", "剧集不存在");
eq(coded.code, "NOT_FOUND", "fail 写入业务码");
eq(coded.message, "剧集不存在", "fail 保留消息");
eq(publicMessage(coded), "剧集不存在", "有业务码时对外透出自身文案");
eq(publicMessage(fail("UPSTREAM", "")), "内容源暂不可用，请稍后重试", "空消息回落通用文案");
eq(publicMessage(new Error("内部细节")), "内容源暂不可用，请稍后重试", "无业务码时只给通用文案");

// ------------------------------------------------------------------- 汇总

console.log("");
if (failures.length) {
  console.log("FAIL selftest: " + passed + " passed, " + failures.length + " failed");
  for (const item of failures) console.log("  - " + item);
  process.exit(1);
}
console.log("PASS selftest: " + passed + " assertions");
