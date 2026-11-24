// Stage 1b: attach the JSON Schema; keep the raw text for the error log.
msg.raw = msg.payload;
msg.kind = "heartbeat";
msg.schema = @SCHEMA@;
return msg;
