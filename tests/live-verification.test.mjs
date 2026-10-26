import assert from "node:assert/strict";
import test from "node:test";
import { CLAIM_MATCH_RE, READY_TO_CLAIM_LABEL_RE } from "../reward-dom-helpers.js";
import { assessProfile, readDashboard, readFlyout } from "./verify-dual-profile-live.mjs";

const valid = () => ({
  reload: { verified: true, sourceVerified: true },
  flyout: { authenticated: true, todayPresent: true, cards: [
    { name: "today-1", complete: true }, { name: "today-2", complete: true },
  ] },
  dashboard: { native: true, cardCount: 2, helpersCurrent: true },
});

test("live verification requires authenticated, current, nonempty, valid evidence", () => {
  assert.deepEqual(assessProfile(valid()), { status: "complete", completed: 2, total: 2 });
  for (const mutate of [
    x => { x.reload.verified = false; }, x => { x.reload.sourceVerified = false; },
    x => { x.flyout.authenticated = false; }, x => { x.flyout.todayPresent = false; },
    x => { x.flyout.cards = []; }, x => { x.flyout.cards[0].complete = "false"; },
    x => { x.flyout.cards[1].name = x.flyout.cards[0].name; },
    x => { x.dashboard.helpersCurrent = false; },
    x => { x.dashboard.native = false; x.dashboard.restored = false; },
    x => { x.dashboard.cardCount = 0; },
    x => { x.dashboard.cardCount = 1; }, // Missing card (1 < 2)
    x => { x.dashboard.cardCount = 3; }, // Extra card/controls (3 > 2, cardinality mismatch)
  ]) {
    const snapshot = valid();
    mutate(snapshot);
    assert.equal(assessProfile(snapshot).status, "unavailable");
  }
});

test("live verification reports real completion counts and accepts either dashboard rendering", () => {
  const snapshot = valid();
  snapshot.flyout.cards[0].complete = false;
  assert.deepEqual(assessProfile(snapshot), { status: "incomplete", completed: 1, total: 2 });
  snapshot.dashboard.native = false;
  snapshot.dashboard.restored = true;
  assert.equal(assessProfile(snapshot).status, "incomplete");
});

test("readDashboard filters out section chrome, headers, and info controls while preserving pressables and links", () => {
  const headerControl = {
    matches: sel => sel.includes("h1") || sel.includes("trigger"),
    closest: () => null,
    getAttribute: () => null,
    innerText: "Daily set",
  };
  const infoControl = {
    matches: () => false,
    closest: () => null,
    getAttribute: attr => attr === "aria-label" ? "About Daily set" : null,
    innerText: "",
  };
  const card1 = {
    matches: sel => sel.includes("button") || sel.includes("data-react-aria-pressable"),
    closest: () => null,
    getAttribute: () => null,
    innerText: "Daily poll 10 points",
  };
  const card2 = {
    matches: sel => sel.includes("button"),
    closest: () => null,
    getAttribute: () => null,
    innerText: "Daily quiz 10 points",
  };
  const card3 = {
    matches: () => false,
    closest: () => null,
    getAttribute: attr => attr === "href" ? "https://www.bing.com/search?q=test" : null,
    querySelector: sel => sel === "a[href]" ? { getAttribute: () => "https://www.bing.com/search?q=test" } : null,
    innerText: "Search activity 10 points",
  };

  const section = {
    querySelectorAll: sel => sel === "a[href]" ? [{}, {}, {}, {}] : [],
  };

  const hadDoc = Object.hasOwn(globalThis, "document");
  const prevDocDesc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const hadWin = Object.hasOwn(globalThis, "window");
  const prevWinDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    globalThis.document = {
      getElementById: id => id === "dailyset" ? section : null,
      querySelectorAll: () => [],
    };
    globalThis.window = {
      __rewardDomHelpersInjected: true,
      READY_TO_CLAIM_LABEL_RE: /ready/i,
      CLAIM_MATCH_RE: /claim/i,
      isRewardSectionChrome: (el, root) => el === headerControl,
      findRewardCardRoots: root => root === section ? [headerControl, infoControl, card1, card2, card3] : [],
    };

    // raw findRewardCardRoots has 5 elements, but readDashboard must filter to exactly the 3 activity cards!
    const resWithRoots = readDashboard("ready", "claim");
    assert.equal(resWithRoots.native, true);
    assert.equal(resWithRoots.cardCount, 3);
    assert.equal(resWithRoots.helpersCurrent, true);

    // When findRewardCardRoots is absent, fallback to querySelectorAll filtering
    delete globalThis.window.findRewardCardRoots;
    section.querySelectorAll = () => [headerControl, infoControl, card1, card2, card3];
    const resFallback = readDashboard("ready", "claim");
    assert.equal(resFallback.cardCount, 3);
  } finally {
    if (hadDoc) Object.defineProperty(globalThis, "document", prevDocDesc);
    else delete globalThis.document;
    if (hadWin) Object.defineProperty(globalThis, "window", prevWinDesc);
    else delete globalThis.window;
  }
});

