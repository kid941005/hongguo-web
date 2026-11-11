#!/usr/bin/env node
// 发布冒烟：对运行中的实例做最小闭环检查（只读，不修改数据）。
// 用法：BASE=http://127.0.0.1:8787 node server/scripts/smoke.mjs
const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");
const results = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: String(error && error.message || error) });
  }
}

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { accept: "application/json" } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* keep text below */ }
  if (!res.ok) throw new Error(path + " -> HTTP " + res.status + " " + text.slice(0, 200));
  return body;
}

await check("health", async () => {
  const body = await getJson("/health");
  if (!body || body.ok !== true) throw new Error("ok != true");
  return "v" + body.version + " active=" + body.active + " sources=" + body.sources;
});

let active = "";
await check("sources", async () => {
  const body = await getJson("/api/sources");
  const list = (body && body.sources) || [];
  if (!list.length) throw new Error("没有可用源");
  active = body.active || active;
  if (!list.some((s) => s.id === active)) throw new Error("active 源不在列表中: " + active);
  return list.length + " 个源，active=" + active;
});

await check("home", async () => {
  const body = await getJson("/api/home?source=" + encodeURIComponent(active) + "&page=1");
  if (!Array.isArray(body.items) || !body.items.length) throw new Error("首页没有内容");
  return body.items.length + " 条";
});

await check("source-health", async () => {
  if (!active) throw new Error("未确定 active 源");
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const body = await getJson("/api/sources/" + encodeURIComponent(active) + "/health?deep=1");
      if (!body.ok) throw new Error("源自检失败: " + (body.error || "unknown"));
      if (body.playback && !body.playback.ok) throw new Error("取流自检失败: " + (body.playback.error || "unknown"));
      return (body.playback ? "取流 " + body.playback.total + " 字节" : "首页可达") + " / " + body.ms + "ms";
    } catch (error) {
      lastError = String(error && error.message || error);
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(lastError);
});

await check("alerts", async () => {
  const body = await getJson("/api/alerts");
  if (!body || body.enabled !== true) throw new Error("播放监控未启用（PLAYBACK_MONITOR=0？）");
  const allowed = ["ok", "degraded", "down", "unknown"];
  if (!allowed.includes(body.status)) throw new Error("status 异常: " + body.status);
  if (body.status === "down") throw new Error("通道不可用: " + (body.reason || "unknown"));
  return body.status + (body.channel ? "/" + body.channel : "") + " checks=" + body.checks;
});

for (const item of results) {
  console.log((item.ok ? "PASS" : "FAIL") + "  " + item.name.padEnd(14) + " " + item.ms + "ms  " + item.detail);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? "SMOKE FAILED: " + failed + "/" + results.length : "SMOKE OK: " + results.length + "/" + results.length);
process.exit(failed ? 1 : 0);
