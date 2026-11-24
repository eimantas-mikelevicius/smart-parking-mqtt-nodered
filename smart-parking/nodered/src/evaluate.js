/*@CFG@*/
// Central evaluation: offline detection, per-zone aggregates, alarms, chart samples and the dashboard snapshot.
// Triggered by every processed message and by a 1 s timer.
// Output 1 = snapshot for the dashboard widgets, 2 = alarm events, 3 = chart samples.
const spots = flow.get("spots") || {};
const cnt = flow.get("cnt") || { valid: 0, rejected: 0, flickers: 0, byReason: {} };
const simStats = flow.get("simStats") || { turnedAway: 0, avgSim: 0 };
const dur = flow.get("dur") || { n: 0, sum: 0 };
const gateway = flow.get("gateway") || "unknown";
const ref = CFG.WALL ? Date.now() : flow.get("simNow");
const runStart = flow.get("runStart");
const fmt = ms => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const r1 = x => Math.round(x * 10) / 10;
const chart = [];
const hist = flow.get("chartHist") || [];           // occupancy history: [{t, v:{"Zone A":pct,...,"Total":pct}}]
let sendChart = false;
if (flow.get("chartReset")) { flow.set("chartReset", false); hist.length = 0; sendChart = true; }   // new run -> clear chart

// ---- 1) sensor offline detection: no heartbeat for OFFLINE_N consecutive intervals ----
if (ref != null) {
  const limit = CFG.OFFLINE_N * CFG.HB_SEC * 1000;
  for (const s of Object.values(spots)) {
    const base = s.lastHbSim != null ? s.lastHbSim : runStart;
    s.offline = base != null && (ref - base) > limit;
  }
  flow.set("spots", spots);
}

// ---- 2) aggregates per zone / total (offline sensors are excluded from the occupancy percentage) ----
const zones = {};
const mk = z => ({ zone: z, total: 0, free: 0, occupied: 0, offline: 0, unknown: 0, monitored: 0, pct: 0 });
for (const z of CFG.ZONES) zones[z] = mk(z);
const tot = mk("Total");
const spotList = [];
for (const s of Object.values(spots)) {
  const z = zones[s.zone] || (zones[s.zone] = mk(s.zone));
  const state = s.offline ? "offline" : s.occupied === 1 ? "occupied" : s.occupied === 0 ? "free" : "unknown";
  for (const a of [z, tot]) { a.total++; a[state]++; }
  spotList.push({ id: s.id, zone: s.zone, state, battery: s.battery, since: s.since != null ? fmt(s.since) : null });
}
spotList.sort((a, b) => a.id.localeCompare(b.id));
const zoneArr = Object.values(zones).sort((a, b) => a.zone.localeCompare(b.zone));
for (const a of [...zoneArr, tot]) {
  a.monitored = a.free + a.occupied;
  a.pct = a.monitored ? r1(a.occupied / a.monitored * 100) : 0;
}

// ---- 3) invalid-message rate in the last minute (simulated time) ----
let win = flow.get("win") || [];
if (ref != null) win = win.filter(e => e[0] > ref - 2 * CFG.ERR_WIN);
flow.set("win", win);
const inWin = ref == null ? [] : win.filter(e => e[0] > ref - CFG.ERR_WIN);
const winBad = inWin.filter(e => e[1] === 1).length, winTot = inWin.length;
const winRate = winTot ? r1(winBad / winTot * 100) : 0;

// ---- 4) alarms ----
const want = {};
for (const z of zoneArr) {
  if (z.monitored === 0) continue;
  if (z.pct >= CFG.FULL) want["zone_full:" + z.zone] = { sev: "critical", text: `Zone ${z.zone} is FULL (${z.pct} %)` };
  else if (z.pct > CFG.ALMOST) want["zone_almost:" + z.zone] = { sev: "warning", text: `Zone ${z.zone} is almost full (${z.pct} %)` };
}
for (const s of Object.values(spots)) {
  if (s.offline) want["offline:" + s.id] = { sev: "critical", text: `Sensor ${s.id} stopped reporting (no heartbeat for ${CFG.OFFLINE_N} intervals)` };
  if (s.battery != null && s.battery < CFG.BATT_LOW) want["battery:" + s.id] = { sev: "warning", text: `Battery of sensor ${s.id} is low (${s.battery} %)` };
}
if (winTot >= CFG.ERR_MIN && winRate > CFG.ERR_PCT)
  want["error_rate"] = { sev: "critical", text: `${winRate} % of the messages in the last minute are invalid (${winBad}/${winTot})` };
if (gateway === "offline") want["gateway"] = { sev: "critical", text: "Simulator / gateway is offline" };

