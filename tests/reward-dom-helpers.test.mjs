import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_REWARD_STABLE_MS,
  classifyRewardScanState,
  findQuizCompletionPhrase,
  getRewardHydrationRetryDelay,
  isActionableRewardCard,
  isDashboardRewardHref,
  shouldFinishEmptyRewardScan,
} from "../reward-dom-helpers.js";

test("dashboard reward href filter accepts earning activities", () => {
  const accepted = [
    "https://www.bing.com/search?q=daily+set",
    "https://www.bing.com/spotlight/imagepuzzle?form=ML2BF0",
    "https://www.bing.com/shop?form=COCBHP&ocid=COCBHP",
    "https://www.bing.com/?features=vstooltip&publ=RewardsDO",
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
    "/earn/",
    "/earn?form=nav",
    "/redeem",
    "/redeem/vn?section=shop",
    "https://rewards.bing.com/earn",
    "https://rewards.bing.com/earn/",
    "https://rewards.bing.com/redeem",
    "https://rewards.bing.com/redeem/vn?section=shop",
  ];

  for (const href of rejected) {
    assert.equal(isDashboardRewardHref(href), false, href);
  }
});

test("reward card filter rejects disclosure headers without rejecting heading content", () => {
  const base = {
    href: "https://www.bing.com/search?q=daily+activity",
    text: "Daily activity",
    hasVisual: true,
    isDisabled: false,
    isCompleted: false,
    isVisible: true,
    isInNav: false,
    isQuestCard: false,
    isPressable: true,
  };

  assert.equal(isActionableRewardCard({ ...base, isHeader: true }), false);
  assert.equal(isActionableRewardCard({ ...base, isHeader: false }), true);
});

test("reward card filter rejects Earn page navigation URLs", () => {
  const base = {
    text: "Browse activities",
    hasVisual: true,
    isDisabled: false,
    isCompleted: false,
    isVisible: true,
    isInNav: false,
    isQuestCard: false,
    isHeader: false,
    isPressable: true,
  };

  for (const href of [
    "/earn",
    "/earn/",
    "/earn?form=nav",
    "https://rewards.bing.com/earn",
    "https://rewards.bing.com/earn/",
  ]) {
    assert.equal(isActionableRewardCard({ ...base, href }), false, href);
  }
});

test("reward card filter rejects section chrome without rejecting real buttons", () => {
  const base = {
    href: "",
    text: "Keep earning",
    hasVisual: true,
    isDisabled: false,
    isCompleted: false,
    isVisible: true,
    isInNav: false,
    isQuestCard: false,
    isHeader: false,
    isPressable: true,
  };

  assert.equal(isActionableRewardCard({ ...base, isSectionChrome: true }), false);
  assert.equal(
    isActionableRewardCard({ ...base, text: "Open bonus activity", isSectionChrome: false }),
    true,
  );
});

test("reward scan classification distinguishes header-only and verified empty states", () => {
  const headerOnlySection = {
    sectionId: "moreactivities",
    exists: true,
    hydrated: false,
    directRoundedAnchors: 0,
    sectionChrome: 1,
  };
  const hydratedSection = {
    sectionId: "moreactivities",
    exists: true,
    hydrated: true,
    directRoundedAnchors: 4,
    sectionChrome: 1,
  };

  assert.equal(
    classifyRewardScanState({
      cardsCount: 0,
      sections: [headerOnlySection],
      targetSectionIds: ["moreactivities"],
      stableEmpty: false,
    }),
    "header_only",
  );
  assert.equal(
    classifyRewardScanState({
      cardsCount: 0,
      sections: [hydratedSection],
      targetSectionIds: ["moreactivities"],
      stableEmpty: true,
    }),
    "stable_empty",
  );
  assert.equal(
    classifyRewardScanState({
      cardsCount: 0,
      sections: [headerOnlySection],
      targetSectionIds: ["moreactivities"],
      stableEmpty: true,
      previouslyHydrated: true,
    }),
    "stable_empty",
  );
  assert.equal(
    classifyRewardScanState({
      cardsCount: 0,
      sections: [hydratedSection, headerOnlySection],
      targetSectionIds: ["moreactivities"],
      stableEmpty: true,
    }),
    "header_only",
  );
  assert.equal(
    classifyRewardScanState({
      cardsCount: 1,
      sections: [{ ...hydratedSection, sectionId: "earn_fallback" }],
      targetSectionIds: ["moreactivities"],
      stableEmpty: false,
    }),
    "ready_cards",
  );
  assert.equal(
    classifyRewardScanState({
      cardsCount: 0,
      sections: [
        headerOnlySection,
        { ...hydratedSection, sectionId: "earn_fallback" },
      ],
      targetSectionIds: ["moreactivities"],
      stableEmpty: true,
    }),
    "stable_empty",
  );
  assert.equal(getRewardHydrationRetryDelay(1), 5_000);
  assert.equal(getRewardHydrationRetryDelay(4), 60_000);
  assert.equal(getRewardHydrationRetryDelay(9), 60_000);
});

test("quiz completion detection requires a strong completion phrase", () => {
  assert.equal(findQuizCompletionPhrase("Your score may improve if you try again"), "");
  assert.equal(findQuizCompletionPhrase("You got a new search result"), "");
  assert.equal(findQuizCompletionPhrase("Great job! You earned 10 points"), "Great job");
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
