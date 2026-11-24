/*@CFG@*/
// Runs on deploy: pre-create the spot list (state "unknown") so that the dashboard shows all spots immediately.
const spots = flow.get("spots") || {};
for (const z of CFG.ZONES)
  for (let i = 1; i <= CFG.PER_ZONE; i++) {
    const id = `${z}-${String(i).padStart(2, "0")}`;
    if (!spots[id]) spots[id] = newSpot(id, z);
  }
flow.set("spots", spots);
return null;
