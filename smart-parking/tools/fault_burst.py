#!/usr/bin/env python3
"""Demo helper: publish a burst of INVALID sensor messages so that every rejection reason and the
"more than 10 % invalid messages in the last minute" alarm can be shown (screenshots for the report).

Usage (from the project root, while the simulator and Node-RED are running):
    python tools/fault_burst.py            # 15 invalid messages
    python tools/fault_burst.py 40         # 40 invalid messages
"""
import json
import sys
import time

import paho.mqtt.client as mqtt
import yaml

with open("simulator/config.yaml", "r", encoding="utf-8") as f:
    cfg = yaml.safe_load(f)

HOST, PORT = cfg["broker"]["host"], cfg["broker"]["port"]
PREFIX = cfg["parking"]["topic_prefix"]
ZONES = cfg["parking"]["zones"]
N = int(sys.argv[1]) if len(sys.argv) > 1 else 15

z0, z1 = ZONES[0], ZONES[1]
spot = f"{z0}-01"
topic = f"{PREFIX}/{z0}/{spot}/state"
ts = "2026-12-01T12:00:00Z"
base = {"device_id": spot, "zone": z0, "type": "occupancy", "value": 1, "unit": "bool", "ts": ts, "seq": 1}

def variant(name, **chg):
    m = dict(base)
    m.update(chg)
    return json.dumps(m)

def missing():
    m = dict(base)
    del m["ts"]
    return json.dumps(m)

faults = [
    ("malformed JSON",       "{malformed_json_payload"),
    ("missing field (ts)",   missing()),
    ("wrong type",           variant("wt", value="yes")),
    ("out-of-range value",   variant("oor", value=2)),
    ("unknown zone",         variant("uz", zone="Z")),
    ("topic mismatch",       variant("tm", device_id=f"{z1}-99", zone=z1)),
    ("duplicate/old seq",    variant("ds", seq=0)),
    ("timestamp in future",  variant("fut", ts="2027-06-01T00:00:00Z", seq=10**9)),
]

c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
c.connect(HOST, PORT, 60)
c.loop_start()
for i in range(N):
    name, payload = faults[i % len(faults)]
    c.publish(topic, payload, qos=1, retain=False)
    print(f"[{i + 1}/{N}] {name}")
    time.sleep(0.05)
time.sleep(0.5)
c.loop_stop()
c.disconnect()
print("done")
