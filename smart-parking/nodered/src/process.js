/*@CFG@*/
// Processing of VALID messages: spot state, flicker filter, heartbeat / battery, parking durations.
const timers = context.get("timers") || {};      // per-device pending (debounced) state change
context.set("timers", timers);

if (msg.reset) {                                 // new simulator session: drop pending changes
  for (const k of Object.keys(timers)) { clearTimeout(timers[k].timer); delete timers[k]; }
  return null;
}

function commitSpot(id, value, ts) {             // apply a confirmed state change
  const sp = flow.get("spots") || {};
  const d = flow.get("dur") || { n: 0, sum: 0 };
  const x = sp[id]; if (!x) return;
  if (value === 1) x.since = ts;
  else if (x.occupied === 1 && x.since != null) { d.n++; d.sum += (ts - x.since) / 60000; x.since = null; } // stay in minutes
  x.occupied = value; x.lastChangeSim = ts;
  flow.set("spots", sp); flow.set("dur", d);
}

const p = msg.payload, t = msg.simTs, id = p.device_id;
const cnt = flow.get("cnt") || { valid: 0, rejected: 0, flickers: 0, byReason: {} };
cnt.valid++;

const spots = flow.get("spots") || {};
if (!spots[id]) spots[id] = newSpot(id, p.zone);

if (msg.kind === "heartbeat") {
  spots[id].battery = p.battery;
  spots[id].lastHbSim = t;
  flow.set("spots", spots); flow.set("cnt", cnt);
  return { trigger: true };
}

// ---- occupancy state message ----
flow.set("spots", spots);
const cur = spots[id].occupied, v = p.value, pend = timers[id];

function schedule() {
  timers[id] = { value: v, ts: t, timer: setTimeout(() => {   // confirm after the debounce time
    const pd = timers[id]; if (!pd) return;
    delete timers[id];
    commitSpot(id, pd.value, pd.ts);
    node.send({ trigger: true });
  }, CFG.HOLD) };
}

if (cur === null && !pend) {
  commitSpot(id, v, t);                          // first report of this sensor: accept immediately
} else if (pend) {
  clearTimeout(pend.timer); delete timers[id];
  if (v !== pend.value && (t - pend.ts) <= CFG.FLICKER) {
    cnt.flickers++;                              // change reversed within a few seconds => flicker, ignore both
  } else {
    commitSpot(id, pend.value, pend.ts);         // previous change was real
    if (v !== pend.value) schedule();
  }
} else if (v !== cur) {
  schedule();                                    // wait: may be a flicker
}                                                // v === cur : repeated state, nothing changes

flow.set("cnt", cnt);
return { trigger: true };
