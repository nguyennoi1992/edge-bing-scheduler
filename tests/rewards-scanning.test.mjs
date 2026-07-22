import assert from "node:assert/strict";
import test from "node:test";

import { isDashboardRewardHref } from "../reward-dom-helpers.js";
import "../reward-scanner-helpers.js";

// Mock implementation of DOM elements for testing without a browser
class MockElement {
  constructor(tagName, attributes = {}, classes = [], parent = null) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.classes = classes;
    this.parent = parent;
    this.children = [];
    this.innerText = attributes.innerText || "";
    this.textContent = attributes.innerText || "";
    if (parent) parent.children.push(this);
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  hasAttribute(name) {
    return name in this.attributes;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  matches(selector) {
    const parts = selector.split(",").map(s => s.trim());
    return parts.some(part => {
      // Check for class requirements
      if (part.includes(".rounded-cornerCardDefault")) {
        if (!this.classes.includes("rounded-cornerCardDefault")) return false;
      }
      if (part.includes("[class*='rounded-cornerCardDefault']")) {
        if (!this.classes.some(c => c.includes("rounded-cornerCardDefault"))) return false;
      }
      if (part.includes("[aria-expanded]")) {
        if (!this.hasAttribute("aria-expanded")) return false;
      }
      if (part.includes("[aria-controls]")) {
        if (!this.hasAttribute("aria-controls")) return false;
      }
      if (part.includes("[slot='trigger']")) {
        if (this.getAttribute("slot") !== "trigger") return false;
      }
      if (part.includes("[role='button']")) {
        if (this.getAttribute("role") !== "button") return false;
      }
      if (part.includes("[role='link']")) {
        if (this.getAttribute("role") !== "link") return false;
      }
      if (part.includes("[data-react-aria-pressable='true']")) {
        if (this.getAttribute("data-react-aria-pressable") !== "true") return false;
      }

      // Check tag name
      const tagMatch = part.match(/^[a-z0-9*-]+/i);
      if (tagMatch) {
        const expectedTag = tagMatch[0].toUpperCase();
        if (expectedTag !== "*" && this.tagName !== expectedTag) return false;
      }

      return true;
    });
  }

  querySelectorAll(selector) {
    const results = [];
    const traverse = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) {
          results.push(child);
        }
        traverse(child);
      }
    };
    traverse(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const findRewardCardRoots = globalThis.findRewardCardRoots;

function isHeader(card) {
  return card.hasAttribute("slot") || card.hasAttribute("aria-controls") || card.hasAttribute("aria-expanded") || !!card.closest("h1, h2, h3, h4") || card.matches?.("h1, h2, h3, h4");
}

// Test Cases
test("findRewardCardRoots correctly detects multiple separate cards and ignores headers", () => {
  // Construct mock section
  const section = new MockElement("div", { id: "moreactivities" }, ["moreactivities-grid"]);
  
  // Collapse button/header trigger
  const headerBtn = new MockElement("button", { slot: "trigger", "aria-expanded": "true", innerText: "Keep earning" }, [], section);
  
  // Card 1
  const card1 = new MockElement("div", {}, ["rounded-cornerCardDefault"], section);
  const card1Title = new MockElement("h3", { innerText: "Quote of the day" }, [], card1);
  const card1Link = new MockElement("a", { href: "/search?q=Quote+of+the+day" }, [], card1);

  // Card 2
  const card2 = new MockElement("div", {}, ["rounded-cornerCardDefault"], section);
  const card2Title = new MockElement("h3", { innerText: "Rugby rules decoded" }, [], card2);
  const card2Link = new MockElement("a", { href: "/search?q=Rugby" }, [], card2);

  // Run card root discovery
  const roots = findRewardCardRoots(section);
  
  // Assertions
  assert.equal(roots.length, 3); // headerBtn, card1, card2
  assert.ok(roots.includes(headerBtn));
  assert.ok(roots.includes(card1));
  assert.ok(roots.includes(card2));
});

test("isHeader correctly identifies section headers and accepts cards with headings", () => {
  const headerNode = new MockElement("button", { "aria-expanded": "true", innerText: "Keep earning" });
  assert.equal(isHeader(headerNode), true, "header button should be recognized as header");

  const h3Node = new MockElement("h3", { innerText: "Quote of the day" });
  assert.equal(isHeader(h3Node), true, "h3 node should be recognized as header");

  const cardNode = new MockElement("div", {}, ["rounded-cornerCardDefault"]);
  const heading = new MockElement("h3", { innerText: "Quote of the day" }, [], cardNode);
  assert.equal(isHeader(cardNode), false, "card container should NOT be recognized as header");
});

test("isDashboardRewardHref correctly filters URLs", () => {
  assert.equal(isDashboardRewardHref("https://www.bing.com/search?q=Trip"), true);
  assert.equal(isDashboardRewardHref("https://cn.bing.com/search?q=Trip"), true);
  assert.equal(isDashboardRewardHref("/search?q=Trip"), true);
  assert.equal(isDashboardRewardHref("https://rewards.bing.com/redeem"), false);
  assert.equal(isDashboardRewardHref("https://rewards.bing.com/earn"), false);
});
