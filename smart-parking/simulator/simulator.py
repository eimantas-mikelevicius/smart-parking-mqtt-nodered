import hashlib
import json
import random
import time
from datetime import datetime, timedelta, timezone
import numpy as np
import paho.mqtt.client as mqtt
import yaml

with open("config.yaml", "r", encoding="utf-8") as conf_file:
    config = yaml.safe_load(conf_file)

BROKER_HOST = config["broker"]["host"]
BROKER_PORT = config["broker"]["port"]
TOTAL_SPOTS = config["parking"]["total_spots"]
spots_per_zone = config["parking"]["spots_per_zone"]
ZONES = config["parking"]["zones"]
SPEED_FACTOR = float(config["parking"]["speed_factor"])
FAULT_PROB = float(config["parking"]["fault_probability"])
SEED = str(config["parking"]["seed"])
TOPIC_PREFIX = config["parking"]["topic_prefix"]
# --- optional knobs
ARRIVAL_MULT = float(config["parking"].get("arrival_multiplier"))
DURATION_MULT = float(config["parking"].get("duration_multiplier"))
BATTERY_DRAIN_MULT = float(config["parking"].get("battery_drain_multiplier"))

seed_int = int(hashlib.sha256(SEED.encode("utf-8")).hexdigest(), 16) % (10**8)
random.seed(seed_int)
np.random.seed(seed_int)

spots = {}

for zone in ZONES:
    for i in range(1, spots_per_zone + 1):
        spot_id = f"{zone}-{i:02d}"
        spots[spot_id] = {
            "device_id": spot_id,
            "zone": zone,
            "occupied": 0,
            "leave_time": None,
            "flicker_revert_time": None,
            "flicker_restore_time": None,
            "battery": round(random.uniform(70.0, 100.0), 1),
            "seq": 0,
            "silent": False,
        }

silent_candidate = random.choice(list(spots.keys()))
turned_away = 0
stay_durations = []

client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
lwt_topic = f"{TOPIC_PREFIX}/gateway/status"
lwt_payload = json.dumps({"status": "offline", "reason": "unexpected_disconnect"})
client.will_set(lwt_topic, payload=lwt_payload, qos=1, retain=True)

client.connect(BROKER_HOST, BROKER_PORT, 60)
client.loop_start()
client.publish(lwt_topic, json.dumps({"status": "online"}), qos=1, retain=True)


def get_arrival_rate(hour):
    if 8 <= hour < 10 or 17 <= hour < 19:
        return 25.0
    if 10 <= hour < 17:
        return 10.0
    if 19 <= hour < 23:
        return 6.0
    return 1.5


def publish_state(spot, sim_time, value_override=None, inject_fault=True):
    if spot["silent"]:
        return
    spot["seq"] += 1
    topic = f"{TOPIC_PREFIX}/{spot['zone']}/{spot['device_id']}/state"
    val = spot["occupied"] if value_override is None else value_override
    payload = {
        "device_id": spot["device_id"],
        "zone": spot["zone"],
        "type": "occupancy",
        "value": val,
        "unit": "bool",
        "ts": sim_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "seq": spot["seq"],
    }

    if inject_fault and random.random() < FAULT_PROB:
        fault_type = random.choice([
            "bad_json",
            "wrong_value",
            "wrong_zone",
            "dup_seq",
            "missing_field",
            "wrong_type",
            "mismatch_topic",
        ])
        if fault_type == "bad_json":
            client.publish(topic, "{malformed_json_payload", qos=1)
            return
        if fault_type == "wrong_value":
            payload["value"] = 2
        elif fault_type == "wrong_zone":
            payload["zone"] = "Z"
        elif fault_type == "dup_seq":
            payload["seq"] -= 1
        elif fault_type == "missing_field":
            del payload["ts"]
        elif fault_type == "wrong_type":
            payload["value"] = "yes"
        elif fault_type == "mismatch_topic":
            other_zone = ZONES[1] if spot["zone"] == ZONES[0] else ZONES[0]
            payload["device_id"] = f"{other_zone}-99"
            payload["zone"] = other_zone

    client.publish(topic, json.dumps(payload), qos=1, retain=True)


