// 上游熔断器（B2）：连续被上游拒绝时短时不再打上游。
//
// 设计约束（都是踩过的坑）：
// - 只用时间戳，不挂定时器：容器里长驻 timer 泄漏比「不熔断」更难查。
// - 冷却期请求直接失败，不排队：排队会把 12s 的上游超时叠成几十秒的请求堆积。
// - 半开只放行一个探测，其余继续挡：冷却一到期所有请求一起冲上去等于没熔断。
// - 探测没回报（调用方抛了别的错/进程被中断）有 TTL 兜底，避免卡死在半开。
// - 日志节流：开闸打一条，之后每 warnIntervalMs 最多一条汇总，其余只计数。
//
// 阈值与时长可注入，默认值即线上取值；注入主要为了单测能用毫秒级冷却。

const DEFAULTS = {
  failThreshold: 3,
  baseCooldownMs: 30 * 1000,
  maxCooldownMs: 5 * 60 * 1000,
  warnIntervalMs: 60 * 1000,
  probeTtlMs: 15 * 1000,
};

export function createBreaker(name, options = {}) {
  const config = { ...DEFAULTS, ...options };
  return {
    name,
    config,
    logger: options.logger || ((line) => console.log(line)),
    fails: 0, // 连续拒绝次数（成功即归零）
    openUntil: 0, // 冷却截止时间戳；0 = 未熔断
    cooldown: 0, // 当前冷却时长（半开探测再失败时翻倍）
    probingAt: 0, // 半开期已放行的探测时间戳；0 = 没有在飞探测
    suppressed: 0, // 被挡下/被节流的次数，只计数不打印
    lastError: "",
    lastWarnAt: 0,
  };
}

export function breakerState(breaker) {
  if (!breaker.openUntil) return "closed";
  return Date.now() < breaker.openUntil ? "open" : "half-open";
}

// 还要等几秒；0 = 现在可以打上游（closed 或已到半开）。
export function breakerSeconds(breaker) {
  const now = Date.now();
  if (!breaker.openUntil || now >= breaker.openUntil) return 0;
  return Math.max(1, Math.ceil((breaker.openUntil - now) / 1000));
}

// 申请一次上游调用：返回 0 = 放行，>0 = 还要等几秒（调用方直接拒绝，不排队）。
export function acquire(breaker) {
  const now = Date.now();
  const wait = breakerSeconds(breaker);
  if (wait) {
    breaker.suppressed += 1;
    return wait;
  }
  if (breaker.openUntil) {
    if (breaker.probingAt && now - breaker.probingAt < breaker.config.probeTtlMs) {
      breaker.suppressed += 1;
      return 1;
    }
    breaker.probingAt = now;
  }
  return 0;
}

export function reportOk(breaker) {
  breaker.fails = 0;
  breaker.openUntil = 0;
  breaker.cooldown = 0;
  breaker.probingAt = 0;
  breaker.lastError = "";
}

// 探测没拿到结论（网络瞬态/超时）：清掉探测占位，不计数、不延长冷却。
export function releaseProbe(breaker) {
  breaker.probingAt = 0;
}

// 上游明确拒绝（空正文/签名失效/风控/403/429）时调用。
// 返回 true 表示这次调用让熔断「开闸」或「延长冷却」，调用方可据此把倒计时写进文案。
export function reportReject(breaker, message) {
  const now = Date.now();
  const wasProbing = breaker.probingAt !== 0;
  breaker.probingAt = 0;
  breaker.fails += 1;
  breaker.lastError = String(message || "").slice(0, 300);
  if (breaker.fails < breaker.config.failThreshold) return false;
  if (!breaker.openUntil) {
    breaker.cooldown = breaker.config.baseCooldownMs;
  } else if (wasProbing) {
    // 半开探测再失败：翻倍，封顶。
    breaker.cooldown = Math.min(breaker.cooldown * 2, breaker.config.maxCooldownMs);
  } else {
    // 已在冷却中，且不是探测失败（并发在途请求的迟到失败）：不延长冷却。
    return true;
  }
  breaker.openUntil = now + breaker.cooldown;
  warn(breaker);
  return true;
}

// 日志节流：开闸时打一条，之后每个 warnIntervalMs 最多一条汇总。
function warn(breaker) {
  const now = Date.now();
  if (now - breaker.lastWarnAt < breaker.config.warnIntervalMs) {
    breaker.suppressed += 1;
    return;
  }
  const suppressed = breaker.suppressed;
  breaker.suppressed = 0;
  breaker.lastWarnAt = now;
  breaker.logger(
    JSON.stringify({
      event: "upstream_breaker",
      breaker: breaker.name,
      state: "open",
      fails: breaker.fails,
      cooldownMs: breaker.cooldown,
      openUntil: breaker.openUntil,
      suppressed,
      error: breaker.lastError,
    })
  );
}

export function breakerSummary(breaker) {
  return {
    state: breakerState(breaker),
    fails: breaker.fails,
    cooldownMs: breaker.cooldown,
    openUntil: breaker.openUntil,
    retryAfter: breakerSeconds(breaker),
    suppressed: breaker.suppressed,
    lastError: breaker.lastError,
  };
}
