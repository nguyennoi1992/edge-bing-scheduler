#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
edge_bin=${EDGE_BIN:-microsoft-edge}
test_tmp=$(mktemp -d)
server_log="$test_tmp/http-server.log"

cleanup() {
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$test_tmp"
}
trap cleanup EXIT

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$repo_dir" >"$server_log" 2>&1 &
server_pid=$!

for _ in $(seq 1 50); do
  if curl --silent --fail "http://127.0.0.1:$port/manifest.json" >/dev/null; then
    break
  fi
  sleep 0.1
done

run_test() {
  local name=$1
  local output_file="$test_tmp/$name.html"
  local browser_log="$test_tmp/$name.edge.log"
  local profile_dir="$test_tmp/$name-profile"

  "$edge_bin" \
    --headless=new \
    --disable-gpu \
    --no-sandbox \
    --user-data-dir="$profile_dir" \
    --dump-dom "http://127.0.0.1:$port/tests/browser/$name.test.html" \
    >"$output_file" 2>"$browser_log"

  if ! grep -q 'data-status="pass"' "$output_file"; then
    sed -n '/id="result"/p' "$output_file"
    sed -n '1,120p' "$browser_log"
    return 1
  fi

  sed -n '/id="result"/p' "$output_file" | sed -E 's/.*data-status="pass">([^<]+).*/\1/'
}

run_test earn
run_test dashboard
