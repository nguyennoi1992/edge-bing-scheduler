#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")
cd "$repo_dir"

if [[ -n "${NODE_BIN:-}" ]]; then
  node_bin=$NODE_BIN
elif command -v node >/dev/null 2>&1; then
  node_bin=$(command -v node)
elif command -v node-lts >/dev/null 2>&1; then
  node_bin=$(command -v node-lts)
else
  echo "Node.js was not found. Set NODE_BIN or install node/node-lts." >&2
  exit 1
fi

js_files=(
  background.js
  popup.js
  options.js
  sidebar.js
  reward-dom-helpers.js
  reward-scanner-helpers.js
  script-result-helpers.js
  words.js
  tests/browser/reward-browser-test-helpers.js
)

echo "Running Node tests with $node_bin"
"$node_bin" --test tests/*.test.mjs

echo "Checking JavaScript syntax"
for file in "${js_files[@]}"; do
  "$node_bin" --check "$file"
done

echo "Checking manifest and shell scripts"
python3 -m json.tool manifest.json >/dev/null
bash -n tests/run-browser-tests.sh tests/run-extension-smoke-test.sh tests/run-all-tests.sh

echo "Running Microsoft Edge browser tests"
tests/run-browser-tests.sh

echo "Loading the extension in Microsoft Edge"
tests/run-extension-smoke-test.sh

echo "All tests passed"
