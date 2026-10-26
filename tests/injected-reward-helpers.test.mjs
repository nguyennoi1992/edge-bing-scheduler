import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { CLAIM_MATCH_RE, EMPTY_REWARD_STABLE_MS, READY_TO_CLAIM_LABEL_RE, parsePointsFromText } from "../reward-dom-helpers.js";
import { getFirstScriptResult } from "../script-result-helpers.js";

const source = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");

function extractFunction(src, startPattern, endPattern) {
  const start = src.search(startPattern);
  const end = src.search(endPattern);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Failed to extract function slice between ${startPattern} and ${endPattern}`);
  }
  return src.slice(start, end);
}

const injectionSource = extractFunction(source, /(?:^|\n)\s*async function injectDomHelpers\(/, /(?:^|\n)\s*async function fetchAndRestoreDailySet\(/);
const claimSource = extractFunction(source, /(?:^|\n)\s*async function claimReadyPoints\(/, /(?:^|\n)\s*async function closeChildTabs\(/);

function createInjection(page) {
  return vm.runInNewContext(`${injectionSource}; injectDomHelpers`, {
    EMPTY_REWARD_STABLE_MS, READY_TO_CLAIM_LABEL_RE, CLAIM_MATCH_RE,
    executeRewardsScript: async (_tabId, options) => {
      if (options.func) {
        page.args = options.args;
        vm.runInContext(`(${options.func})(...args)`, page);
      }
    },
  });
}

test("the actual MAIN-world injection uses current shared claim expressions and replaces stale helpers", async () => {
  const page = vm.createContext({ window: {}, console });
  const inject = createInjection(page);
  await inject(1);
  assert.equal(page.window.READY_TO_CLAIM_LABEL_RE.test("Ready to claim 6 Claim"), true);
  assert.equal(page.window.CLAIM_MATCH_RE.source, CLAIM_MATCH_RE.source);
  assert.equal(page.window.READY_TO_CLAIM_LABEL_RE.source, READY_TO_CLAIM_LABEL_RE.source);
  page.window.findRewardCardRoots = () => [];
  page.window.expandRewardSection = () => {};
  page.window.isRewardSectionChrome = () => false;
  vm.runInContext("window.READY_TO_CLAIM_LABEL_RE = /old/; delete window.CLAIM_MATCH_RE", page);
  await inject(1);
  assert.equal(page.window.READY_TO_CLAIM_LABEL_RE.test("Ready to claim 6 Claim"), true);
  assert.equal(page.window.CLAIM_MATCH_RE.source, CLAIM_MATCH_RE.source);
});

test("the actual claim flow does not click or invent one point for a zero-point card", async () => {
  let clicks = 0;
  class Button {
    nodeType = 1;
    children = [];
    innerText = "Ready to claim 0 Claim";
    getBoundingClientRect() { return { width: 100, height: 30, left: 0, top: 0 }; }
    getAttribute() { return null; }
    closest() { return this; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    matches() { return true; }
    click() { clicks++; }
    dispatchEvent() { clicks++; }
  }
  const button = new Button();
  const page = vm.createContext({
    window: { READY_TO_CLAIM_LABEL_RE, parsePointsFromText, findRewardCardRoots: (root) => [root], getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    document: { children: [button], querySelectorAll: () => [button] },
    HTMLElement: Button, Node: { ELEMENT_NODE: 1 }, MouseEvent: class {},
    console, setTimeout: callback => callback(),
  });
  const claim = vm.runInNewContext(`${claimSource}; claimReadyPoints`, {
    injectDomHelpers: async () => {}, getFirstScriptResult, console,
    isProtectedPageScriptError: () => false,
    executeRewardsScript: async (_tabId, options) => [{ result: await vm.runInContext(`(${options.func})()`, page) }],
  });
  const result = await claim(1);
  assert.equal(result.clicked, false);
  assert.equal(result.claimedPoints, 0);
  assert.equal(clicks, 0);
});

test("the actual claim flow falls back to parent card points when direct button has no number, preserves explicit zero, and stays fail-closed if unknown", async () => {
  class MockElement {
    nodeType = 1;
    tagName = "DIV";
    children = [];
    parentElement = null;
    constructor(innerText = "", className = "", tagName = "DIV") {
      this.innerText = innerText;
      this.className = className;
      this.tagName = tagName;
    }
    getBoundingClientRect() { return { width: 100, height: 30, left: 0, top: 0 }; }
    getAttribute(attr) {
      if (attr === "data-react-aria-pressable" && (this.className.includes("pressable") || this.isPressable)) return "true";
      return null;
    }
    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    matches(selector) {
      if (selector.includes("section") && (this.className.includes("section") || this.tagName === "SECTION")) return true;
      if (selector.includes("pressable") && (this.className.includes("pressable") || this.isPressable)) return true;
      if (selector.includes("card") && this.className.includes("card")) return true;
      if (selector.includes("button") && (this.className.includes("button") || this.tagName === "BUTTON")) return true;
      return false;
    }
    contains(el) { return this === el || this.children.includes(el); }
    querySelector(selector) {
      for (const child of this.children) {
        if (child.matches(selector)) return child;
        const sub = child.querySelector(selector);
        if (sub) return sub;
      }
      return null;
    }
    querySelectorAll() { return []; }
    click() {
      this.clicks = (this.clicks || 0) + 1;
      if (this.onClick) this.onClick();
    }
    dispatchEvent() {
      this.clicks = (this.clicks || 0) + 1;
      if (this.onClick) this.onClick();
    }
  }

  function runClaimOnPage({ buttons = [], rootElements = [], cardRootsFn }) {
    const page = vm.createContext({
      window: {
        READY_TO_CLAIM_LABEL_RE,
        parsePointsFromText,
        findRewardCardRoots: cardRootsFn || ((root) => [root]),
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      },
      document: {
        children: rootElements,
        querySelectorAll: (sel) => {
          if (sel.includes("button")) return buttons;
          return [];
        },
      },
      HTMLElement: MockElement, Node: { ELEMENT_NODE: 1 }, MouseEvent: class {},
      console, setTimeout: callback => callback(),
    });
    const claim = vm.runInNewContext(`${claimSource}; claimReadyPoints`, {
      injectDomHelpers: async () => {}, getFirstScriptResult, console,
      isProtectedPageScriptError: () => false,
      executeRewardsScript: async (_tabId, options) => [{ result: await vm.runInContext(`(${options.func})()`, page) }],
    });
    return claim(1);
  }

  function runClaimOnElements(button, parent, cardRoots) {
    button.parentElement = parent;
    parent.children = [button];
    return runClaimOnPage({
      buttons: [button],
      rootElements: [parent],
      cardRootsFn: (root) => cardRoots ?? root?.cardRoots ?? [root],
    });
  }

  // 1. Explicit zero in button text stays 0 despite positive parent text, no click
  const zeroBtn = new MockElement("Ready to claim 0 Claim", "button", "BUTTON");
  const posParent1 = new MockElement("Daily search +10 points Ready to claim 0 Claim", "card");
  const zeroRes = await runClaimOnElements(zeroBtn, posParent1);
  assert.equal(zeroRes.clicked, false);
  assert.equal(zeroRes.claimedPoints, 0);
  assert.equal(zeroBtn.clicks || 0, 0);
  assert.equal(posParent1.clicks || 0, 0);

  // Regression: zero + compact label with positive parent stays 0, no click
  const zeroCompactBtn = new MockElement("Ready to claim 0points Claim", "button", "BUTTON");
  const posParentCompact = new MockElement("Daily search +10 points Ready to claim 0points Claim", "card");
  const zeroCompactRes = await runClaimOnElements(zeroCompactBtn, posParentCompact);
  assert.equal(zeroCompactRes.clicked, false);
  assert.equal(zeroCompactRes.claimedPoints, 0);
  assert.equal(zeroCompactBtn.clicks || 0, 0);
  assert.equal(posParentCompact.clicks || 0, 0);

  // 2. Direct button has no number; genuine parent positive points parsed and claimed
  const noNumBtn = new MockElement("Ready to claim Claim", "button", "BUTTON");
  const posParent2 = new MockElement("Daily search +15 points Ready to claim Claim", "card");
  noNumBtn.onClick = () => {
    noNumBtn.innerText = "Ready to claim 0 Claim";
    posParent2.innerText = "Daily search 0 points Ready to claim 0 Claim";
  };
  const posRes = await runClaimOnElements(noNumBtn, posParent2);
  assert.equal(posRes.clicked, true);
  assert.equal(posRes.claimedPoints, 15);
  assert.equal(noNumBtn.clicks > 0, true);

  // Regression: multi-root parent positive fails closed without guessing (0 points, no click)
  const multiBtn = new MockElement("Ready to claim Claim", "button", "BUTTON");
  const multiParent = new MockElement("Daily activities +15 points Ready to claim Claim", "card");
  const multiRes = await runClaimOnElements(multiBtn, multiParent, [
    new MockElement("Card 1", "card"),
    new MockElement("Card 2", "card"),
  ]);
  assert.equal(multiRes.clicked, false);
  assert.equal(multiRes.claimedPoints, 0);
  assert.equal(multiBtn.clicks || 0, 0);
  assert.equal(multiParent.clicks || 0, 0);

  // 3. Direct button has no number, parent has no number: stays fail-closed without guessing
  const unkBtn = new MockElement("Ready to claim Claim", "button", "BUTTON");
  const unkParent = new MockElement("Daily activity Ready to claim Claim", "card");
  const unkRes = await runClaimOnElements(unkBtn, unkParent);
  assert.equal(unkRes.clicked, false);
  assert.equal(unkRes.claimedPoints, 0);
  assert.equal(unkBtn.clicks || 0, 0);
  assert.equal(unkParent.clicks || 0, 0);

  // 4. Own-positive button clicks only button, does NOT click parent container
  const ownPosBtn = new MockElement("Ready to claim 20 Claim", "button", "BUTTON");
  const ownPosParent = new MockElement("Daily search +20 points Ready to claim 20 Claim", "card");
  ownPosBtn.onClick = () => {
    ownPosBtn.innerText = "Ready to claim 0 Claim";
  };
  const ownPosRes = await runClaimOnElements(ownPosBtn, ownPosParent);
  assert.equal(ownPosRes.clicked, true);
  assert.equal(ownPosRes.claimedPoints, 20);
  assert.equal(ownPosBtn.clicks > 0, true);
  assert.equal(ownPosParent.clicks || 0, 0);

  // 5. Regression: first 0 then valid positive => zero never clicked, later claimed
  const zeroBtn2 = new MockElement("Ready to claim 0 Claim", "button", "BUTTON");
  const posBtn2 = new MockElement("Ready to claim 15 Claim", "button", "BUTTON");
  posBtn2.onClick = () => {
    posBtn2.innerText = "Ready to claim 0 Claim";
  };
  const firstZeroRes = await runClaimOnPage({
    buttons: [zeroBtn2, posBtn2],
    rootElements: [zeroBtn2, posBtn2],
  });
  assert.equal(firstZeroRes.clicked, true);
  assert.equal(firstZeroRes.claimedPoints, 15);
  assert.equal(zeroBtn2.clicks || 0, 0);
  assert.equal(posBtn2.clicks > 0, true);

  // 6. Regression: broad section with unrelated points never clicks (candidate fallback)
  const broadSection = new MockElement("Daily activities +50 points", "section", "SECTION");
  const unkSpan = new MockElement("Ready to claim", "", "SPAN");
  const secBtn = new MockElement("Claim", "button", "BUTTON");
  unkSpan.parentElement = broadSection;
  secBtn.parentElement = broadSection;
  broadSection.children = [unkSpan, secBtn];
  const broadRes = await runClaimOnPage({
    buttons: [],
    rootElements: [broadSection],
    cardRootsFn: (root) => (root === broadSection ? [secBtn, secBtn] : []),
  });
  assert.equal(broadRes.clicked, false);
  assert.equal(broadRes.claimedPoints, 0);
  assert.equal(secBtn.clicks || 0, 0);

  // 7. Regression: valid single-button fallback still works when root self yields 0 descendants
  const fallbackBtn = new MockElement("Ready to claim 12 Claim", "button", "BUTTON");
  fallbackBtn.onClick = () => {
    fallbackBtn.innerText = "Ready to claim 0 Claim";
  };
  const fallbackRes = await runClaimOnPage({
    buttons: [],
    rootElements: [fallbackBtn],
    cardRootsFn: () => [],
  });
  assert.equal(fallbackRes.clicked, true);
  assert.equal(fallbackRes.claimedPoints, 12);
  assert.equal(fallbackBtn.clicks > 0, true);
});
