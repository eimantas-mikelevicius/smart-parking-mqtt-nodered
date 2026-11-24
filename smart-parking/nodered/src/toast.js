/*@CFG@*/
// Alarm event -> dashboard toast (output 1) and MQTT <prefix>/alarms (output 2).
const raised = msg.event === "RAISED";
const colors = { critical: "#c62828", warning: "#ef6c00", ok: "#2e7d32" };
const toast = {
  topic: raised ? (msg.sev === "critical" ? "ALARM" : "WARNING") : "RESOLVED",
  payload: msg.text,
  highlight: raised ? colors[msg.sev] : colors.ok,
  displayTime: raised ? 10 : 4
};
const mqttMsg = {
  topic: CFG.PREFIX + "/alarms", qos: 1, retain: false,
  payload: JSON.stringify({ event: msg.event, key: msg.key, severity: msg.sev, text: msg.text, sim_time: msg.sim })
};
return [toast, mqttMsg];
