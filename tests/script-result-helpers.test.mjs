import assert from "node:assert/strict";
import test from "node:test";

import { getFirstScriptResult } from "../script-result-helpers.js";

test("returns the first executeScript result", () => {
  const result = { ready: true, count: 2 };
  assert.equal(getFirstScriptResult([{ result }], {}), result);
});

test("falls back for null or missing executeScript results", () => {
  const fallback = { ready: false, reason: "missing_result" };

  assert.equal(getFirstScriptResult([{ result: null }], fallback), fallback);
  assert.equal(getFirstScriptResult([], fallback), fallback);
  assert.equal(getFirstScriptResult(null, fallback), fallback);
});

test("preserves valid falsy script results", () => {
  assert.equal(getFirstScriptResult([{ result: false }], true), false);
  assert.equal(getFirstScriptResult([{ result: 0 }], 1), 0);
  assert.equal(getFirstScriptResult([{ result: "" }], "fallback"), "");
});
