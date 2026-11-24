/*@CFG@*/
// Handles <prefix>/stats and <prefix>/gateway/status.
// Outputs: 1 -> evaluate, 2 -> rejection flow, 3 -> process (reset pending timers).
function bad(reason, detail) { msg.reason = reason; msg.detail = detail; msg.raw = msg.payload; return [null, msg, null]; }

let o;
try { o = JSON.parse(msg.payload); } catch (e) { return bad("invalid_json", e.message); }
if (o === null || typeof o !== "object" || Array.isArray(o)) return bad("wrong_type", "payload is not an object");

const cnt = flow.get("cnt") || { valid: 0, rejected: 0, flickers: 0, byReason: {} };
let resetMsg = null;

if (msg.topic === CFG.PREFIX + "/gateway/status") {
  if (!["online", "offline"].includes(o.status)) return bad("schema_violation", "status must be online|offline");
  flow.set("gateway", o.status);
  if (o.status === "online") {
    // A (re)started simulator restarts its sequence numbers and its simulated clock.
    flow.set("lastSeq", {}); flow.set("simNow", null); flow.set("runStart", null); flow.set("win", []);
    resetMsg = { reset: true };
    if (!msg.retain) {                           // live message => fresh session, start statistics from scratch
      cnt.valid = 0; cnt.rejected = 0; cnt.flickers = 0; cnt.byReason = {};
      flow.set("rejected", []); flow.set("dur", { n: 0, sum: 0 });
      flow.set("simStats", { turnedAway: 0, avgSim: 0 });
      const sp = flow.get("spots") || {};
      for (const k of Object.keys(sp)) sp[k] = newSpot(sp[k].id, sp[k].zone);
      flow.set("spots", sp);
      flow.set("lastBucket", null); flow.set("chartReset", true);
      flow.set("alarms", {}); flow.set("alarmLog", []);
    }
  }
} else {                                         // stats
  if (!Number.isInteger(o.turned_away) || o.turned_away < 0 || typeof o.avg_duration_min !== "number" || o.avg_duration_min < 0)
    return bad("schema_violation", "turned_away must be integer >= 0, avg_duration_min number >= 0");
  flow.set("simStats", { turnedAway: o.turned_away, avgSim: o.avg_duration_min });
}
cnt.valid++;
flow.set("cnt", cnt);
return [{ trigger: true }, null, resetMsg];
