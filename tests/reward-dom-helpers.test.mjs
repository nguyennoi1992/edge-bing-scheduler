import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_REWARD_STABLE_MS,
  READY_TO_CLAIM_LABEL_RE,
  classifyRewardScanState,
  findQuizCompletionPhrase,
  getRewardHydrationRetryDelay,
  isActionableQuestActivity,
  isActionableRewardCard,
  isCompletedQuestText,
  isDashboardRewardHref,
  isRewardsPageUrl,
  parsePointsFromText,
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
  assert.equal(
    classifyRewardScanState({
      cardsCount: 0,
      sections: [{
        sectionId: "moreactivities",
        exists: true,
        hydrated: false,
        directRoundedAnchors: 0,
        completed: 1,
        sectionChrome: 1,
      }],
      targetSectionIds: ["moreactivities"],
      stableEmpty: false,
    }),
    "partial",
  );
  assert.equal(
    classifyRewardScanState({
      cardsCount: 0,
      sections: [{
        sectionId: "moreactivities",
        exists: true,
        hydrated: true,
        directRoundedAnchors: 0,
        completed: 1,
        sectionChrome: 1,
      }],
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

test("isRewardsPageUrl accepts valid rewards pages and rejects external/login pages", () => {
  const validUrls = [
    "https://rewards.bing.com/earn",
    "https://rewards.bing.com/earn/",
    "https://rewards.bing.com/dashboard",
    "https://rewards.bing.com/dashboard?form=dsetqu",
    "https://rewards.bing.com/",
    "https://rewards.bing.com",
    "https://rewards.bing.com/status",
  ];

  for (const url of validUrls) {
    assert.equal(isRewardsPageUrl(url), true, `Expected valid: ${url}`);
  }

  const invalidUrls = [
    "https://login.live.com/oauth20_authorize.srf?client_id=123",
    "https://account.microsoft.com/",
    "https://www.bing.com/",
    "https://www.bing.com/search?q=test",
    "http://rewards.bing.com/dashboard",
    "edge://extensions",
    "chrome-extension://nfhfoeifnelcgcalhnbidjdmgohcfbon/popup.html",
    "",
    null,
    undefined,
    "not-a-valid-url",
  ];

  for (const url of invalidUrls) {
    assert.equal(isRewardsPageUrl(url), false, `Expected invalid: ${url}`);
  }
});

test("isCompletedQuestText detects completed and ratio-based quests", () => {
  assert.equal(isCompletedQuestText("quests 50/50"), true);
  assert.equal(isCompletedQuestText("5/5 tasks"), true);
  assert.equal(isCompletedQuestText("1/1"), true);
  assert.equal(isCompletedQuestText("Completed"), true);
  assert.equal(isCompletedQuestText("hoàn thành"), true);
  assert.equal(isCompletedQuestText("0/3 tasks"), false);
  assert.equal(isCompletedQuestText("1/5 tasks"), false);
  assert.equal(isCompletedQuestText("quests 0/1 tasks expires in 5 days"), false);
  // Guard against dates where segment 1 >= segment 2
  assert.equal(isCompletedQuestText("Expires 12/5/2026 - 0/1 tasks"), false);
  assert.equal(isCompletedQuestText("Event date 10/10/2026"), false);
  assert.equal(isCompletedQuestText("2026/4/1"), false);
  // Mixed points progress vs task progress
  assert.equal(isCompletedQuestText("100/100 points - 0/1 tasks"), false);
  assert.equal(isCompletedQuestText("50/50 points - 2/2 tasks"), true);
  assert.equal(isCompletedQuestText("Completed 0/3 tasks"), false);
  assert.equal(isCompletedQuestText("Completed 0/50 points"), false);
  assert.equal(isCompletedQuestText("Completed quests 0/2"), false);
  assert.equal(isCompletedQuestText("50/50 points quests 0/1"), false);
  assert.equal(isCompletedQuestText("Quests 0/1 completed"), false);
  assert.equal(isCompletedQuestText("Quests 1/1 completed"), true);
  assert.equal(isCompletedQuestText("Completed 50/50 points"), true);
  assert.equal(isCompletedQuestText("Hoàn thành 0/1 nhiệm vụ"), false);
  assert.equal(isCompletedQuestText("Terminé 0/2 activités"), false);
  assert.equal(isCompletedQuestText("Terminé 2/2 activités"), true);
  assert.equal(isCompletedQuestText("Completed 0/2"), false);
  assert.equal(isCompletedQuestText("0/2 completed"), false);
  assert.equal(isCompletedQuestText("Completed 2/2"), true);
  assert.equal(isCompletedQuestText("已完成 0/1"), false);
  assert.equal(isCompletedQuestText("已完成 1/1"), true);
  assert.equal(isCompletedQuestText("завершено 0/1"), false);
  assert.equal(isCompletedQuestText("завершено 1/1"), true);
  // Multi-task ratio tests
  assert.equal(isCompletedQuestText("1/1 tasks - 2/2 tasks"), true);
  assert.equal(isCompletedQuestText("1/1 tasks - 0/2 tasks"), false);
  assert.equal(isCompletedQuestText("Quests 1/1 - Quests 2/2"), true);
  assert.equal(isCompletedQuestText("Quests 1/1 - Quests 0/2"), false);
  // Fractions without task/points keywords (e.g. 24/7 or Ends 10/5)
  assert.equal(isCompletedQuestText("Available 24/7"), false);
  assert.equal(isCompletedQuestText("Ends 10/5"), false);
  assert.equal(isCompletedQuestText(""), false);
  assert.equal(isCompletedQuestText(null), false);
});

test("READY_TO_CLAIM_LABEL_RE and parsePointsFromText correctly detect and extract ready points", () => {
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("ready to claim"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim +6 points"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim!"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim! +6 points"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim+6"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim: 6"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim+50 points"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim +1,000 points"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim 1.000 pts"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Sẵn sàng nhận"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("  Ready to claim  "), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("\nReady to claim +6 points\t"), true);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Claim points"), false);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Earn more"), false);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim +50 points when you complete 3 searches"), false);
  assert.equal(READY_TO_CLAIM_LABEL_RE.test("Ready to claim after completing your set"), false);

  assert.equal(parsePointsFromText("Ready to claim +6 points"), 6);
  assert.equal(parsePointsFromText("Claim 1,000 points"), 1000);
  assert.equal(parsePointsFromText("First search of the day - September 2026 +6 points"), 6);
  assert.equal(parsePointsFromText("Expires in 24 hours +10 pts"), 10);
  assert.equal(parsePointsFromText("Ready to claim 6 Claim"), 6);
  assert.equal(parsePointsFromText("Ready to claim +6 Claim"), 6);
  assert.equal(parsePointsFromText("Ready to claim: +50"), 50);
  assert.equal(parsePointsFromText("Ready to claim+6"), 6);
  assert.equal(parsePointsFromText("Ready to claim! 6"), 6);
  assert.equal(parsePointsFromText("Claim: 100"), 100);
  assert.equal(parsePointsFromText("Expires in 24 hours"), 0);
  assert.equal(parsePointsFromText("September 2026"), 0);
  assert.equal(parsePointsFromText("10 claimed"), 0);
  assert.equal(parsePointsFromText("Claim - 5 days left"), 0);
  assert.equal(parsePointsFromText("Ready to claim: 24 hours left"), 0);
  assert.equal(parsePointsFromText("Ready to claim: 24 giờ nữa"), 0);
  assert.equal(parsePointsFromText("Claim 1 of 3"), 0);
  assert.equal(parsePointsFromText("Claim 1/3"), 0);
  assert.equal(parsePointsFromText("+1 day streak"), 0);
  assert.equal(parsePointsFromText("+10 days"), 0);
  assert.equal(parsePointsFromText("+50 days"), 0);
  assert.equal(parsePointsFromText("+30 hours"), 0);
  assert.equal(parsePointsFromText("+1 friend"), 0);
  assert.equal(parsePointsFromText("6"), 6);
  assert.equal(parsePointsFromText(6), 6);
  assert.equal(parsePointsFromText(null), 0);
  assert.equal(parsePointsFromText(undefined), 0);
  assert.equal(parsePointsFromText({}), 0);
  assert.equal(parsePointsFromText("No points here"), 0);
});

