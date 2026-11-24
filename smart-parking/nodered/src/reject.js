/*@CFG@*/
// Rejection flow: classify, count, log and publish every invalid message.
// Output 1 -> MQTT <prefix>/errors, output 2 -> dashboard refresh.
let reason = msg.reason, detail = msg.detail;
if (!reason) {                                   // message arrived from the catch node (JSON node failed)
  const errs = msg.schemaError;
  if (!errs) {
    reason = "invalid_json";
    detail = (msg.error && msg.error.message) || "payload is not valid JSON";
  } else {
    const kw = errs.map(e => e.keyword);
    const e0 = errs[0];
    if (kw.includes("required")) {
      reason = "missing_field";
      detail = "missing: " + errs.filter(e => e.keyword === "required").map(e => e.params.missingProperty).join(", ");
    } else if (kw.includes("type")) {
      const e = errs.find(x => x.keyword === "type");
      reason = "wrong_type"; detail = `${e.instancePath || "payload"} ${e.message}`;
    } else if (kw.some(k => ["enum", "minimum", "maximum"].includes(k))) {
      const e = errs.find(x => ["enum", "minimum", "maximum"].includes(x.keyword));
      reason = "out_of_range"; detail = `${e.instancePath || "payload"} ${e.message}`;
    } else {
      reason = "schema_violation"; detail = `${e0.instancePath || "payload"} ${e0.message}`;
    }
  }
}
const raw = msg.raw !== undefined ? msg.raw : msg.payload;
const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
const simNow = flow.get("simNow");
const ref = CFG.WALL ? Date.now() : simNow;

const cnt = flow.get("cnt") || { valid: 0, rejected: 0, flickers: 0, byReason: {} };
cnt.rejected++;
cnt.byReason[reason] = (cnt.byReason[reason] || 0) + 1;
flow.set("cnt", cnt);

const rec = {
  wall: new Date().toISOString(),
  sim: ref != null ? new Date(ref).toISOString().replace("T", " ").slice(0, 19) : "-",
  reason, detail: String(detail || "").slice(0, 160),
  topic: msg.topic, payload: String(rawStr).slice(0, 160)
};
const list = flow.get("rejected") || [];
list.unshift(rec);
if (list.length > 50) list.length = 50;
flow.set("rejected", list);

if (ref != null) {                               // feeds the "more than 10 % invalid in the last minute" alarm
  const win = flow.get("win") || [];
  win.push([ref, 1]);
  flow.set("win", win);
}

const errMsg = {
  topic: CFG.PREFIX + "/errors", qos: 1, retain: false,
  payload: JSON.stringify({ reason, detail: rec.detail, source_topic: msg.topic, raw_payload: rec.payload,
                            sim_time: rec.sim, rejected_at: rec.wall })
};
return [errMsg, { trigger: true }];
