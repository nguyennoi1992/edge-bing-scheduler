import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("stable empty scan finishes only after the target section is ready", () => {
  const readyEmpty = {
    readyState: "complete",
    hasTargetSection: true,
    count: 0,
    stableEmptyRounds: 5,
  };

  assert.equal(shouldFinishEmptyRewardScan(readyEmpty), true);
  assert.equal(shouldFinishEmptyRewardScan({ ...readyEmpty, readyState: "loading" }), false);
  assert.equal(shouldFinishEmptyRewardScan({ ...readyEmpty, hasTargetSection: false }), false);
  assert.equal(shouldFinishEmptyRewardScan({ ...readyEmpty, count: 1 }), false);
  assert.equal(shouldFinishEmptyRewardScan({ ...readyEmpty, stableEmptyRounds: 4 }), false);
});

test("stable empty scan supports an explicit round threshold", () => {
  assert.equal(
    shouldFinishEmptyRewardScan({
      readyState: "complete",
      hasTargetSection: true,
      count: 0,
      stableEmptyRounds: 2,
      requiredStableRounds: 2,
    }),
    true,
  );
});
