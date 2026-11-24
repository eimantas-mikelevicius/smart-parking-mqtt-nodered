const timers = context.get("timers") || {};
for (const k of Object.keys(timers)) clearTimeout(timers[k].timer);
context.set("timers", {});
