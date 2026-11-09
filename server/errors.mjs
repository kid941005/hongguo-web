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
  // 服务端 / 上游
  BUSY: 503,
  DOWNLOAD: 502,
  ENCRYPTED: 502,
  EMPTY: 502,
  NO_URL: 502,
  SOURCE_LOAD: 502,
  TIMEOUT: 504,
  UPSTREAM: 502,
  UPSTREAM_ERROR: 502,
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

// 未分类错误（无 code）对外只给通用文案，避免把上游细节/内网地址抛给浏览器。
export function publicMessage(error) {
  const code = error && error.code;
  if (!code) return GENERIC_MESSAGE;
  return String((error && error.message) || GENERIC_MESSAGE);
}
