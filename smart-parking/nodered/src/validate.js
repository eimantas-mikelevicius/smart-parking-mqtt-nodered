/*@CFG@*/
// Stage 2: semantic validation (JSON syntax + JSON Schema were already checked by the JSON node).
// Output 1 = valid message, output 2 = invalid message (-> rejection flow).
const p = msg.payload;
const rest = msg.topic.startsWith(CFG.PREFIX + "/") ? msg.topic.slice(CFG.PREFIX.length + 1).split("/") : [];
const tZone = rest[0], tSpot = rest[1];

function reject(reason, detail) { msg.reason = reason; msg.detail = detail; return [null, msg]; }

// 1) unknown zone
if (!CFG.ZONES.includes(p.zone))
  return reject("unknown_zone", `zone "${p.zone}" is not one of [${CFG.ZONES.join(",")}]`);

// 2) topic consistency: device_id and zone must equal the ones in the topic
if (p.device_id !== tSpot || p.zone !== tZone)
  return reject("topic_mismatch", `payload ${p.zone}/${p.device_id} <> topic ${tZone}/${tSpot}`);

// 3) duplicates / out-of-order: seq must increase per device
const lastSeq = flow.get("lastSeq") || {};
const last = lastSeq[p.device_id];
if (last !== undefined && p.seq <= last) {
  if (msg.retain) return [null, null];        // replay of an already processed retained message -> silently ignore
  return reject("duplicate_seq", `seq ${p.seq} <= last accepted ${last}`);
}

// 4) plausibility of the timestamp (reference clock = latest simulated time seen, or wall clock in TIME_MODE=wall)
const t = Date.parse(p.ts);
if (isNaN(t)) return reject("bad_timestamp", `cannot parse "${p.ts}"`);
let simNow = flow.get("simNow");
const ref = CFG.WALL ? Date.now() : simNow;
if (ref != null) {
  // retained messages describe an older state and may be newer than a still-empty clock
  if ((CFG.WALL || !msg.retain) && t > ref + CFG.FUT)
    return reject("ts_future", `ts ${p.ts} is ${Math.round((t - ref) / 1000)} s ahead of the clock`);
  if (!msg.retain && t < ref - CFG.AGE)
    return reject("ts_too_old", `ts ${p.ts} is ${Math.round((ref - t) / 1000)} s behind the clock`);
}

// ---- message accepted ----
lastSeq[p.device_id] = p.seq;
flow.set("lastSeq", lastSeq);
if (!CFG.WALL && (simNow == null || t > simNow)) { simNow = t; flow.set("simNow", t); }
// start of the observation: first LIVE message (retained replays carry old timestamps)
if (flow.get("runStart") == null && !msg.retain) flow.set("runStart", CFG.WALL ? Date.now() : t);

const win = flow.get("win") || [];          // [stamp, isInvalid] entries for the error-rate alarm
win.push([CFG.WALL ? Date.now() : simNow, 0]);
flow.set("win", win);

msg.simTs = t;
return [msg, null];
