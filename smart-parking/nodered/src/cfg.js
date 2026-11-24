// ---- Configuration: flow-level environment variables (Flow properties -> Environment Variables) ----
const CFG = {
  PREFIX:   env.get("TOPIC_PREFIX") || "uniwa/iot/ice26390276/parking",
  ZONES:    (env.get("KNOWN_ZONES") || "A,B").split(",").map(z => z.trim()).filter(Boolean),
  PER_ZONE: Number(env.get("SPOTS_PER_ZONE") || 10),
  HB_SEC:   Number(env.get("HEARTBEAT_INTERVAL_SEC") || 60),      // heartbeat period (simulated seconds)
  OFFLINE_N:Number(env.get("OFFLINE_INTERVALS") || 3),            // missed heartbeats => sensor offline
  BATT_LOW: Number(env.get("BATTERY_LOW_PCT") || 15),
  FULL:     Number(env.get("ZONE_FULL_PCT") || 100),
  ALMOST:   Number(env.get("ZONE_ALMOST_FULL_PCT") || 90),
  ERR_PCT:  Number(env.get("ERROR_RATE_PCT") || 10),
  ERR_WIN:  Number(env.get("ERROR_WINDOW_SEC") || 60) * 1000,
  ERR_MIN:  Number(env.get("ERROR_MIN_MSGS") || 10),              // min. messages in window before the rate counts
  FLICKER:  Number(env.get("FLICKER_SEC") || 10) * 1000,          // reversal within N s => flicker
  HOLD:     Number(env.get("FLICKER_HOLD_MS") || 1000),           // real-time debounce of state changes
  FUT:      Number(env.get("TS_FUTURE_TOL_SEC") || 120) * 1000,
  AGE:      Number(env.get("TS_MAX_AGE_SEC") || 600) * 1000,
  ALARM_HOLD: Number(env.get("ALARM_HOLD_SEC") || 8) * 1000,     // keep a cleared alarm visible for N real seconds
  STEP:     Number(env.get("CHART_STEP_SEC") || 300) * 1000,
  WALL:     (env.get("TIME_MODE") || "sim") === "wall"            // "sim": timestamps are simulated time
};
const newSpot = (id, zone) => ({ id, zone, occupied: null, since: null, battery: null,
                                  lastHbSim: null, lastChangeSim: null, offline: false });
