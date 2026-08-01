import {
  buildRewardCardKey,
  classifyRewardScanState,
  isActionableRewardCard,
  isCompletedText,
  isDashboardRewardHref,
  normalizeRewardText,
} from "../../reward-dom-helpers.js";

function isVisible(element) {
  if (!element || typeof element.getBoundingClientRect !== "function") return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}

function isCardCompleted(card) {
  const successBadge = card.querySelector("[class*='statusSuccess']");
  if (successBadge?.querySelector("svg")) return true;

  for (const element of card.querySelectorAll("[class*='metadata'], [class*='fgCtrlNeutralSecondary']")) {
    if (isCompletedText(element.textContent || "")) return true;
  }
  return isCompletedText(card.innerText || card.textContent || "");
}

function getCardMeta(card, rootNode) {
  const href = card.getAttribute("href") || card.querySelector("a[href]")?.getAttribute("href") || "";
  const text = normalizeRewardText(card.innerText || card.textContent || "");
  return {
    href,
    text,
    hasVisual: !!card.querySelector("img, mee-icon, svg, .mee-icon, [class*='icon'], [class*='Icon'], picture"),
    isDisabled:
      card.getAttribute("aria-disabled") === "true" ||
      !!card.closest("[aria-disabled='true'], [data-disabled='true']"),
    isCompleted: isCardCompleted(card),
    isVisible: isVisible(card),
    isInNav: !!card.closest("nav, header, footer, [role='banner']"),
    isQuestCard: !!card.closest("#quests"),
    isSectionChrome: globalThis.isRewardSectionChrome(card, rootNode),
    isHeader:
      card.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") ||
      !!card.closest("h1, h2, h3, h4"),
    isPressable:
      card.matches?.("button, [role='button'], [role='link'], [data-react-aria-pressable='true']") ||
      !!card.querySelector("[data-react-aria-pressable='true'], button, [role='button'], [role='link']"),
  };
}

export function collectActionableRewardCards(rootNode) {
  const roots = globalThis.findRewardCardRoots(rootNode);
  const cards = [];
  const seen = new Set();

  for (const card of roots) {
    const meta = getCardMeta(card, rootNode);
    if (!isActionableRewardCard(meta)) continue;
    const key = buildRewardCardKey(meta);
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(card);
  }

  return { roots, cards };
}

export function collectDashboardFallbackCards(rootNode = document) {
  const candidates = [
    ...rootNode.querySelectorAll("a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']"),
    ...rootNode.querySelectorAll("a[href][data-react-aria-pressable='true']"),
  ];
  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates.filter((anchor) => {
    const href = anchor.href || anchor.getAttribute("href") || "";
    return isDashboardRewardHref(href) && isActionableRewardCard(getCardMeta(anchor, rootNode));
  });
}

export function getRewardSectionTestState(rootNode) {
  const { cards } = collectActionableRewardCards(rootNode);
  const directRoundedAnchors = rootNode.querySelectorAll(
    "a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']",
  ).length;
  const roots = globalThis.findRewardCardRoots(rootNode);
  const sectionChrome = roots.filter((root) => globalThis.isRewardSectionChrome(root, rootNode)).length;
  const hydrated = directRoundedAnchors > 0 || cards.length > 0;
  const sections = [{
    sectionId: rootNode.id || "moreactivities",
    exists: true,
    hydrated,
    directRoundedAnchors,
    sectionChrome,
  }];
  return {
    cards,
    status: classifyRewardScanState({
      cardsCount: cards.length,
      sections,
      targetSectionIds: [rootNode.id || "moreactivities"],
      stableEmpty: cards.length === 0 && hydrated,
    }),
  };
}

export async function waitForRewardHydration(rootNode, { timeoutMs = 1_000, pollMs = 25 } = {}) {
  const deadlineAt = Date.now() + timeoutMs;
  let snapshot = getRewardSectionTestState(rootNode);
  while (Date.now() < deadlineAt) {
    if (snapshot.status === "ready_cards" || snapshot.status === "stable_empty") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    snapshot = getRewardSectionTestState(rootNode);
  }
  return { ...snapshot, outcome: "incomplete" };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

export async function finishBrowserTest(name, callback) {
  const result = document.getElementById("result");
  try {
    await callback();
    result.dataset.status = "pass";
    result.textContent = `PASS: ${name}`;
    document.title = `PASS: ${name}`;
  } catch (error) {
    result.dataset.status = "fail";
    result.textContent = `FAIL: ${name} - ${error.message}`;
    document.title = `FAIL: ${name}`;
    console.error(error);
  }
}
