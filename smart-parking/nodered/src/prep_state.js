// Stage 1a: attach the JSON Schema; keep the raw text for the error log.
msg.raw = msg.payload;
msg.kind = "state";
msg.schema = @SCHEMA@;
return msg;
