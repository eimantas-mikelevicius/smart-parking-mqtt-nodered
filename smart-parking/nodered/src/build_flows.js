#!/usr/bin/env node
// Generates ../data/flows.json from the readable sources in this directory.
// Usage: node nodered/src/build_flows.js [topic_prefix] [zones]   e.g.  node build_flows.js uniwa/iot/ice26390276/parking A,B
const fs = require("fs"), path = require("path");
const read = f => fs.readFileSync(path.join(__dirname, f), "utf8");
const PREFIX = process.argv[2] || "uniwa/iot/ice26390276/parking";
const ZONES  = process.argv[3] || "A,B";
const RN     = PREFIX.split("/")[2];                       // registration number shown in the dashboard title
const CFG    = read("cfg.js");
const fn = f => read(f).replace("/*@CFG@*/", CFG);
const schema = f => JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, "../../schemas", f), "utf8")));

const TAB = "tab_parking";
const nodes = [];
const add = n => (nodes.push(Object.assign({ z: TAB }, n)), n);

nodes.push({
  id: TAB, type: "tab", label: "Smart Parking", disabled: false,
  info: "Smart parking monitoring: validation -> processing -> dashboard + alarms.\nConfiguration: Flow properties -> Environment Variables.",
  env: [
    ["TOPIC_PREFIX", PREFIX], ["KNOWN_ZONES", ZONES], ["SPOTS_PER_ZONE", "10"], ["TIME_MODE", "sim"],
    ["HEARTBEAT_INTERVAL_SEC", "60"], ["OFFLINE_INTERVALS", "3"], ["BATTERY_LOW_PCT", "15"],
    ["ZONE_FULL_PCT", "100"], ["ZONE_ALMOST_FULL_PCT", "90"],
    ["ERROR_RATE_PCT", "10"], ["ERROR_WINDOW_SEC", "60"], ["ERROR_MIN_MSGS", "10"],
    ["FLICKER_SEC", "10"], ["FLICKER_HOLD_MS", "1000"], ["TS_FUTURE_TOL_SEC", "120"], ["TS_MAX_AGE_SEC", "600"],
    ["ALARM_HOLD_SEC", "8"], ["CHART_STEP_SEC", "300"]
  ].map(([name, value]) => ({ name, value, type: "str" }))
});

nodes.push({ id: "mqtt_broker", type: "mqtt-broker", name: "Mosquitto", broker: "${MQTT_HOST}", port: "1883",
  clientid: "", autoConnect: true, usetls: false, protocolVersion: "4", keepalive: "60", cleansession: true,
  autoUnsubscribe: true, birthTopic: "", closeTopic: "", willTopic: "" });

const mqttIn = (id, name, topic, y, wires) => add({ id, type: "mqtt in", name, topic, qos: "1", datatype: "utf8",
  broker: "mqtt_broker", nl: false, rap: false, rh: 0, inputs: 0, x: 150, y, wires: [wires] });
const func = (id, name, file, x, y, outputs, wires, extra = {}) => add(Object.assign({
  id, type: "function", name, func: fn(file), outputs, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [],
  x, y, wires }, extra));

// ---------- 1. input + validation ----------
mqttIn("in_state", "state  (QoS1, retained)", PREFIX + "/+/+/state", 100, ["prep_state"]);
mqttIn("in_hb", "heartbeat", PREFIX + "/+/+/heartbeat", 180, ["prep_hb"]);
mqttIn("in_stats", "stats", PREFIX + "/stats", 280, ["sg"]);
mqttIn("in_gw", "gateway/status (LWT)", PREFIX + "/gateway/status", 340, ["sg"]);

func("prep_state", "1a. attach state schema", "prep_state.js", 380, 100, 1, [["json_state"]]);
nodes[nodes.length - 1].func = read("prep_state.js").replace("@SCHEMA@", schema("state.schema.json"));
func("prep_hb", "1b. attach heartbeat schema", "prep_heartbeat.js", 380, 180, 1, [["json_hb"]]);
nodes[nodes.length - 1].func = read("prep_heartbeat.js").replace("@SCHEMA@", schema("heartbeat.schema.json"));
add({ id: "json_state", type: "json", name: "syntax + JSON Schema", property: "payload", action: "obj", pretty: false,
  x: 620, y: 100, wires: [["validate"]] });
add({ id: "json_hb", type: "json", name: "syntax + JSON Schema", property: "payload", action: "obj", pretty: false,
  x: 620, y: 180, wires: [["validate"]] });
add({ id: "catch_json", type: "catch", name: "schema / syntax errors", scope: ["json_state", "json_hb"], uncaught: false,
  x: 620, y: 240, wires: [["reject"]] });
func("validate", "2. topic / seq / timestamp checks", "validate.js", 880, 140, 2, [["process"], ["reject"]]);

// ---------- 2. processing ----------
func("process", "3. process valid (flicker, battery, durations)", "process.js", 1190, 100, 1, [["evaluate"]],
  { finalize: read("process_finalize.js") });
func("sg", "stats + gateway handler", "sg.js", 380, 310, 3, [["evaluate"], ["reject"], ["process"]]);

// ---------- 3. rejection flow ----------
func("reject", "4. reject: classify, count, log", "reject.js", 1190, 240, 2, [["out_errors"], ["evaluate"]]);
add({ id: "out_errors", type: "mqtt out", name: "<prefix>/errors", topic: "", qos: "", retain: "", respTopic: "",
  contentType: "", userProps: "", correl: "", expiry: "", broker: "mqtt_broker", x: 1500, y: 240, wires: [] });