def publish_heartbeat(spot, sim_time):
    if spot["silent"]:
        return
    spot["seq"] += 1
    spot["battery"] = max(5.0, round(spot["battery"] - random.uniform(0.01, 0.05) * BATTERY_DRAIN_MULT, 2))
    topic = f"{TOPIC_PREFIX}/{spot['zone']}/{spot['device_id']}/heartbeat"
    payload = {
        "device_id": spot["device_id"],
        "zone": spot["zone"],
        "type": "heartbeat",
        "battery": spot["battery"],
        "unit": "%",
        "ts": sim_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "seq": spot["seq"],
    }
    client.publish(topic, json.dumps(payload), qos=1)


def publish_stats(sim_time):
    avg_duration = round(sum(stay_durations) / len(stay_durations), 1) if stay_durations else 0.0
    topic = f"{TOPIC_PREFIX}/stats"
    payload = {
        "turned_away": turned_away,
        "avg_duration_min": avg_duration,
        "ts": sim_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    client.publish(topic, json.dumps(payload), qos=1, retain=True)


real_start = time.time()
sim_start = datetime(2026, 12, 1, 6, 0, 0, tzinfo=timezone.utc)
last_sim_time = sim_start
last_heartbeat_sim = sim_start
last_stats_sim = sim_start
silent_triggered = False

for s in spots.values():
    publish_state(s, sim_start, inject_fault=False)
publish_stats(sim_start)

print(f"Simulator started! Speed factor: 1s = {SPEED_FACTOR}s. Press Ctrl+C to stop.")

try:
    while True:
        time.sleep(0.5)
        real_elapsed = time.time() - real_start
        sim_time = sim_start + timedelta(seconds=real_elapsed * SPEED_FACTOR)
        sim_dt_hours = (sim_time - last_sim_time).total_seconds() / 3600.0
        last_sim_time = sim_time

        if not silent_triggered and (sim_time - sim_start).total_seconds() > 4 * 3600:
            spots[silent_candidate]["silent"] = True
            silent_triggered = True
            print(f"[!] Sensor {silent_candidate} stopped reporting (offline fault).")

        for s in spots.values():
            if s["flicker_revert_time"] and sim_time >= s["flicker_revert_time"]:
                s["flicker_revert_time"] = None
                publish_state(s, sim_time, value_override=0, inject_fault=False)

            if s["flicker_restore_time"] and sim_time >= s["flicker_restore_time"]:
                s["flicker_restore_time"] = None
                if s["occupied"] == 1:
                    publish_state(s, sim_time, value_override=1, inject_fault=False)

            if s["occupied"] == 1 and s["leave_time"] and sim_time >= s["leave_time"]:
                s["occupied"] = 0
                s["leave_time"] = None
                s["flicker_revert_time"] = None
                s["flicker_restore_time"] = None
                publish_state(s, sim_time)
                print(f"[{sim_time.strftime('%H:%M')}] Vehicle departed from {s['device_id']}")

        lam = get_arrival_rate(sim_time.hour) * ARRIVAL_MULT
        arrivals = np.random.poisson(lam * sim_dt_hours)
        for _ in range(arrivals):
            free_spots = [s for s in spots.values() if s["occupied"] == 0]
            if free_spots:
                chosen = random.choice(free_spots)
                chosen["occupied"] = 1
                duration_mins = float(np.random.lognormal(mean=2.6, sigma=0.6)) * DURATION_MULT
                duration_mins = max(10.0, min(duration_mins, 180.0))
                stay_durations.append(duration_mins)
                chosen["leave_time"] = sim_time + timedelta(minutes=duration_mins)

                if random.random() < 0.08:
                    chosen["flicker_revert_time"] = sim_time + timedelta(seconds=2)
                    chosen["flicker_restore_time"] = sim_time + timedelta(seconds=5)

                publish_state(chosen, sim_time)
                print(f"[{sim_time.strftime('%H:%M')}] Vehicle parked at {chosen['device_id']} ({int(duration_mins)} mins)")
            else:
                turned_away += 1
                print(f"[{sim_time.strftime('%H:%M')}] Parking full! Cars turned away: {turned_away}")

        if (sim_time - last_heartbeat_sim).total_seconds() >= 60:
            for s in spots.values():
                publish_heartbeat(s, sim_time)
            last_heartbeat_sim = sim_time

        if (sim_time - last_stats_sim).total_seconds() >= 60:
            publish_stats(sim_time)
            last_stats_sim = sim_time

except KeyboardInterrupt:
    print("Simulator stopped by user.")
    client.publish(lwt_topic, json.dumps({"status": "offline"}), qos=1, retain=True)
    client.loop_stop()
    client.disconnect()