test("isActionableQuestActivity filters info headers, streak indicators without href, and completed activities", () => {
  const base = {
    innerLabel: "Search on Bing",
    ariaLabel: "",
    isVisible: true,
    isDisabled: false,
    isInNav: false,
    isQuestCard: false,
    isCompleted: false,
    href: "https://www.bing.com/search?q=test",
  };

  assert.equal(isActionableQuestActivity(base), true);

  // Filter completed activities or text
  assert.equal(isActionableQuestActivity({ ...base, isCompleted: true }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Done 1/1" }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Completed" }), false);
  assert.equal(isActionableQuestActivity({ ...base, ariaLabel: "Search on Bing", innerLabel: "1/1" }), false);
  assert.equal(isActionableQuestActivity({ ...base, ariaLabel: "3/3", innerLabel: "Daily search" }), false);
  assert.equal(isActionableQuestActivity({ ...base, ariaLabel: "Search on Bing", innerLabel: "0/1" }), true);

  // Points complete but task incomplete: must remain actionable!
  assert.equal(isActionableQuestActivity({ ...base, ariaLabel: "50/50 points", innerLabel: "0/1 tasks" }), true);
  assert.equal(isActionableQuestActivity({ ...base, ariaLabel: "50/50 points", innerLabel: "1/1 tasks" }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Completed 0/3 tasks", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Completed 0/1 tasks" }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Quests 0/1", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "0/50 points", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, ariaLabel: "Search on Bing", innerLabel: "0/1", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, ariaLabel: "0/1", innerLabel: "1/1", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "0/1 nhiệm vụ", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "1/1 nhiệm vụ", isCompleted: true }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "hoạt động 0/2", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "0/3 activités", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Completed 0/2", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "0/2 completed", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Completed (0/1)", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Completed - 0/1", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "(0/2) completed", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "[0/2] completed", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Completed (1/1)", isCompleted: true }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Completed 2/2", isCompleted: true }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "已完成 0/1", isCompleted: true }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "已完成 1/1", isCompleted: true }), false);
  // Explicit DOM success badge always marks completed regardless of text
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Completed 0/3 tasks", hasSuccessBadge: true }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Quests 0/1", hasSuccessBadge: true }), false);
  assert.equal(isActionableQuestActivity({ ...base, ariaLabel: "Search on Bing", innerLabel: "0/1", hasSuccessBadge: true }), false);
  // Non-pressable metadata element without href is not actionable even with incomplete ratio or text
  assert.equal(isActionableQuestActivity({ ...base, href: "", isPressable: false, innerLabel: "0/1 tasks" }), false);
  assert.equal(isActionableQuestActivity({ ...base, href: "", isPressable: false, innerLabel: "Regular static activity text" }), false);
  assert.equal(isActionableQuestActivity({ ...base, href: "", isPressable: true, innerLabel: "Clickable button activity" }), true);

  // Filter info headers (about / level up)
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "About this quest" }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "About" }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "About this quest", ariaLabel: "About this quest" }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Về nhiệm vụ" }), false);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Level up activities" }), false);

  // Accept genuine activities starting with About or Về
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "About Earth Day" }), true);
  assert.equal(isActionableQuestActivity({ ...base, innerLabel: "Về bảo vệ môi trường" }), true);

  // Filter streak indicators without href (even if element is pressable)
  assert.equal(
    isActionableQuestActivity({
      ...base,
      href: "",
      isPressable: true,
      innerLabel: "Complete the Daily Set for 7 days in a row In progress",
    }),
    false,
  );
  assert.equal(
    isActionableQuestActivity({
      ...base,
      href: "",
      isPressable: true,
      innerLabel: "Daily streak 3 days in a row",
    }),
    false,
  );
  // Keep streak activity if it has an actual action href
  assert.equal(
    isActionableQuestActivity({
      ...base,
      href: "https://www.bing.com/search?q=streak",
      innerLabel: "Daily streak 3 days in a row",
    }),
    true,
  );

  // Filter streak indicators with placeholder hrefs (#, javascript:void(0))
  assert.equal(
    isActionableQuestActivity({
      ...base,
      href: "#",
      isPressable: true,
      innerLabel: "Daily streak 3 days in a row",
    }),
    false,
  );
  assert.equal(
    isActionableQuestActivity({
      ...base,
      href: "javascript:void(0)",
      isPressable: true,
      innerLabel: "Daily streak 3 days in a row",
    }),
    false,
  );
});

test("isActionableRewardCard rejects placeholder hrefs when not pressable", () => {
  assert.equal(
    isActionableRewardCard({
      text: "Placeholder card",
      href: "#",
      isPressable: false,
      hasVisual: true,
    }),
    false,
  );
  assert.equal(
    isActionableRewardCard({
      text: "JS void card",
      href: "javascript:void(0)",
      isPressable: false,
      hasVisual: true,
    }),
    false,
  );
  assert.equal(
    isActionableRewardCard({
      text: "Real link card",
      href: "https://www.bing.com/search?q=test",
      isPressable: false,
      hasVisual: true,
    }),
    true,
  );
});