// ---------- 4. evaluation, dashboard, alarms ----------
add({ id: "tick", type: "inject", name: "every 1 s", props: [{ p: "payload" }], repeat: "1", crontab: "", once: true,
  onceDelay: "1", topic: "", payload: "", payloadType: "date", x: 1190, y: 340, wires: [["evaluate"]] });
add({ id: "init_inj", type: "inject", name: "on deploy", props: [], repeat: "", crontab: "", once: true, onceDelay: "0.1",
  topic: "", x: 150, y: 420, wires: [["init"]] });
func("init", "pre-create spot list", "init.js", 380, 420, 1, [[]]);
func("evaluate", "5. evaluate: aggregates + alarms + snapshot", "evaluate.js", 1500, 340, 3,
  [["rate"], ["toast_fn"], ["w_chart"]]);
add({ id: "rate", type: "delay", name: "max 2 updates/s", pauseType: "rate", timeout: "5", timeoutUnits: "seconds",
  rate: "2", nbRateUnits: "1", rateUnits: "second", randomFirst: "1", randomLast: "5", randomUnits: "seconds",
  drop: true, allowrate: false, outputs: 1, x: 1760, y: 340,
  wires: [["w_kpi", "w_spots", "w_alarms", "w_rejected"]] });
func("toast_fn", "alarm -> toast + MQTT", "toast.js", 1760, 440, 2, [["w_toast"], ["out_alarms"]]);
add({ id: "out_alarms", type: "mqtt out", name: "<prefix>/alarms", topic: "", qos: "", retain: "", respTopic: "",
  contentType: "", userProps: "", correl: "", expiry: "", broker: "mqtt_broker", x: 2000, y: 480, wires: [] });

// ---------- 5. dashboard ----------
nodes.push({ id: "cfg_ui_base", type: "ui_base", theme: { name: "theme-light",
  lightTheme: { default: "#0094CE", baseColor: "#0094CE", baseFont: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen-Sans,Ubuntu,Cantarell,Helvetica Neue,sans-serif", edited: true, reset: false },
  darkTheme: { default: "#097479", baseColor: "#097479", baseFont: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen-Sans,Ubuntu,Cantarell,Helvetica Neue,sans-serif", edited: false },
  customTheme: { name: "Untitled Theme 1", default: "#4B7930", baseColor: "#4B7930", baseFont: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen-Sans,Ubuntu,Cantarell,Helvetica Neue,sans-serif" },
  themeState: { "base-color": { default: "#0094CE", value: "#0094CE", edited: false },
    "page-titlebar-backgroundColor": { value: "#0094CE", edited: false }, "page-backgroundColor": { value: "#fafafa", edited: false },
    "page-sidebar-backgroundColor": { value: "#ffffff", edited: false }, "group-textColor": { value: "#1bbfff", edited: false },
    "group-borderColor": { value: "#ffffff", edited: false }, "group-backgroundColor": { value: "#ffffff", edited: false },
    "widget-textColor": { value: "#111111", edited: false }, "widget-backgroundColor": { value: "#0094ce", edited: false },
    "widget-borderColor": { value: "#ffffff", edited: false },
    "base-font": { value: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen-Sans,Ubuntu,Cantarell,Helvetica Neue,sans-serif" } },
  angularTheme: { primary: "indigo", accents: "blue", warn: "red", background: "grey", palette: "light" } },
  site: { name: `Smart Parking Dashboard - ${RN}`, hideToolbar: "false", allowSwipe: "false", lockMenu: "false",
    allowTempTheme: "true", dateFormat: "DD/MM/YYYY", sizes: { sx: 48, sy: 48, gx: 6, gy: 6, cx: 6, cy: 6, px: 0, py: 0 } } });
nodes.push({ id: "cfg_ui_tab", type: "ui_tab", name: `Smart Parking - ${RN}`, icon: "dashboard", order: 1, disabled: false, hidden: false });
const grp = (id, name, order) => nodes.push({ id, type: "ui_group", name, tab: "cfg_ui_tab", order, disp: true, width: "12", collapse: false, className: "" });
grp("g_over", "Overview", 1); grp("g_chart", "Occupancy over time (simulated UTC)", 2); grp("g_spots", "Parking spots", 3);
grp("g_alarm", "Alarms", 4); grp("g_valid", "Message validation", 5);

const tpl = (id, name, group, order, file, y, h = 0) => add({ id, type: "ui_template", name, group, order, width: "12", height: String(h),
  format: read("templates/" + file), storeOutMessages: false, fwdInMessages: false, resendOnRefresh: true,
  templateScope: "local", className: "", x: 2020, y, wires: [[]] });
tpl("w_kpi", "KPI cards", "g_over", 1, "kpi.html", 260, 5);
tpl("w_spots", "Spot map", "g_spots", 1, "spots.html", 320, 7);
tpl("w_alarms", "Active alarms", "g_alarm", 1, "alarms.html", 380, 9);
tpl("w_rejected", "Rejected messages", "g_valid", 1, "rejected.html", 440, 10);

tpl("w_chart", "Occupancy chart", "g_chart", 1, "chart.html", 560, 7);
add({ id: "w_toast", type: "ui_toast", position: "top right", displayTime: "8", highlight: "", sendall: true,
  outputs: 0, ok: "OK", cancel: "", raw: false, className: "", topic: "", name: "alarm toast", x: 2010, y: 400, wires: [] });

fs.writeFileSync(path.join(__dirname, "../data/flows.json"), JSON.stringify(nodes, null, 2));
console.log(`flows.json written: ${nodes.length} nodes, prefix=${PREFIX}, zones=${ZONES}`);
