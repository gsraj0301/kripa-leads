#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8787}"
LOG="${TMPDIR:-/tmp}/kripa-smoke-wrangler.log"
BASE="http://127.0.0.1:${PORT}"

cd "$ROOT"

if [[ ! -f .dev.vars ]]; then
  echo "Missing .dev.vars. Copy .env and add ENVIRONMENT=development, AUTH_DEV_BYPASS=true." >&2
  exit 1
fi

echo "==> building web assets"
npm run build:web >/dev/null

echo "==> applying local D1 migrations"
npx wrangler d1 migrations apply leads-kripa --local >/dev/null

echo "==> starting wrangler dev on :${PORT}"
npx wrangler dev --port "$PORT" >"$LOG" 2>&1 &
PID=$!
cleanup() {
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -sf "${BASE}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -sf "${BASE}/api/health" >/dev/null || {
  echo "Health check failed. See ${LOG}." >&2
  exit 1
}

echo "==> checking health, session, segments"
curl -sf "${BASE}/api/health" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  if(!j.ok) throw new Error("health not ok");
  console.log("health ok:", j.environment);
});'

curl -sf "${BASE}/api/me" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  if(!j.actor?.email) throw new Error("missing actor");
  console.log("actor:", j.actor.email, "("+j.actor.mode+")");
});'

curl -sf "${BASE}/api/segments" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  const ids=j.segments.map(x=>x.id);
  if(ids.join(",")!=="msme") throw new Error("expected only msme, got "+ids.join(","));
  console.log("enabled segments:", ids.join(","));
});'

echo "==> checking settings bootstrap and update"
curl -sf "${BASE}/api/settings" > "${TMPDIR:-/tmp}/kripa-settings.json"
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).settings;
if(j.configVersion<1) throw new Error("bad version");
if(typeof j.provisional!=="boolean") throw new Error("missing provisional flag");
fs.writeFileSync(process.argv[2], JSON.stringify({segments:j.segments,rubrics:j.rubrics,retention:j.retention,discovery:j.discovery}));
' "${TMPDIR:-/tmp}/kripa-settings.json" "${TMPDIR:-/tmp}/kripa-settings-put.json"

curl -sf -X PUT -H 'content-type: application/json' \
  --data-binary "@${TMPDIR:-/tmp}/kripa-settings-put.json" \
  "${BASE}/api/settings" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s).settings;
  if(j.approved!==false || j.provisional!==true) throw new Error("update should return to provisional");
  console.log("settings update ok, version", j.configVersion);
});'

curl -sf -X POST -H 'content-type: application/json' -d '{}' \
  "${BASE}/api/settings/approve" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s).settings;
  if(!j.approved || j.provisional) throw new Error("approval flags wrong");
  console.log("settings approval ok");
});'

echo "==> checking discovery routes"
curl -sf "${BASE}/api/runs" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  if(!Array.isArray(j.runs)) throw new Error("runs response missing array");
  console.log("runs listed:", j.runs.length);
});'

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"area":""}' "${BASE}/api/geocode")
[[ "$CODE" == "400" ]] || { echo "expected 400 for invalid geocode input, got $CODE" >&2; exit 1; }

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"areaText":"","segmentIds":[]}' "${BASE}/api/runs")
[[ "$CODE" == "400" ]] || { echo "expected 400 for invalid run input, got $CODE" >&2; exit 1; }

echo "==> checking invalid input and API 404"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' \
  -d '{"segments":[],"rubrics":{},"retention":{}}' "${BASE}/api/settings")
[[ "$CODE" == "400" ]] || { echo "expected 400 for invalid settings, got $CODE" >&2; exit 1; }

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/nope")
[[ "$CODE" == "404" ]] || { echo "expected 404 for unknown API route, got $CODE" >&2; exit 1; }

echo "==> checking static shell"
curl -sf "${BASE}/" | grep -q '<title>Kripa Leads</title>'

cleanup
trap - EXIT

echo "==> resetting local settings and events"
npx wrangler d1 execute leads-kripa --local \
  --command "DELETE FROM prospects; DELETE FROM deliveries; DELETE FROM runs; DELETE FROM settings; DELETE FROM events;" >/dev/null

echo "smoke test passed"
