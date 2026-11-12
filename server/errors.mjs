// 统一错误模型：业务码 → HTTP 状态码 + 对外消息。
// 约定：错误对象始终带 code（业务码），http 层只做「码 → 状态」映射，不猜语义。
const STATUS = {
  // 客户端错误
  BAD_INPUT: 400,
  BAD_JSON: 400,
  BAD_URL: 400,
  BAD_METHOD: 405,
  INVALID_SOURCE: 400,
  NEED_PARSE: 400,
  NOT_JS: 400,
  TOO_BIG: 400,
  // 权限
  PROTECTED: 403,
  UNAUTHORIZED: 401,
  USER_EXISTS: 409,
  RATE_LIMITED: 429,
  // 资源
  NOT_FOUND: 404,
  // 415：请求本身合法，但要求的编码/格式客户端解不了（如 H.266/VVC 档位）
  CODEC_UNSUPPORTED: 415,
  // 服务端 / 上游
  BUSY: 503,
  DOWNLOAD: 502,
  ENCRYPTED: 502,
  EMPTY: 502,
  NO_URL: 502,
  SOURCE_LOAD: 502,
  SOURCE_CRASH: 502,
  // 转码这类「整集读进内存」的路径遇到超大文件时的明确业务码，避免抛裸 Error 变成 502 无码。
  SOURCE_OOM: 502,
  TIMEOUT: 504,
  UPSTREAM: 502,
  UPSTREAM_ERROR: 502,
  UPSTREAM_EMPTY: 503,
  // 熔断冷却期：不是「上游坏了」，而是「我们主动不打上游」，语义上是「稍后重试」。
  UPSTREAM_COOLDOWN: 503,
};

const GENERIC_MESSAGE = "内容源暂不可用，请稍后重试";

export function fail(code, message) {
  const error = new Error(message || GENERIC_MESSAGE);
  error.code = code;
  return error;
}

export function statusOf(code) {
  return STATUS[code] || 502;
}

// 「过一会儿再来」类错误附带 Retry-After，客户端不必猜等多久。
const RETRY_AFTER_CODES = new Set(["UPSTREAM_COOLDOWN", "RATE_LIMITED", "BUSY"]);

export function headersOf(code, error) {
  const headers = {};
  // 405 必须带 Allow（RFC 9110 §15.5.6），否则客户端/网关无法判断该路径支持什么方法。
  if (code === "BAD_METHOD" && error && error.allow) headers.allow = String(error.allow);
  if (!RETRY_AFTER_CODES.has(code)) return headers;
  const seconds = Number(error && error.retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) headers["retry-after"] = String(Math.ceil(seconds));
  return headers;
}

// 只有「本服务自己定义、文案本来就是写给用户看」的业务码才放行 message。
// 其余一律回通用文案：axios 的 ERR_BAD_RESPONSE、Node 的 ENOTFOUND/ECONNREFUSED/EAI_AGAIN、
// sqlite 的 ERR_SQLITE_* 都会带 code，但它们同时把上游主机名、内网地址、SQL 片段写进 message，
// 直接透给浏览器就是信息泄漏（见 review S3 / D1 的 502 英文报错）。
const PUBLIC_CODES = new Set(Object.keys(STATUS));

export function publicMessage(error) {
  const code = error && error.code;
  if (!code || !PUBLIC_CODES.has(code)) return GENERIC_MESSAGE;
  const message = String((error && error.message) || "").trim();
  return message ? message.slice(0, 300) : GENERIC_MESSAGE;
}
