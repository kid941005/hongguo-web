import { fail } from "./errors.mjs";

// 播放通道监控：定时用「真实取流 + 首块 ftyp 校验」做深探针，状态翻转时告警。
// 与 provider 的熔断器互补：熔断器按请求失败自愈（只在有人看的时候生效），
// 监控负责「没人访问时也能发现通道失效」，并区分「主通道挂了但回落通道还在」（degraded）。

const ALERT_KEEP = 50;
const WEBHOOK_TIMEOUT = 8000;
const PROBE_TTL = 30 * 60 * 1000;

export function createMonitor({
  provider,
  catalog,
  intervalMs = 10 * 60 * 1000,
  threshold = 3,
  webhookUrl = "",
  version = "",
  log = console,
  fetchImpl = globalThis.fetch,
} = {}) {
  const state = {
    status: "unknown", // unknown | ok | degraded | down
    channel: "", // official（高清多档） | web（官网明文 360P） | app（App 明文通道）
    reason: "",
    fails: 0,
    checks: 0,
    okChecks: 0,
    lastCheckAt: 0,
    lastOkAt: 0,
    lastError: "",
    lastMs: 0,
    probe: null,
    alerts: [],
    webhook: { configured: Boolean(webhookUrl), lastOkAt: 0, lastError: "" },
  };
  let intervalTimer = null;
  let initialTimer = null;
  let running = null;

  function snapshot() {
    return {
      enabled: true,
      status: state.status,
      channel: state.channel,
      reason: state.reason,
      fails: state.fails,
      threshold,
      checks: state.checks,
      okChecks: state.okChecks,
      intervalMs,
      lastCheckAt: state.lastCheckAt,
      lastOkAt: state.lastOkAt,
      lastError: state.lastError,
      lastMs: state.lastMs,
      probe: state.probe ? { vid: state.probe.vid, title: state.probe.title, at: state.probe.at } : null,
      webhook: { ...state.webhook },
      alerts: state.alerts.slice(0, 10),
    };
  }

  async function notify(alert) {
    if (!webhookUrl || typeof fetchImpl !== "function") return;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT) : null;
    if (timer && timer.unref) timer.unref();
    const payload = {
      event: "playback_alert",
      level: alert.level,
      status: alert.status,
      channel: alert.channel,
      message: alert.message,
      at: new Date(alert.at).toISOString(),
      version,
      text: "[hongguo-web " + (version || "?") + "] " + alert.message,
    };
    try {
      const res = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined,
      });
      if (!res || !res.ok) throw new Error("webhook HTTP " + (res && res.status));
      state.webhook.lastOkAt = Date.now();
      state.webhook.lastError = "";
    } catch (error) {
      state.webhook.lastError = String((error && error.message) || error).slice(0, 200);
      log.error(JSON.stringify({ event: "alert_webhook_failed", message: state.webhook.lastError }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function pushAlert(level, message) {
    const alert = { at: Date.now(), level, status: state.status, channel: state.channel, message };
    state.alerts.unshift(alert);
    if (state.alerts.length > ALERT_KEEP) state.alerts.length = ALERT_KEEP;
    log.error(JSON.stringify({ event: "playback_alert", level, status: alert.status, channel: alert.channel, message }));
    Promise.resolve()
      .then(() => notify(alert))
      .catch(() => {});
    return alert;
  }

  // 只在状态真正翻转时告警，避免每轮探针都刷屏。
  function setStatus(next, reason) {
    const prev = state.status;
    state.reason = reason || "";
    if (prev === next) return;
    state.status = next;
    if (next === "down") pushAlert("error", "红果播放通道不可用：" + (reason || "取流失败"));
    else if (next === "degraded") pushAlert("warn", "红果官网播放通道异常，已回落到备用通道（" + (reason || "web 通道不可用") + "）");
    else if (next === "ok" && (prev === "down" || prev === "degraded")) pushAlert("recover", "红果播放通道已恢复（" + (state.channel || "web") + "）");
  }

  // 探针剧集：首页第一条剧的第一集；30 分钟内复用，持续失败时丢弃重选（剧集可能下架）。
  async function resolveProbe() {
    if (state.probe && Date.now() - state.probe.at < PROBE_TTL) return state.probe;
    const home = await catalog.home("hongguo", 1);
    const first = home && home.items && home.items[0];
    if (!first) throw fail("EMPTY", "红果首页为空，无法选择探针剧集");
    const detail = await catalog.detail("hongguo", first.id);
    const episodes = (detail.episodes && detail.episodes.length ? detail.episodes : [])
      .concat(detail.lines && detail.lines[0] ? detail.lines[0].episodes || [] : []);
    const episode = episodes[0];
    if (!episode) throw fail("EMPTY", "探针剧集没有分集");
    state.probe = { at: Date.now(), vid: String(episode.id), title: detail.title || first.title || "" };
    return state.probe;
  }

  async function run() {
    const started = Date.now();
    state.checks += 1;
    state.lastCheckAt = started;
    try {
      const probe = await resolveProbe();
      // fresh=true 绕过取址缓存，track=true 让失败计入熔断器与 /api/metrics。
      const stream = await provider.stream(probe.vid, { fresh: true, track: true });
      const chunk = await stream.chunk(0, 15);
      const head = Buffer.from(chunk).subarray(4, 8).toString("ascii");
      if (!(chunk.length >= 8 && head === "ftyp")) throw fail("UPSTREAM_EMPTY", "首块不是 ftyp（" + (head || "空") + "）");
      state.lastMs = Date.now() - started;
      state.lastOkAt = Date.now();
      state.lastError = "";
      state.fails = 0;
      state.okChecks += 1;
      // 官方通道（official，HEVC 多档）与官网明文通道（web）都算健康；
      // 只有官方失败后回落明文 360P 时才是 degraded——画质降级但能播。
      state.channel = stream.channel || "web";
      const degraded = state.channel !== "official";
      setStatus(
        degraded ? "degraded" : "ok",
        degraded ? "官方高清通道不可用，已回落到 360P 兼容通道" : ""
      );
      return snapshot();
    } catch (error) {
      const message = String((error && error.message) || error).slice(0, 300);
      state.lastMs = Date.now() - started;
      state.fails += 1;
      state.lastError = message;
      // 连续失败到阈值才判定 down；单次抖动只累加计数，不改状态。
      if (state.fails >= threshold) {
        if (state.fails === threshold) state.probe = null; // 可能是探针剧集下架，下轮重选
        setStatus("down", message);
      }
      return snapshot();
    }
  }

  // 并发合并：手动触发与定时触发撞车时共用同一次探针。
  function checkNow() {
    if (running) return running;
    running = run().finally(() => {
      running = null;
    });
    return running;
  }

  function start({ initialDelayMs = 20000 } = {}) {
    if (intervalTimer || initialTimer) return snapshot();
    if (initialDelayMs > 0) {
      initialTimer = setTimeout(() => {
        initialTimer = null;
        checkNow().catch(() => {});
      }, initialDelayMs);
      if (initialTimer.unref) initialTimer.unref();
    }
    intervalTimer = setInterval(() => {
      checkNow().catch(() => {});
    }, intervalMs);
    if (intervalTimer.unref) intervalTimer.unref();
    return snapshot();
  }

  function stop() {
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
  }

  return { start, stop, checkNow, snapshot };
}
