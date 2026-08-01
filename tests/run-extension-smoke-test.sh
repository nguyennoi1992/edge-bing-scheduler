#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")
edge_bin=${EDGE_BIN:-microsoft-edge}
test_tmp=$(mktemp -d)
profile_dir="$test_tmp/profile"
edge_log="$test_tmp/edge.log"

cleanup() {
  if [[ -n "${edge_pid:-}" ]]; then
    kill "$edge_pid" 2>/dev/null || true
    wait "$edge_pid" 2>/dev/null || true
  fi
  rm -rf -- "$test_tmp"
}
trap cleanup EXIT

"$edge_bin" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --no-first-run \
  --disable-background-networking \
  --user-data-dir="$profile_dir" \
  --disable-extensions-except="$repo_dir" \
  --load-extension="$repo_dir" \
  --remote-debugging-port=0 \
  about:blank >"$edge_log" 2>&1 &
edge_pid=$!

for _ in $(seq 1 100); do
  if [[ -s "$profile_dir/DevToolsActivePort" && -s "$profile_dir/Default/Preferences" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -s "$profile_dir/DevToolsActivePort" ]]; then
  sed -n '1,160p' "$edge_log"
  echo "Edge DevTools endpoint did not start" >&2
  exit 1
fi

port=$(sed -n '1p' "$profile_dir/DevToolsActivePort")
extension_id=""
for _ in $(seq 1 50); do
  extension_id=$(python3 -c '
import json
import pathlib
import sys

preferences = pathlib.Path(sys.argv[1])
repo = pathlib.Path(sys.argv[2]).resolve()
try:
    settings = json.loads(preferences.read_text()).get("extensions", {}).get("settings", {})
except (FileNotFoundError, json.JSONDecodeError):
    settings = {}
for extension_id, config in settings.items():
    path = config.get("path")
    if path and pathlib.Path(path).resolve() == repo:
        print(extension_id)
        break
' "$profile_dir/Default/Preferences" "$repo_dir")
  if [[ -n "$extension_id" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "$extension_id" ]]; then
  sed -n '1,160p' "$edge_log"
  echo "The unpacked extension was not registered by Edge" >&2
  exit 1
fi

popup_url="chrome-extension://$extension_id/popup.html"
encoded_popup_url=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$popup_url")
curl --silent --fail --request PUT "http://127.0.0.1:$port/json/new?$encoded_popup_url" >/dev/null

targets=""
for _ in $(seq 1 50); do
  targets=$(curl --silent --fail "http://127.0.0.1:$port/json/list")
  if printf '%s' "$targets" | grep -Fq "chrome-extension://$extension_id/background.js"; then
    break
  fi
  sleep 0.1
done

if ! printf '%s' "$targets" | grep -Fq "chrome-extension://$extension_id/background.js"; then
  printf '%s\n' "$targets"
  sed -n '1,160p' "$edge_log"
  echo "The extension service worker did not start" >&2
  exit 1
fi

echo "PASS: extension loaded with service worker $extension_id"