test("readFlyout fail-closed: midnight boundary does not count yesterday or future completions for requested day", () => {
  const hadDoc = Object.hasOwn(globalThis, "document");
  const prevDocDesc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const hadWin = Object.hasOwn(globalThis, "window");
  const prevWinDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
  const midnight = new Date(2026, 9, 26, 0, 0, 0);

  const yesterdayKey = "10/25/2026";
  const todayKey = "10/26/2026";
  const futureKey = "10/27/2026";

  const promotions = {
    [yesterdayKey]: [{ name: "yesterday-card", complete: true, pointProgress: 10, pointProgressMax: 10 }],
    [futureKey]: [{ name: "future-card", complete: true, pointProgress: 10, pointProgressMax: 10 }],
  };

  try {
    globalThis.window = {
      flyoutViewModel: {
        userId: "test-user",
        flyoutResult: {
          dailySetPromotions: promotions,
          userStatus: { availablePoints: 2500 },
        },
      },
    };

    // When requested day is missing, yesterday/future completions must not count; status stays unavailable
    const flyoutMissing = readFlyout(midnight);
    assert.equal(flyoutMissing.todayPresent, false);
    assert.deepEqual(flyoutMissing.cards, []);
    assert.equal(flyoutMissing.requestedDay, todayKey);
    assert.deepEqual(flyoutMissing.availableDateKeys, [yesterdayKey, futureKey]);
    assert.equal(assessProfile({
      reload: { verified: true, sourceVerified: true },
      flyout: flyoutMissing,
      dashboard: { native: true, cardCount: 0, helpersCurrent: true },
    }).status, "unavailable");

    // When requested day is present, actual today is picked correctly
    promotions[todayKey] = [
      { name: "today-card-1", complete: true, pointProgress: 10, pointProgressMax: 10 },
      { name: "today-card-2", complete: false, pointProgress: 0, pointProgressMax: 10 },
    ];
    const flyoutPresent = readFlyout(midnight);
    assert.equal(flyoutPresent.todayPresent, true);
    assert.equal(flyoutPresent.cards.length, 2);
    assert.equal(flyoutPresent.cards[0].name, "today-card-1");
    assert.equal(flyoutPresent.cards[1].name, "today-card-2");
    assert.deepEqual(assessProfile({
      reload: { verified: true, sourceVerified: true },
      flyout: flyoutPresent,
      dashboard: { native: true, cardCount: 2, helpersCurrent: true },
    }), { status: "incomplete", completed: 1, total: 2 });
  } finally {
    if (hadDoc) Object.defineProperty(globalThis, "document", prevDocDesc);
    else delete globalThis.document;
    if (hadWin) Object.defineProperty(globalThis, "window", prevWinDesc);
    else delete globalThis.window;
  }
});

test("readDashboard readyCards diagnostic compiles canonical READY_TO_CLAIM_LABEL_RE once and matches normalized non-English and whitespace labels", () => {
  const hadDoc = Object.hasOwn(globalThis, "document");
  const prevDocDesc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const hadWin = Object.hasOwn(globalThis, "window");
  const prevWinDesc = Object.getOwnPropertyDescriptor(globalThis, "window");

  const buttons = [
    { innerText: "  \n  ready to   claim \n " },
    { innerText: " \t 可领取 +10 pts \n " },
    { innerText: "  \n  sẵn   sàng   nhận  \t  10   points  \n " },
    { innerText: "  bereit zum einlösen  " },
    { innerText: "  готово к получению  " },
    { innerText: "  Already claimed  " },
    { innerText: "  Explore now  " },
  ];

  try {
    globalThis.document = {
      getElementById: () => null,
      querySelectorAll: sel => sel.includes("button") ? buttons : [],
    };
    globalThis.window = {
      __rewardDomHelpersInjected: true,
      READY_TO_CLAIM_LABEL_RE,
      CLAIM_MATCH_RE,
    };

    const res = readDashboard(READY_TO_CLAIM_LABEL_RE.source, CLAIM_MATCH_RE.source);
    assert.equal(res.helpersCurrent, true);
    assert.deepEqual(res.readyCards, [
      "ready to claim",
      "可领取 +10 pts",
      "sẵn sàng nhận 10 points",
      "bereit zum einlösen",
      "готово к получению",
    ]);
  } finally {
    if (hadDoc) Object.defineProperty(globalThis, "document", prevDocDesc);
    else delete globalThis.document;
    if (hadWin) Object.defineProperty(globalThis, "window", prevWinDesc);
    else delete globalThis.window;
  }
});