const active = flow.get("alarms") || {};
const log = flow.get("alarmLog") || [];
const events = [];
const now = ref != null ? fmt(ref) : "-";
for (const k of Object.keys(want)) {
  if (!active[k]) {
    active[k] = { key: k, sev: want[k].sev, text: want[k].text, since: now };
    log.unshift({ time: now, event: "RAISED", sev: want[k].sev, text: want[k].text });
    events.push({ event: "RAISED", key: k, sev: want[k].sev, text: want[k].text, sim: now });
  } else { active[k].text = want[k].text; }
  active[k].seen = Date.now();                       // condition still true
}
for (const k of Object.keys(active)) {
  if (!want[k] && Date.now() - (active[k].seen || 0) >= CFG.ALARM_HOLD) {   // latch: avoids flapping, keeps the alarm visible
    log.unshift({ time: now, event: "CLEARED", sev: "ok", text: active[k].text });
    events.push({ event: "CLEARED", key: k, sev: "ok", text: active[k].text, sim: now });
    delete active[k];
  }
}
if (log.length > 60) log.length = 60;
flow.set("alarms", active); flow.set("alarmLog", log);

// ---- 5) occupancy chart: one sample every CHART_STEP seconds of (simulated) time ----
// The chart is drawn as SVG by the template widget, because the standard chart widget would place the
// simulated timestamps on the real-time axis. Here the axis is a 24 h window of simulated UTC time.
if (ref != null) {
  const bucket = Math.floor(ref / CFG.STEP);
  if (flow.get("lastBucket") !== bucket) {
    flow.set("lastBucket", bucket);
    const v = { Total: tot.pct };
    for (const z of zoneArr) v["Zone " + z.zone] = z.pct;
    hist.push({ t: bucket * CFG.STEP, v });
    if (hist.length > 2000) hist.shift();
    sendChart = true;
  }
}
flow.set("chartHist", hist);
if (sendChart) {
  const names = [...zoneArr.map(z => "Zone " + z.zone), "Total"];
  const colors = ["#1f77b4", "#ff7f0e", "#9467bd", "#8c564b", "#2ca02c"];
  const W = 900, H = 300, L = 42, R = 14, T = 12, B = 30, HOUR = 3600e3, DAY = 24 * HOUR;
  let start = hist.length ? Math.floor(hist[0].t / HOUR) * HOUR : 0;
  if (hist.length && hist[hist.length - 1].t > start + DAY) start = Math.ceil((hist[hist.length - 1].t - DAY) / HOUR) * HOUR;
  const X = t => L + (t - start) / DAY * (W - L - R);
  const Y = p => T + (100 - p) / 100 * (H - T - B);
  const pts = hist.filter(h => h.t >= start);
  const lines = hist.length ? names.map((n, i) => ({
    name: n, color: n === "Total" ? "#2ca02c" : colors[i % 3], width: n === "Total" ? 2.6 : 1.8,
    dash: n === "Total" ? "6 3" : "",
    points: pts.map(h => X(h.t).toFixed(1) + "," + Y(h.v[n] || 0).toFixed(1)).join(" "),
    last: pts.length ? pts[pts.length - 1].v[n] : 0 })) : [];
  const xticks = [], yticks = [];
  if (hist.length) for (let t = start; t <= start + DAY; t += 2 * HOUR)
    xticks.push({ x: r1(X(t)), label: new Date(t).toISOString().slice(11, 16) });
  for (const p of [0, 25, 50, 75, 100]) yticks.push({ y: r1(Y(p)), label: p + "" });
  chart.push({ topic: "chart", payload: { W, H, L, R, T, B, lines, xticks, yticks, empty: !hist.length,
                                           day: hist.length ? new Date(start).toISOString().slice(0, 10) : "" } });
}

// ---- 6) snapshot for the dashboard ----
// display order: zone alarms first, then message errors, gateway, offline sensors, "almost full", batteries
const rank = k => k.startsWith("zone_full") ? 0 : k === "error_rate" ? 1 : k === "gateway" ? 2 : k.startsWith("offline") ? 3
                  : k.startsWith("zone_almost") ? 4 : 5;
const snapshot = {
  simTime: ref != null ? fmt(ref) : "-",
  gateway, zones: zoneArr, total: tot, spots: spotList,
  stats: { turnedAway: simStats.turnedAway, avgStay: dur.n ? r1(dur.sum / dur.n) : 0, stays: dur.n, avgSim: simStats.avgSim },
  counters: { valid: cnt.valid, rejected: cnt.rejected, flickers: cnt.flickers, byReason: cnt.byReason,
              winBad, winTot, winRate },
  rejected: (flow.get("rejected") || []).slice(0, 15),
  alarms: Object.values(active).sort((a, b) => (rank(a.key) - rank(b.key)) || a.key.localeCompare(b.key)),
  alarmLog: log.slice(0, 15)
};
return [{ topic: "snapshot", payload: snapshot }, events, chart];
