import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_REWARD_STABLE_MS,
  isDashboardRewardHref,
  shouldFinishEmptyRewardScan,
} from "../reward-dom-helpers.js";

test("dashboard reward href filter accepts earning activities", () => {
  const accepted = [
    "https://www.bing.com/search?q=daily+set",
    "https://www.bing.com/spotlight/imagepuzzle?form=ML2BF0",
    "https://rewards.bing.com/dashboard?form=dsetqu",
    "https://rewards.bing.com/activity?rnoreward=1",
    "https://www.bing.com/rewardsquiz_dailyset",
    "https://rewards.bing.com/activity?wqoskey=abc123",
  ];

  for (const href of accepted) {
    assert.equal(isDashboardRewardHref(href), true, href);
  }
});

test("dashboard reward href filter rejects Rewards navigation links", () => {
  const rejected = [
    "",
    "/earn",
    "/redeem",
    "/redeem/vn?section=shop",
    "https://rewards.bing.com/redeem",
    "https://rewards.bing.com/redeem/vn?section=shop",
  ];

  for (const href of rejected) {
    assert.equal(isDashboardRewardHref(href), false, href);
  }
});

test("stable empty scan finishes only after 20 seconds with the target section ready", () => {
  const readyEmpty = {
    readyState: "complete",
    hasTargetSection: true,
    count: 0,
    stableEmptyMs: EMPTY_REWARD_STABLE_MS,
  };

  assert.equal(shouldFinishEmptyRewardScan(readyEmpty), true);
  assert.equal(shouldFinishEmptyRewardScan({ ...readyEmpty, readyState: "loading" }), false);
  assert.equal(shouldFinishEmptyRewardScan({ ...readyEmpty, hasTargetSection: false }), false);
  assert.equal(shouldFinishEmptyRewardScan({ ...readyEmpty, count: 1 }), false);
  assert.equal(
    shouldFinishEmptyRewardScan({ ...readyEmpty, stableEmptyMs: EMPTY_REWARD_STABLE_MS - 1 }),
    false,
  );
});

test("stable empty scan supports an explicit time threshold", () => {
  assert.equal(
    shouldFinishEmptyRewardScan({
      readyState: "complete",
      hasTargetSection: true,
      count: 0,
      stableEmptyMs: 2_000,
      requiredStableMs: 2_000,
    }),
    true,
  );
});
