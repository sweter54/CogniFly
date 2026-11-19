#!/usr/bin/env bash
# Local live smoke test of the app's Heartwood daemon supervision.
# Starts the Heartwood dev server (DynamoDB Local must answer on :8000),
# seeds the minimum registry, writes a temp config.toml and runs the
# ignored Rust test `live_status_roundtrip` against the real client.
# Local only, never touches AWS. Cleans up server, table and temp dirs.
#
# Env: HEARTWOOD_DIR (default ~/Documents/Heartwood, read-only),
#      HEARTWOOD_SMOKE_PORT (default 8791).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HW="${HEARTWOOD_DIR:-$HOME/Documents/Heartwood}"
BIN="$HW/client/target/debug/heartwood"
PORT="${HEARTWOOD_SMOKE_PORT:-8791}"
ORG=smoke
SUB=smoke-user
export HEARTWOOD_TABLE="heartwood-smoke-$(date +%s)-$$"
TMP="$(mktemp -d -t cf-hw-smoke)"
LOG="$TMP/server.log"
SERVER_PID=""

# Stops the dev server, drops the temp table and removes temp files.
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    pkill -P "$SERVER_PID" 2>/dev/null || true
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  (cd "$HW" && AWS_REGION=eu-central-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
    node --input-type=module -e "
      import { DynamoDBClient, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
      const db = new DynamoDBClient({ endpoint: 'http://localhost:8000' });
      await db.send(new DeleteTableCommand({ TableName: process.env.HEARTWOOD_TABLE }));
    " >/dev/null 2>&1) || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# Waits up to $2 seconds for command $1 to succeed.
wait_for() {
  for _ in $(seq 1 "$(( $2 * 5 ))"); do
    if eval "$1"; then return 0; fi
    sleep 0.2
  done
  return 1
}

# PUTs JSON $2 to the dev server's integration path $1.
put() {
  curl -fsS -X PUT -H 'content-type: application/json' -d "$2" "$URL$1" >/dev/null
}

[[ -x "$BIN" ]] || { echo "Brak $BIN (cargo build w $HW/client)" >&2; exit 1; }
curl -s -o /dev/null http://localhost:8000 || { echo "DynamoDB Local nie odpowiada na :8000" >&2; exit 1; }

(cd "$HW" && exec npm run --silent dev-server -- --port "$PORT") >"$LOG" 2>&1 &
SERVER_PID=$!
wait_for "grep -q '^READY ' '$LOG'" 30 || { cat "$LOG" >&2; echo "Serwer nie wystartował" >&2; exit 1; }
read -r _ URL WS_URL < <(grep '^READY ' "$LOG")
echo "Serwer: $URL, tabela $HEARTWOOD_TABLE"

put "/int/orgs/$ORG" '{"name":"Smoke"}'
put "/int/orgs/$ORG/people/$SUB" '{"isAdmin":false}'
put "/int/orgs/$ORG/workspaces/wspolne" '{"name":"Wspólne"}'
put "/int/orgs/$ORG/workspaces/wspolne/topics/Dokumenty" '{}'
put "/int/orgs/$ORG/workspaces/wspolne/grants/$SUB" '{"right":"write"}'

# Unsigned JWT with a far `exp`; the dev server reads its `sub`.
JWT="$(SUB="$SUB" node -e "
  const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  console.log(e({alg:'none',typ:'JWT'}) + '.' + e({sub:process.env.SUB,exp:4102444800}) + '.dev');")"
CFG="$TMP/config.toml"
cat >"$CFG" <<TOML
server_url = "$URL"
ws_url = "$WS_URL"
token_command = ["echo", "$JWT"]
root = "$TMP/root"
org = "$ORG"
TOML

cd "$HERE/../src-tauri"
COGNIFLY_HEARTWOOD_CONFIG="$CFG" COGNIFLY_HEARTWOOD_BIN="$BIN" \
  cargo test -- --ignored live_status_roundtrip --nocapture
