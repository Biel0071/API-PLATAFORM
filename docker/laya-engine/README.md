# Laya decision engine

This optional CPU service runs the upstream multilingual Laya checkpoint only
for typed FastLane route decisions. The selected Ollama model still generates
the response. It has no published host port and is disabled unless the `laya`
Compose profile is explicitly selected.

The host's current RAM and swap usage do not satisfy the resource gate. Do not
start this profile on that VPS until memory headroom has been measured under
the resident models and audio workload. If it is later approved, configure
`LAYA_BASE_URL=http://laya-engine:8000` for the API and start with
`docker compose --profile laya up -d laya-engine`; inspect its health and host
swap before enabling the API URL. The API otherwise uses its labeled heuristic
fallback and reports that Laya is unavailable.

The image pins the upstream Laya package and uses CPU-only PyTorch. Model cache
is stored in the `laya-models` volume. It is not downloaded or activated by the
default Compose stack.
