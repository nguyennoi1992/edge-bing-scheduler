// Use as an ES module for MV3 service worker
import { buildQueries } from "./words.js";
import {
  buildQuestActivityKey,
  buildQuestCardKey,
  buildRewardCardKey,
  isActionableQuestActivity,
  isActionableRewardCard,
  isCompletedText,
  normalizeRewardText,
} from "./reward-dom-helpers.js";

const ALARM_NAME = "bingScheduler";
const BADGE_ALARM = "badgeTick";
const REWARDS_SETTLE_MS = 8000;
const REWARD_CHILD_SYNC_MS = 5000;
const REWARD_URL_TIMEOUT_MS = 480000;
const DEBUG_LOGS_KEY = 'debugLogs';
const DEBUG_LOG_RETENTION_DAYS = 7;
const DEBUG_LOG_RETENTION_MS = DEBUG_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const KEEPALIVE_ALARM = "keepAlive";

// Keep the MV3 service worker alive during active runs
async function startKeepAlive() {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  console.log("[KeepAlive] Started");
}

async function stopKeepAlive() {
  await chrome.alarms.clear(KEEPALIVE_ALARM);
  console.log("[KeepAlive] Stopped");
}

// Ensure a tab is focused and its window is in the foreground.
// Prevents Edge from throttling background tabs or suspending extension scripts.
async function ensureTabFocused(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
    }
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) {
    console.warn("[Focus] Failed to focus tab " + tabId + ":", e);
  }
}

const DEFAULTS = {
  enabled: true,
  time: "08:00", // 24h HH:MM
  searchesPerRun: 50, // how many queries to open per run
  intervalMin: 10, // min seconds between tabs
  intervalMax: 120, // max seconds between tabs
  customQueriesRaw: "", // newline or comma separated list
  nextRunAt: null,
};

async function getConfig() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...data };
}
function pruneDebugLogs(logs, now = Date.now()) {
  const cutoff = now - DEBUG_LOG_RETENTION_MS;
  return (Array.isArray(logs) ? logs : []).filter((entry) => {
    const ts = Number(entry?.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

async function appendDebugLog(level, phase, message, meta = {}) {
  try {
    const now = Date.now();
    const entry = {
      id: String(now) + '_' + Math.random().toString(36).slice(2, 8),
      ts: now,
      level,
      phase,
      message,
      meta,
    };
    const data = await chrome.storage.local.get(DEBUG_LOGS_KEY);
    const logs = pruneDebugLogs(data[DEBUG_LOGS_KEY], now);
    logs.push(entry);
    await chrome.storage.local.set({ [DEBUG_LOGS_KEY]: logs });
  } catch (e) {
    console.warn('[DebugLog] Failed to persist log:', e);
  }
}

async function clearDebugLogs() {
  await chrome.storage.local.set({ [DEBUG_LOGS_KEY]: [] });
}

let runTicker = null;
let singletonTabId = null;
let singletonWindowId = null;
let runPromise = null;

// ---------------- Badge helpers ----------------
async function updateBadge() {
  const { enabled, nextRunAt, running, runEndsAt, nextOpenAt } =
    await chrome.storage.sync.get([
      "enabled",
      "nextRunAt",
      "running",
      "runEndsAt",
      "nextOpenAt",
    ]);

  if (!enabled) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  const now = Date.now();

  if (running) {
    const remainToNext = nextOpenAt ? Math.max(0, nextOpenAt - now) : 0;
    const secs = Math.ceil(remainToNext / 1000);
    await chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
    await chrome.action.setBadgeText({ text: secs > 0 ? `${secs}s` : "0s" });
    return;
  }

  const remainingMs = nextRunAt ? Math.max(0, nextRunAt - now) : 0;
  if (remainingMs <= 0) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#1976d2" });
  const mins = Math.ceil(remainingMs / 60000);
  await chrome.action.setBadgeText({ text: mins >= 1 ? `${mins}m` : "<1m" });
}

async function ensureRunTicker() {
  const { running } = await chrome.storage.sync.get(["running"]);
  if (running) {
    if (!runTicker) {
      runTicker = setInterval(updateBadge, 1000);
    }
  } else if (runTicker) {
    clearInterval(runTicker);
    runTicker = null;
  }
}


function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function computeNextRunDate(timeHHMM) {
  const [hour, minute] = (timeHHMM || "08:00").split(":").map(Number);
  const now = new Date();
  const next = new Date();
  next.setHours(hour || 0, minute || 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function getQueryList(cfg) {
  const customList = (cfg.customQueriesRaw || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return buildQueries({ count: cfg.searchesPerRun, customList });
}

// ---------------- Bing Rewards auto click ----------------
/**
 * Inject the reward-dom-helpers functions into the page's MAIN world as globals.
 * This MUST be called before any executeScript({world:"MAIN"}) that references
 * normalizeRewardText, buildQuestCardKey, buildRewardCardKey, etc.
 *
 * Without this, those symbols are only available in the service-worker module
 * scope (imported from reward-dom-helpers.js) and every injected script would
 * crash with ReferenceError -- which is silently swallowed by the catch blocks,
 * making "Run now" appear to do nothing.
 */
async function injectDomHelpers(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      // Guard: only define once per page load
      if (window.__rewardDomHelpersInjected) return;
      window.__rewardDomHelpersInjected = true;

      window.normalizeRewardText = function normalizeRewardText(value) {
        return (value || "").replace(/\s+/g, " ").trim();
      };

      const COMPLETED_RE =
        /\bcompleted\b|\bdone\b|ho\u00e0n th\u00e0nh|\u0111\u00e3 xong|\u5df2\u5b8c\u6210|\u5b8c\u4e86|termin\u00e9|abgeschlossen|completado|\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e/i;

      window.isCompletedText = function isCompletedText(value) {
        return COMPLETED_RE.test(window.normalizeRewardText(value).toLowerCase());
      };

      const QUEST_HEADING_RE = /^(activities|ho\u1ea1t \u0111\u1ed9ng|tareas|activit\u00e9s|aufgaben)$/i;
      const QUEST_META_RE = /^(status:|expires:|tr\u1ea1ng th\u00e1i:|h\u1ebft h\u1ea1n:)/i;
      const QUEST_CHROME_RE = /^(feedback|privacy|terms|microsoft|bing|search)$/i;
      const QUEST_CLOSE_RE = /^(back|close|quay l\u1ea1i|\u0111\u00f3ng|zur\u00fcck|schlie\u00dfen|retour|fermer|volver|cerrar)$/i;

      window.isActionableRewardCard = function isActionableRewardCard(meta) {
        const href = meta.href || "";
        const text = window.normalizeRewardText(meta.text).toLowerCase();

        if (meta.isVisible === false) return false;
        if (meta.isDisabled) return false;
        if (meta.isCompleted) return false;
        if (meta.isInNav) return false;
        if (meta.isQuestCard) return false;
        if (!meta.hasVisual) return false;
        if (!text) return false;
        if (!href && !meta.isPressable) return false;
        if (meta.isHeader) return false;
        if (href === "/earn") return false;
        // Only skip short navigation buttons like "Earn more" or "See more tasks",
        // NOT cards whose longer description happens to contain these phrases.
        if (/^(see more tasks|earn more)$/i.test(text.replace(/\s+/g, " ").trim())) return false;

        return true;
      };

      window.buildRewardCardKey = function buildRewardCardKey({ href = "", title = "", text = "" }) {
        const normalizedTitle = window.normalizeRewardText(title || text).toLowerCase();
        return `${href}|${normalizedTitle}`;
      };

      window.buildQuestCardKey = function buildQuestCardKey({ href = "", text = "" }) {
        return `${href || "btn"}|${window.normalizeRewardText(text).toLowerCase()}`;
      };

      window.isActionableQuestActivity = function isActionableQuestActivity(meta) {
        const innerLabel = window.normalizeRewardText(meta.innerLabel);
        const ariaLabel = window.normalizeRewardText(meta.ariaLabel);
        const label = window.normalizeRewardText(`${ariaLabel} ${innerLabel}`).toLowerCase();

        if (meta.isVisible === false) return false;
        if (meta.isDisabled) return false;
        if (meta.isInNav) return false;
        if (meta.isQuestCard) return false;
        if (!label) return false;
        if (QUEST_HEADING_RE.test(label)) return false;
        if (QUEST_META_RE.test(label)) return false;
        if (QUEST_CHROME_RE.test(label)) return false;
        if (QUEST_CLOSE_RE.test(innerLabel)) return false;
        if (meta.isCompleted) return false;

        return true;
      };

      window.buildQuestActivityKey = function buildQuestActivityKey({ href = "", innerLabel = "", ariaLabel = "" }) {
        const label = window.normalizeRewardText(ariaLabel) || window.normalizeRewardText(innerLabel);
        return `${href}|${label.toLowerCase()}`;
      };

      console.log("[Rewards] DOM helper functions injected into page");
    },
  });
}

async function autoClickRewards() {
  console.log("⚡ Auto-clicking Bing Rewards cards...");
  await appendDebugLog("info", "rewards", "Rewards phase started");
  const rewardSectionIds = ["moreactivities", "microsoft", "streaks", "levelup", "global"];
  const rewardUrls = [
    "https://rewards.bing.com/earn",
    "https://rewards.bing.com/dashboard",
  ];

  async function claimReadyPoints(tabId) {
    const [{ result: claimResult = { clicked: false, claimedPoints: 0 } }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async () => {
          const maxAttempts = 20;
          const pollMs = 800;

          const normalizeText = (value) =>
            (value || "").replace(/\s+/g, " ").trim();

          const getNodeText = (node) => {
            if (!node) return "";
            const text =
              node.innerText ||
              node.textContent ||
              node.getAttribute?.("aria-label") ||
              "";
            return normalizeText(text);
          };

          const isVisible = (el) => {
            if (!el || typeof el.getBoundingClientRect !== "function") {
              return false;
            }
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };

          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

          const collectAllElements = (root) => {
            const results = [];
            const visit = (node) => {
              if (!node) return;
              if (node.nodeType === Node.ELEMENT_NODE) {
                results.push(node);
                if (node.shadowRoot) {
                  visit(node.shadowRoot);
                }
              }
              const children = node.children || [];
              for (const child of children) {
                visit(child);
              }
            };

            visit(root || document);
            return results;
          };

          const clickElement = (el) => {
            if (!el) return false;
            try {
              el.scrollIntoView({ behavior: "instant", block: "center" });
            } catch { }

            const eventTypes = [
              "pointerover",
              "pointerdown",
              "mousedown",
              "pointerup",
              "mouseup",
              "click",
            ];
            for (const type of eventTypes) {
              try {
                const EventCtor =
                  type.startsWith("pointer") && typeof PointerEvent === "function"
                    ? PointerEvent
                    : MouseEvent;
                el.dispatchEvent(
                  new EventCtor(type, {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    pointerId: 1,
                    isPrimary: true,
                    button: 0,
                    buttons: 1,
                  }),
                );
              } catch { }
            }

            try {
              el.click();
            } catch { }
            return true;
          };

          const findReadyToClaimCard = () => {
            const elements = collectAllElements(document);
            const labels = elements.filter((el) => {
              if (!(el instanceof HTMLElement)) return false;
              if (!isVisible(el)) return false;
              return /^ready to claim$|^sẵn sàng nhận$|^可领取$|^prêt à réclamer$|^bereit zum einlösen$|^listo para reclamar$|^готово к получению$/i.test(getNodeText(el).toLowerCase());
            });

            for (const labelEl of labels) {
              const cardButton = labelEl.closest(
                "button, [role='button'], a[role='button']",
              );
              if (!cardButton || !isVisible(cardButton)) continue;

              const text = getNodeText(cardButton);
              const matches = Array.from(
                text.matchAll(/\b\d[\d,.]*\b/g),
                (m) => m[0],
              );
              const numericValues = matches
                .map((value) => Number(value.replace(/[,.]/g, "")))
                .filter((value) => Number.isFinite(value));
              const points = numericValues.length ? Math.max(...numericValues) : 0;

              if (points > 0) {
                return { cardButton, points };
              }
            }

            return null;
          };

          const findDialogClaimButton = () => {
            const dialogs = collectAllElements(document).filter((el) => {
              if (!(el instanceof HTMLElement)) return false;
              if (!isVisible(el)) return false;
              return (el.getAttribute("role") || "").toLowerCase() === "dialog";
            });

            for (const dialog of dialogs) {
              if (!/claim points/i.test(getNodeText(dialog))) continue;
              const button = Array.from(
                dialog.querySelectorAll(
                  "button, [role='button'], input[type='button'], input[type='submit']",
                ),
              ).find((el) => {
                if (!(el instanceof HTMLElement)) return false;
                if (!isVisible(el)) return false;
                return getNodeText(el).toLowerCase() === "claim points";
              });
              if (button) return button;
            }

            return null;
          };

          console.log("[Rewards-Debug] claimReadyPoints: Scanning for ready-to-claim cards...");
          const readyCard = findReadyToClaimCard();
          if (!readyCard) {
            console.log("[Rewards-Debug] claimReadyPoints: No ready-to-claim card found.");
            return { clicked: false, claimedPoints: 0, reason: "not_ready" };
          }

          console.log("[Rewards-Debug] claimReadyPoints: Found ready card for " + readyCard.points + " points. Clicking...");
          clickElement(readyCard.cardButton);

          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await sleep(pollMs);
            const claimPointsButton = findDialogClaimButton();
            if (!claimPointsButton) continue;

            console.log("[Rewards-Debug] claimReadyPoints: Claim points dialog found. Clicking claim...");
            clickElement(claimPointsButton);
            return {
              clicked: true,
              claimedPoints: readyCard.points,
            };
          }

          return {
            clicked: false,
            claimedPoints: readyCard.points,
            reason: "claim_points_button_not_found",
          };
        },
      });

    return claimResult;
  }

  async function closeChildTabs(parentTabId, rounds = 4, delayMs = 1200, windowId = undefined) {
    for (let i = 0; i < rounds; i++) {
      const queryOpts = windowId ? { windowId } : {};
      const allTabs = await chrome.tabs.query(queryOpts);
      const openerMap = new Map();
      for (const t of allTabs) {
        if (Number.isInteger(t.id)) {
          openerMap.set(t.id, t.openerTabId);
        }
      }

      const descendants = [];
      for (const [id] of openerMap) {
        const seenOpeners = new Set();
        let opener = openerMap.get(id);
        while (Number.isInteger(opener) && !seenOpeners.has(opener)) {
          seenOpeners.add(opener);
          if (opener === parentTabId) {
            descendants.push(id);
            break;
          }
          opener = openerMap.get(opener);
        }
      }
      const childIds = descendants.filter((id) => Number.isInteger(id));

      if (childIds.length) {
        try {
          await chrome.tabs.remove(childIds);
          console.log(
            `[Rewards] Closed ${childIds.length} child tab(s) from ${parentTabId}`,
          );
        } catch (e) {
          console.warn(
            `[Rewards] Failed closing child tab(s) from ${parentTabId}:`,
            e,
          );
        }
      }

      if (i < rounds - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async function closeNewRewardTabs(
    baselineTabIds,
    excludeTabIds = [],
    rounds = 4,
    delayMs = 1200,
    windowId = undefined,
  ) {
    const rewardLikeUrl =
      /(rewards\.bing\.com|bing\.com|msn\.com|microsoft\.com\/rewards)/i;
    const exclude = new Set(
      (excludeTabIds || []).filter((id) => Number.isInteger(id)),
    );

    for (let i = 0; i < rounds; i++) {
      const queryOpts = windowId ? { windowId } : {};
      const allTabs = await chrome.tabs.query(queryOpts);
      const candidateIds = allTabs
        .filter((t) => Number.isInteger(t.id))
        .filter((t) => !baselineTabIds.has(t.id))
        .filter((t) => !exclude.has(t.id))
        .filter((t) => rewardLikeUrl.test(t.url || t.pendingUrl || ""))
        .map((t) => t.id);

      if (candidateIds.length) {
        try {
          await chrome.tabs.remove(candidateIds);
          console.log(
            `[Rewards] Closed ${candidateIds.length} new reward tab(s)`,
          );
        } catch (e) {
          console.warn("[Rewards] Failed closing new reward tab(s):", e);
        }
      }

      if (i < rounds - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  /**
   * Inject human-like scroll behaviour into a child tab so Bing registers the visit.
   * Scrolls down in random increments with random pauses, then scrolls back up partially.
   * Total duration is randomised between ~4-8 seconds.
   */
  async function humanScrollOnTab(tabId, timeoutMs = 15000) {
    try {
      // Make sure the tab is ready
      await waitForTabComplete(tabId, timeoutMs);
      await new Promise((r) => setTimeout(r, 1500));

      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

          // Random integer between min and max (inclusive)
          const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

          const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 900;
          const pageHeight = Math.max(
            document.body.scrollHeight || 0,
            document.documentElement.scrollHeight || 0,
            viewportHeight
          );
          const maxScroll = Math.max(0, pageHeight - viewportHeight);

          if (maxScroll <= 50) {
            // Page is too short to scroll, just wait a bit to simulate reading
            await sleep(rand(2000, 4000));
            return;
          }

          let currentY = window.scrollY || 0;

          // Phase 1: Scroll down in 3–6 random steps
          const downSteps = rand(3, 6);
          console.log("[Rewards-Debug] humanScrollOnTab: Phase 1 - Scrolling down in " + downSteps + " steps.");
          for (let i = 0; i < downSteps; i++) {
            const scrollAmount = rand(
              Math.floor(viewportHeight * 0.3),
              Math.floor(viewportHeight * 0.85)
            );
            const targetY = Math.min(currentY + scrollAmount, maxScroll);

            window.scrollTo({ top: targetY, behavior: "smooth" });
            currentY = targetY;

            // Random reading pause between scrolls (400ms – 1800ms)
            await sleep(rand(400, 1800));

            if (currentY >= maxScroll) break;
          }

          // Phase 2: Brief pause at the bottom (simulate reading)
          await sleep(rand(800, 2000));

          // Phase 3: Scroll back up partially (1–3 steps) — humans don't always scroll all the way back
          const upSteps = rand(1, 3);
          console.log("[Rewards-Debug] humanScrollOnTab: Phase 3 - Scrolling up in " + upSteps + " steps.");
          for (let i = 0; i < upSteps; i++) {
            const scrollAmount = rand(
              Math.floor(viewportHeight * 0.2),
              Math.floor(viewportHeight * 0.6)
            );
            const targetY = Math.max(currentY - scrollAmount, 0);

            window.scrollTo({ top: targetY, behavior: "smooth" });
            currentY = targetY;

            await sleep(rand(300, 1200));

            if (currentY <= 0) break;
          }


          console.log("[Rewards-Debug] humanScrollOnTab: Phase 4 - Dispatching random mousemove events.");
          // Phase 4: Small random mouse-move events to look human
          for (let i = 0; i < rand(2, 5); i++) {
            try {
              document.dispatchEvent(
                new MouseEvent("mousemove", {
                  clientX: rand(100, window.innerWidth - 100),
                  clientY: rand(100, window.innerHeight - 100),
                  bubbles: true,
                })
              );
            } catch { }
            await sleep(rand(200, 600));
          }

          // Final brief pause
          await sleep(rand(500, 1500));
        },
      });

      console.log(`[Rewards] Human scroll completed on tab ${tabId}`);
    } catch (e) {
      console.warn(`[Rewards] Human scroll failed on tab ${tabId}:`, e?.message || e);
    }
  }

  async function getQuestCards(tabId) {
    const [{ result: questCards = [] } = {}] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const isVisible = (el) => {
            if (!el || typeof el.getBoundingClientRect !== "function") {
              return false;
            }
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };

          const questNodes = Array.from(
            document.querySelectorAll("#quests a[href], #quests button, #quests [role=\'button\'], #quests .rounded-cornerCardDefault, #quests [data-react-aria-pressable=\'true\']")
          );
          console.log("[Rewards-Debug] getQuestCards: Found " + questNodes.length + " potential quest nodes in DOM.");
          const seen = new Set();
          const items = [];

          for (const node of questNodes) {
            if (!isVisible(node)) continue;

            const href = node.getAttribute("href") || "";
            // Skip non-quest navigation links inside #quests
            if (node.tagName.toLowerCase() === "a" && (!href || !/\/earn\/quest\//i.test(href))) {
              continue;
            }

            const linkText = normalizeRewardText(node.innerText || node.textContent || "");
            if (!linkText) continue;

            const key = buildQuestCardKey({ href, text: linkText });

            if (seen.has(key)) continue;
            seen.add(key);

            items.push({
              href: key,
              key: key,
            });
          }

          console.log("[Rewards-Debug] getQuestCards: Returning " + items.length + " valid actionable quest cards.");
          console.log("[Rewards-Debug] getQuestActivities: Returning " + items.length + " valid actionable activities.");
          return items;
        },
      });

    return Array.isArray(questCards) ? questCards : [];
  }

  async function clickQuestCard(tabId, targetHref) {
    const [{ result: clicked = false }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [targetHref],
        func: async (hrefToClick) => {
          console.log("[Rewards-Debug] clickQuestCard: Attempting to find and click quest card:", hrefToClick);
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

          const isVisible = (el) => {
            if (!el || typeof el.getBoundingClientRect !== "function") {
              return false;
            }
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };

          let card = null;
          for (let attempt = 0; attempt < 20; attempt++) {
            const questNodes = Array.from(
              document.querySelectorAll("#quests a[href], #quests button, #quests [role=\'button\'], #quests .rounded-cornerCardDefault, #quests [data-react-aria-pressable=\'true\']")
            );
            console.log("[Rewards-Debug] getQuestCards: Found " + questNodes.length + " potential quest nodes in DOM.");

            card = questNodes.find((el) => {
              if (!isVisible(el)) return false;
              const href = el.getAttribute("href") || "";
              const linkText = normalizeRewardText(el.innerText || el.textContent || "");
              const key = buildQuestCardKey({ href, text: linkText });
              return key === hrefToClick;
            });

            if (card) break;
            await sleep(800);
          }

          if (!card) return false;

          try {
            console.log("[Rewards-Debug] clickQuestCard: Found target quest card. Scrolling into view and simulating clicks...");
            card.scrollIntoView({ behavior: "instant", block: "center" });
          } catch { }

          for (const type of ["mouseover", "mousedown", "mouseup"]) {
            try {
              card.dispatchEvent(
                new MouseEvent(type, {
                  view: window,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            } catch { }
          }

          try {
            card.click();
          } catch { }

          return true;
        },
      });

    return clicked;
  }

  async function getQuestActivities(tabId) {
    const [{ result: activities = [] } = {}] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const isVisible = (el) => {
            if (!el || typeof el.getBoundingClientRect !== "function") {
              return false;
            }
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };

          console.log("[Rewards-Debug] getQuestActivities: Scanning DOM for activities section...");
          let activitiesRoot = null;
          const activitiesHeading = Array.from(document.querySelectorAll("h2, h3, h4")).find(
            (el) => isVisible(el) && /activities|hoạt động|tareas|activités|aufgaben/i.test(normalizeRewardText(el.textContent)),
          );
          if (activitiesHeading) {
            activitiesRoot =
              activitiesHeading.closest("div.overflow-hidden, section, [role='region'], .content-container") ||
              activitiesHeading.parentElement?.parentElement?.parentElement;
          }
          if (!activitiesRoot) {
            activitiesRoot = document.querySelector("#quests-details, dialog, [role='dialog'], .action-pane");
          }
          if (!activitiesRoot) return [];

          const activityCards = Array.from(
            activitiesRoot.querySelectorAll(
              ".rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']",
            ),
          ).filter((el) => isVisible(el) && !el.closest("#quests"));
          console.log("[Rewards-Debug] getQuestActivities: Found " + activityCards.length + " activity cards inside root. Filtering actionable ones...");

          const seen = new Set();
          const items = [];
          for (const card of activityCards) {
            const cardText = normalizeRewardText(card.innerText || card.textContent || "");
            const actionTarget =
              card.querySelector("button:not([aria-disabled='true']), [role='button']:not([aria-disabled='true']), a[href], [role='link'], [data-react-aria-pressable='true']") ||
              card;
            const href = actionTarget.href || actionTarget.getAttribute("href") || "";
            const innerLabel = normalizeRewardText(actionTarget.innerText || actionTarget.textContent || cardText);
            const ariaLabel = normalizeRewardText(actionTarget.getAttribute("aria-label") || "");
            const label = ariaLabel || innerLabel || cardText;
            const isCompleted =
              !!card.closest("[class*='completed'], [class*='Success']") ||
              !!card.querySelector("svg[class*='Success'], mee-icon[class*='Success']") ||
              isCompletedText(cardText);
            const isActionable = isActionableQuestActivity({
              innerLabel: label,
              ariaLabel: "",
              isVisible: true,
              isDisabled:
                actionTarget.getAttribute("aria-disabled") === "true" ||
                !!actionTarget.closest("[aria-disabled='true'], [data-disabled='true']"),
              isInNav: !!card.closest("nav, header, [role='banner']"),
              isQuestCard: false,
              isCompleted,
            });
            if (!isActionable) continue;
            const key = buildQuestActivityKey({ href, innerLabel: `${cardText} ${label}`, ariaLabel: "" });
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ href, label, key });
          }

          console.log("[Rewards-Debug] getQuestCards: Returning " + items.length + " valid actionable quest cards.");
          console.log("[Rewards-Debug] getQuestActivities: Returning " + items.length + " valid actionable activities.");
          return items;
        },
      });

    return Array.isArray(activities) ? activities : [];
  }

  async function clickQuestActivity(tabId, targetKey) {
    const [{ result: clicked = false }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [targetKey],
        func: async (keyToClick) => {
          console.log("[Rewards-Debug] clickQuestActivity: Attempting to click activity with key:", keyToClick);
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

          const isVisible = (el) => {
            if (!el || typeof el.getBoundingClientRect !== "function") {
              return false;
            }
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };

          let el = null;
          let actionEl = null;
          for (let attempt = 0; attempt < 20; attempt++) {
            console.log("[Rewards-Debug] getQuestActivities: Scanning DOM for activities section...");
            let activitiesRoot = null;
            const activitiesHeading = Array.from(document.querySelectorAll("h2, h3, h4")).find(
              (heading) => isVisible(heading) && /activities|hoạt động|tareas|activités|aufgaben/i.test(normalizeRewardText(heading.textContent)),
            );
            if (activitiesHeading) {
              activitiesRoot =
                activitiesHeading.closest("div.overflow-hidden, section, [role='region'], .content-container") ||
                activitiesHeading.parentElement?.parentElement?.parentElement;
            }
            if (!activitiesRoot) {
              activitiesRoot = document.querySelector("#quests-details, dialog, [role='dialog'], .action-pane");
            }

            if (activitiesRoot) {
              const cards = Array.from(
                activitiesRoot.querySelectorAll(
                  ".rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']",
                ),
              ).filter((candidate) => isVisible(candidate) && !candidate.closest("#quests"));

              for (const candidate of cards) {
                const cardText = normalizeRewardText(candidate.innerText || candidate.textContent || "");
                const target =
                  candidate.querySelector("button:not([aria-disabled='true']), [role='button']:not([aria-disabled='true']), a[href], [role='link'], [data-react-aria-pressable='true']") ||
                  candidate;
                const href = target.href || target.getAttribute("href") || "";
                const innerLabel = normalizeRewardText(target.innerText || target.textContent || cardText);
                const candKey = buildQuestActivityKey({
                  href,
                  innerLabel: `${cardText} ${innerLabel || cardText}`,
                  ariaLabel: "",
                });
                const isMatchable = isActionableQuestActivity({
                  innerLabel: innerLabel || cardText,
                  ariaLabel: "",
                  isVisible: true,
                  isDisabled:
                    target.getAttribute("aria-disabled") === "true" ||
                    !!target.closest("[aria-disabled='true'], [data-disabled='true']"),
                  isInNav: !!candidate.closest("nav, header, [role='banner']"),
                  isQuestCard: false,
                  isCompleted:
                    !!candidate.closest("[class*='completed'], [class*='Success']") ||
                    !!candidate.querySelector("svg[class*='Success'], mee-icon[class*='Success']") ||
                    isCompletedText(cardText),
                });
                if (!isMatchable) continue;

                const targetHrefPart = keyToClick.split("|")[0];
                if ((targetHrefPart && href && href === targetHrefPart) || candKey === keyToClick) {
                  el = candidate;
                  actionEl = target;
                  break;
                }
              }
            }

            if (el) break;
            await sleep(800);
          }

          if (!el) return { clicked: false, href: "" };

          const beforeUrl = location.href;
          const beforeText = normalizeRewardText(document.body?.innerText || document.body?.textContent || "");

          function centerPoint(element) {
            const rect = element.getBoundingClientRect();
            return {
              clientX: rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2)),
              clientY: rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2)),
            };
          }

          function dispatchPointerMouseSequence(target) {
            if (!target) return false;
            console.log("[Rewards-Debug] dispatchPointerMouseSequence: Triggering pointer & mouse sequence on target element.");
            const point = centerPoint(target);
            const common = {
              view: window, bubbles: true, cancelable: true, composed: true,
              button: 0, buttons: 1, clientX: point.clientX, clientY: point.clientY,
            };
            const eventPlan = [
              ["pointerover", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse" }],
              ["pointerenter", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse" }],
              ["mouseover", MouseEvent, {}],
              ["mouseenter", MouseEvent, {}],
              ["pointermove", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse" }],
              ["mousemove", MouseEvent, {}],
              ["pointerdown", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse", pressure: 0.5 }],
              ["mousedown", MouseEvent, {}],
              ["pointerup", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse", pressure: 0 }],
              ["mouseup", MouseEvent, {}],
              ["click", MouseEvent, {}],
            ];
            for (const [type, Ctor, extra] of eventPlan) {
              try {
                const EventCtor = Ctor === PointerEvent && typeof PointerEvent !== "function" ? MouseEvent : Ctor;
                target.dispatchEvent(new EventCtor(type, { ...common, ...extra }));
              } catch { }
            }
            return true;
          }

          function getClickableTargets(container) {
            if (!container) return [];
            const candidates = [
              container.matches?.("a[href], [role=\"link\"], [role=\"button\"], button") ? container : null,
              container.closest("a[href]"),
              container.closest("button"),
              container.querySelector("a[href]"),
              container.querySelector("button"),
              container.querySelector("[role=\"link\"]"),
              container.querySelector("[role=\"button\"]"),
              container.querySelector("img"),
              container.querySelector("mee-icon"),
              container.querySelector("svg"),
              container,
            ].filter(Boolean);
            const unique = [];
            const seen = new Set();
            for (const c of candidates) {
              if (!(c instanceof HTMLElement)) continue;
              if (!isVisible(c)) continue;
              if (seen.has(c)) continue;
              seen.add(c);
              unique.push(c);
            }
            return unique;
          }

          console.log("[Rewards-Debug] clickQuestActivity: Activity element found. Resolving clickable targets...");
          const targets = getClickableTargets(actionEl || el);
          console.log("[Rewards-Debug] clickQuestActivity: Found " + targets.length + " nested clickable targets.");
          let success = false;

          for (const target of targets) {
            try {
              target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
            } catch { }

            try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch { } }

            try {
              dispatchPointerMouseSequence(target);
              await sleep(300);
            } catch { }

            try {
              target.click();
              // Brute-force click all inner elements in case React is attached to a child span/svg
              const children = target.querySelectorAll("*");
              for (const child of children) {
                try { child.click(); } catch { }
              }
              await sleep(300);
            } catch { }

            for (const key of ["Enter", " "]) {
              console.log("[Rewards-Debug] Keyboard Fallback: Attempting to trigger click via \'" + key + "\' key press...");
              try {
                const code = key === " " ? "Space" : key;
                try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch { } }
                for (const type of ["keydown", "keypress", "keyup"]) {
                  target.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true }));
                }
                await sleep(200);
              } catch { }
            }

            console.log("[Rewards-Debug] Fallback: Using document.elementFromPoint to find top-most element.");
            // elementFromPoint fallback: click exactly what is on the screen at this coordinate
            try {
              const point = centerPoint(target);
              const topEl = document.elementFromPoint(point.clientX, point.clientY);
              if (topEl && topEl instanceof HTMLElement && topEl !== target) {
                dispatchPointerMouseSequence(topEl);
                topEl.click();
                await sleep(200);
              }
            } catch { }

            const afterUrl = location.href;
            const afterText = normalizeRewardText(document.body?.innerText || document.body?.textContent || "");
            if (afterUrl !== beforeUrl || afterText !== beforeText) {
              console.log("[Rewards-Debug] clickQuestActivity: DOM state changed (URL or Text). Click registered successfully.");
              success = true;
              break;
            }
          }

          return {
            clicked: success,
            href:
              actionEl?.href ||
              actionEl?.getAttribute?.("href") ||
              el.href ||
              el.getAttribute("href") ||
              "",
          };
        },
      });

    return clicked;
  }

  async function getRewardCards(tabId, targetSectionIds) {
    const [{ result: rewardCards = [] } = {}] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [targetSectionIds || rewardSectionIds],
        func: (sectionIds) => {
          return new Promise((resolve) => {
            const isVisible = (el) => {
              if (!el || typeof el.getBoundingClientRect !== "function") return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== "hidden" &&
                style.display !== "none"
              );
            };

            function expandSectionIfCollapsed(section) {
              if (!section) return;
              // React Aria Disclosure pattern: button[slot='trigger']
              const trigger = section.querySelector(
                "button[slot='trigger'][aria-expanded='false']",
              );
              if (trigger) {
                try {
                  trigger.click();
                } catch { }
              }
              // Also handle aria-expanded on buttons with aria-controls
              const collapsedBtns = section.querySelectorAll(
                "button[aria-expanded='false'][aria-controls]",
              );
              for (const btn of collapsedBtns) {
                try { btn.click(); } catch { }
              }
            }

            function isCardCompleted(cardEl) {
              if (!cardEl) return false;
              const successBadge = cardEl.querySelector(
                "[class*='statusSuccess']"
              );
              if (successBadge && successBadge.querySelector("svg")) {
                return true;
              }

              const statusEls = cardEl.querySelectorAll(
                "[class*='metadata'], [class*='fgCtrlNeutralSecondary']"
              );
              for (const el of statusEls) {
                const t = normalizeRewardText(el.textContent || "").toLowerCase();
                if (isCompletedText(t)) return true;
              }

              const fullText = normalizeRewardText(cardEl.innerText || cardEl.textContent || "").toLowerCase();
              if (isCompletedText(fullText)) return true;

              return false;
            }

            function findRewardCardRoots(rootNode) {
              const selectors = [
                "a[href]",
                "button",
                "[role='button']",
                "[role='link']",
                "[data-react-aria-pressable='true']",
              ];
              const roots = [];
              const seen = new Set();

              for (const selector of selectors) {
                const nodes = rootNode.querySelectorAll(selector);
                for (const node of nodes) {
                  const card =
                    node.closest("a[href].rounded-cornerCardDefault, button.rounded-cornerCardDefault, [role='button'].rounded-cornerCardDefault, [role='link'].rounded-cornerCardDefault, [data-react-aria-pressable='true'].rounded-cornerCardDefault") ||
                    node.closest(".rounded-cornerCardDefault") ||
                    node.closest("[class*='rounded-cornerCardDefault']") ||
                    node;
                  if (!card || seen.has(card)) continue;
                  seen.add(card);
                  roots.push(card);
                }
              }

              return roots;
            }

            function collectSectionCardsById(sectionId) {
              let section = null;
              if (sectionId !== "global") {
                section = document.querySelector(`#${sectionId}`);
                if (!section) return [];
                expandSectionIfCollapsed(section);
              }
              const rootNode = section || document;
              const cardRoots = findRewardCardRoots(rootNode);

              const unique = [];
              const seen = new Set();

              for (const card of cardRoots) {
                const href =
                  card.getAttribute("href") ||
                  card.querySelector("a[href]")?.getAttribute("href") ||
                  "";
                const text = normalizeRewardText(card.innerText || card.textContent || "");
                const key = buildRewardCardKey({ href, text });
                const meta = {
                  href,
                  text,
                  hasVisual: !!card.querySelector("img, mee-icon, svg, .mee-icon, [class*='icon'], [class*='Icon'], picture"),
                  isDisabled: card.getAttribute("aria-disabled") === "true" || !!card.closest("[aria-disabled='true'], [data-disabled='true']"),
                  isCompleted: isCardCompleted(card),
                  isVisible: isVisible(card),
                  isInNav: !!card.closest("nav, header, footer, [role='banner']"),
                  isQuestCard: !!card.closest("#quests"),
                  isHeader: card.hasAttribute("slot") || card.hasAttribute("aria-controls") || card.hasAttribute("aria-expanded") || !!card.closest("h1, h2, h3, h4") || !!card.querySelector("h1, h2, h3, h4"),
                  isPressable: card.matches?.("button, [role='button'], [role='link'], [data-react-aria-pressable='true']") || !!card.querySelector("[data-react-aria-pressable='true'], button, [role='button'], [role='link']"),
                };
                const isActionable = isActionableRewardCard(meta);

                if (!isActionable) {
                  // Debug logging to find out WHY the card was rejected
                  console.log(`[Rewards-Debug] Card rejected. href: ${href.substring(0, 40)}... text: ${text.substring(0, 40)}... Meta:`, JSON.stringify(meta));
                  continue;
                }

                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(card);
                console.log(`[Rewards-Debug] Card accepted! href: ${href.substring(0, 40)}... text: ${text.substring(0, 40)}...`);
              }

              console.log(
                `[Rewards] Section #${sectionId}: found ${unique.length} actionable card(s)`,
              );
              return unique;
            }

            function buildCardKey(card) {
              const href =
                card?.href ||
                card?.getAttribute?.("href") ||
                card?.querySelector?.("a[href]")?.getAttribute?.("href") ||
                "";
              const titleEl =
                card.querySelector("p.text-globalBody2Strong") ||
                card.querySelector("p.text-body1Strong") ||
                card.querySelector("p[class*=\"globalBody2Strong\"]") ||
                card.querySelector("p[class*=\"body1Strong\"]") ||
                card.querySelector("p") ||
                card.querySelector("img[alt]");
              const rawTitle =
                titleEl?.textContent || titleEl?.getAttribute?.("alt") || "";
              return buildRewardCardKey({
                href,
                title: rawTitle,
                text: card?.innerText || card?.textContent || "",
              });
            }

            function collectCards(cards) {
              const items = [];
              const seen = new Set();

              for (const card of cards) {
                const href =
                  card?.href ||
                  card?.getAttribute?.("href") ||
                  card?.querySelector?.("a[href]")?.getAttribute?.("href") ||
                  "";
                const key = buildCardKey(card);
                if (!key) continue;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({ key, href });
              }

              return items;
            }

            let attempts = 0;
            const maxAttempts = 20;
            const pollMs = 1500;
            let prevCount = -1;
            let stableRounds = 0;

            const timer = setInterval(() => {
              attempts++;
              const sectionCards = (sectionIds || [])
                .map((sectionId) => collectSectionCardsById(sectionId))
                .flat();
              const cards = collectCards(sectionCards);

              // Wait for card count to stabilize (2 consecutive same counts)
              if (cards.length === prevCount) {
                stableRounds++;
              } else {
                stableRounds = 0;
              }
              prevCount = cards.length;

              console.log("[Rewards-Debug] getRewardCards: Attempt " + attempts + " - Found " + cards.length + " cards. Stable rounds: " + stableRounds);
              if ((cards.length > 0 && stableRounds >= 1) || attempts >= maxAttempts) {
                clearInterval(timer);
                console.log(
                  `[Rewards] Actionable cards found across sections: ${cards.length} (from ${sectionCards.length} section cards, after ${attempts} polls)`,
                );
                resolve(cards);
              }
            }, pollMs);
          });
        },
      });
    return Array.isArray(rewardCards) ? rewardCards : [];
  }

  async function clickRewardCard(tabId, targetKey, targetSectionIds) {
    const [{ result: clickResult = { clicked: false, href: "" } } = {}] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [targetKey, targetSectionIds || rewardSectionIds],
        func: async (keyToClick, sectionIds) => {
          console.log("[Rewards-Debug] clickRewardCard: Attempting to click reward card with key:", keyToClick);
          const isVisible = (el) => {
            if (!el || typeof el.getBoundingClientRect !== "function") return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };

          const isDisabled = (el) =>
            !el ||
            el.getAttribute("aria-disabled") === "true" ||
            !!el.closest("[aria-disabled='true'], [data-disabled='true']");

          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

          function expandSectionIfCollapsed(section) {
            if (!section) return;
            const trigger = section.querySelector(
              "button[slot='trigger'][aria-expanded='false']",
            );
            if (trigger) {
              try {
                trigger.click();
              } catch { }
            }
            // Also handle aria-expanded on buttons with aria-controls
            const collapsedBtns = section.querySelectorAll(
              "button[aria-expanded='false'][aria-controls]",
            );
            for (const btn of collapsedBtns) {
              try { btn.click(); } catch { }
            }
          }

          function isCardCompleted(cardEl) {
            if (!cardEl) return false;
            const successBadge = cardEl.querySelector(
              "[class*='statusSuccess']"
            );
            if (successBadge && successBadge.querySelector("svg")) {
              return true;
            }

            const statusEls = cardEl.querySelectorAll(
              "[class*='metadata'], [class*='fgCtrlNeutralSecondary']"
            );
            for (const el of statusEls) {
              const t = normalizeRewardText(el.textContent || "").toLowerCase();
              if (isCompletedText(t)) return true;
            }

            const fullText = normalizeRewardText(cardEl.innerText || cardEl.textContent || "").toLowerCase();
            if (isCompletedText(fullText)) return true;
            return false;
          }

          function findRewardCardRoots(rootNode) {
            const selectors = [
              ".rounded-cornerCardDefault",
              "[class*='rounded-cornerCardDefault']",
              "[data-react-aria-pressable='true']",
              "a[href]",
              "button",
              "[role='button']",
              "[role='link']",
            ];
            const roots = [];
            const seen = new Set();

            for (const selector of selectors) {
              const nodes = rootNode.querySelectorAll(selector);
              for (const node of nodes) {
                const card =
                  node.closest(".rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']") ||
                  node;
                if (!card || seen.has(card)) continue;
                seen.add(card);
                roots.push(card);
              }
            }

            return roots;
          }

          function collectSectionCardsById(sectionId) {
            let section = null;
            if (sectionId !== "global") {
              section = document.querySelector(`#${sectionId}`);
              if (!section) return [];
              expandSectionIfCollapsed(section);
            }
            const rootNode = section || document;
            return findRewardCardRoots(rootNode).filter((card) => {
              const href =
                card.getAttribute("href") ||
                card.querySelector("a[href]")?.getAttribute("href") ||
                "";
              const text = normalizeRewardText(card.innerText || card.textContent || "");
              return isActionableRewardCard({
                href,
                text,
                hasVisual: !!card.querySelector("img, mee-icon, svg, .mee-icon"),
                isDisabled: isDisabled(card),
                isCompleted: isCardCompleted(card),
                isVisible: isVisible(card),
                isInNav: !!card.closest("nav, header, footer, [role='banner']"),
                isQuestCard: !!card.closest("#quests"),
                isHeader: card.hasAttribute("slot") || card.hasAttribute("aria-controls") || card.hasAttribute("aria-expanded") || !!card.closest("h1, h2, h3, h4") || !!card.querySelector("h1, h2, h3, h4"),
                isPressable:
                  !!card.matches?.("button, [role='button'], [role='link'], [data-react-aria-pressable='true'], a[href]") ||
                  !!card.querySelector("[data-react-aria-pressable='true'], button, [role='button'], [role='link'], a[href]"),
              });
            });
          }

          function buildCardKey(card) {
            const href =
              card?.href ||
              card?.getAttribute?.("href") ||
              card?.querySelector?.("a[href]")?.getAttribute?.("href") ||
              "";
            const titleEl =
              card.querySelector("p.text-globalBody2Strong") ||
              card.querySelector("p.text-body1Strong") ||
              card.querySelector("p[class*=\"globalBody2Strong\"]") ||
              card.querySelector("p[class*=\"body1Strong\"]") ||
              card.querySelector("p") ||
              card.querySelector("img[alt]");
            const rawTitle =
              titleEl?.textContent || titleEl?.getAttribute?.("alt") || "";
            return buildRewardCardKey({
              href,
              title: rawTitle,
              text: card?.innerText || card?.textContent || "",
            });
          }

          function getCardSignature(card) {
            if (!card) return "";
            const href = card?.getAttribute?.("href") || card?.href || "";
            const expanded =
              card.getAttribute("aria-expanded") ||
              card.querySelector("[aria-expanded]")?.getAttribute("aria-expanded") ||
              "";
            const disabled = isDisabled(card) ? "disabled" : "enabled";
            const status = normalizeRewardText(card?.innerText || card?.textContent || "").toLowerCase();
            return `${href}|${expanded}|${disabled}|${status}`;
          }

          function getClickableTargets(card) {
            if (!card) return [];

            const candidates = [
              card,
              card.matches?.("[data-react-aria-pressable=\"true\"], a[href], [role=\"link\"], [role=\"button\"], button") ? card : null,
              card.querySelector("[data-react-aria-pressable=\"true\"]"),
              card.querySelector("[role=\"link\"]"),
              card.querySelector("[role=\"button\"]"),
              card.querySelector("button"),
              card.querySelector("a[href]"),
              card.querySelector("img"),
              card.querySelector("mee-icon"),
              card.querySelector("svg"),
            ].filter(Boolean);

            const unique = [];
            const seen = new Set();
            for (const el of candidates) {
              if (!(el instanceof HTMLElement)) continue;
              if (!isVisible(el) || isDisabled(el)) continue;
              if (seen.has(el)) continue;
              seen.add(el);
              unique.push(el);
            }

            return unique;
          }

          function centerPoint(el) {
            const rect = el.getBoundingClientRect();
            return {
              clientX: rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2)),
              clientY: rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2)),
            };
          }

          function dispatchPointerMouseSequence(target) {
            if (!target) return false;
            console.log("[Rewards-Debug] dispatchPointerMouseSequence: Triggering pointer & mouse sequence on target element.");

            const point = centerPoint(target);
            const common = {
              view: window,
              bubbles: true,
              cancelable: true,
              composed: true,
              button: 0,
              buttons: 1,
              clientX: point.clientX,
              clientY: point.clientY,
            };

            const eventPlan = [
              ["pointerover", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse" }],
              ["pointerenter", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse" }],
              ["mouseover", MouseEvent, {}],
              ["mouseenter", MouseEvent, {}],
              ["pointermove", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse" }],
              ["mousemove", MouseEvent, {}],
              ["pointerdown", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse", pressure: 0.5 }],
              ["mousedown", MouseEvent, {}],
              ["pointerup", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse", pressure: 0 }],
              ["mouseup", MouseEvent, {}],
              ["click", MouseEvent, {}],
            ];

            for (const [type, Ctor, extra] of eventPlan) {
              try {
                const EventCtor =
                  Ctor === PointerEvent && typeof PointerEvent !== "function"
                    ? MouseEvent
                    : Ctor;
                target.dispatchEvent(new EventCtor(type, { ...common, ...extra }));
              } catch { }
            }

            return true;
          }

          async function tryActivateTarget(card, target) {
            if (!target || !isVisible(target) || isDisabled(target)) return false;

            const beforeSignature = getCardSignature(card);
            const beforeUrl = location.href;

            // Detect if this card opens in a new tab (target="_blank" links)
            const isExternalLink =
              (card.getAttribute("target") === "_blank") ||
              (target.getAttribute?.("target") === "_blank") ||
              (card.closest?.("a[target='_blank']") !== null);

            try {
              target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
            } catch { }

            try {
              target.focus({ preventScroll: true });
            } catch {
              try {
                target.focus();
              } catch { }
            }

            // For external links (target="_blank"), clicking opens a new tab
            // but doesn't change the current page's URL or DOM.
            // We must click the actual card element (not window.open) for Bing to register it.
            if (isExternalLink) {
              // Full pointer+mouse event sequence on the target
              try {
                dispatchPointerMouseSequence(target);
                await sleep(300);
              } catch { }

              // Native .click()
              try {
                target.click();
                await sleep(300);
              } catch { }

              // Keyboard Enter as fallback
              try {
                try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch { } }
                for (const type of ["keydown", "keypress", "keyup"]) {
                  target.dispatchEvent(
                    new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true }),
                  );
                }
                await sleep(300);
              } catch { }

              const linkHref = card.href || card.getAttribute("href") || "";
              console.log(`[Rewards] Clicked external link card: ${linkHref.substring(0, 80)}`);
              return true; // Caller detects new tabs separately
            }

            // For same-page navigation or in-page state changes
            try {
              dispatchPointerMouseSequence(target);
              await sleep(200);
              if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                return true;
              }
            } catch { }

            try {
              target.click();
              await sleep(250);
              if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                return true;
              }
            } catch { }

            // Keyboard fallback (Enter / Space)
            for (const key of ["Enter", " "]) {
              console.log("[Rewards-Debug] Keyboard Fallback: Attempting to trigger click via \'" + key + "\' key press...");
              try {
                const code = key === " " ? "Space" : key;
                try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch { } }
                for (const type of ["keydown", "keypress", "keyup"]) {
                  target.dispatchEvent(
                    new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true }),
                  );
                }
                await sleep(250);
                if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                  return true;
                }
              } catch { }
            }

            console.log("[Rewards-Debug] Fallback: Using document.elementFromPoint to find top-most element.");
            // elementFromPoint fallback
            const point = centerPoint(target);
            const topEl = document.elementFromPoint(point.clientX, point.clientY);
            if (
              topEl &&
              topEl instanceof HTMLElement &&
              topEl !== target &&
              (card.contains(topEl) || topEl.contains(card))
            ) {
              try {
                dispatchPointerMouseSequence(topEl);
                await sleep(200);
                if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                  return true;
                }
              } catch { }

              try {
                topEl.click();
                await sleep(250);
                if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                  return true;
                }
              } catch { }
            }

            return false;
          }

          let card = null;
          for (let attempt = 0; attempt < 20; attempt++) {
            const cardsList = (sectionIds || [])
              .map((sectionId) => collectSectionCardsById(sectionId))
              .flat();
            card = cardsList.find((a) => buildCardKey(a) === keyToClick);
            if (card) break;
            await sleep(800);
          }

          if (!card) {
            console.log(`[Rewards] Card not found for key: ${keyToClick.substring(0, 80)}`);
            return { clicked: false, href: "" };
          }

          console.log(`[Rewards] Found card to click directly, trying ${getClickableTargets(card).length} targets`);
          const targets = getClickableTargets(card);
          let success = false;
          for (const target of targets) {
            if (await tryActivateTarget(card, target)) {
              success = true;
              break;
            }
          }

          // Even if signature didn't change immediately, if we found targets, we attempted a click.
          // We rely on the background script fallback if no new tab opens.
          console.log("[Rewards-Debug] clickRewardCard: Final click outcome: success=" + success + ", targets=" + targets.length);
          if (!success && targets.length > 0) {
            success = true;
          }

          const finalHref = card.href || card.getAttribute("href") || card.querySelector("a[href]")?.getAttribute("href") || "";
          return { clicked: success, href: finalHref };
        },
      });

    return clickResult;
  }

  async function handleRewardChildTab(tabId) {
    try {
      const [{ result = { handled: false, completed: false, clicks: 0, reason: "unknown" } }] =
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: async () => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const normalizeText = (value) =>
              (value || "").replace(/\s+/g, " ").trim();

            const isVisible = (el) => {
              if (!el || typeof el.getBoundingClientRect !== "function") return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== "hidden" &&
                style.display !== "none"
              );
            };

            const isDisabled = (el) =>
              !el ||
              el.getAttribute("aria-disabled") === "true" ||
              !!el.closest("[aria-disabled='true'], [data-disabled='true']") ||
              el.disabled === true;

            const getPageText = () =>
              normalizeText(document.body?.innerText || document.body?.textContent || "").toLowerCase();

            const isQuizLikePage = () => {
              const url = location.href.toLowerCase();
              const title = (document.title || "").toLowerCase();
              const text = getPageText();
              return (
                /(?:[?&]form=dsetqu|[?&]form=quiz|wqoskey=|bingqa_|quizlanding|poll|isconversation)/i.test(url) ||
                /\b(quiz|poll|trivia)\b/i.test(title) ||
                /\b(quiz|poll|trivia)\b/i.test(text)
              );
            };

            const isQuizCompleted = () => {
              const text = getPageText();
              return /thanks for playing|come back tomorrow|you earned|quiz complete|all done|nice work|thank you for participating|great job|well done|you got|your score|test complete|cảm ơn bạn|hoàn thành|làm tốt lắm|谢谢|已完成|merci|danke|gracias|спасибо/i.test(text);
            };

            const clickElement = (el) => {
              if (!el) return false;
              try {
                el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
              } catch { }
              try {
                el.focus({ preventScroll: true });
              } catch {
                try {
                  el.focus();
                } catch { }
              }

              const rect = el.getBoundingClientRect();
              const common = {
                view: window,
                bubbles: true,
                cancelable: true,
                composed: true,
                button: 0,
                buttons: 1,
                clientX: rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2)),
                clientY: rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2)),
              };

              const steps = [
                ["pointerover", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse" }],
                ["pointerdown", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse", pressure: 0.5 }],
                ["mousedown", MouseEvent, {}],
                ["pointerup", PointerEvent, { pointerId: 1, isPrimary: true, pointerType: "mouse", pressure: 0 }],
                ["mouseup", MouseEvent, {}],
                ["click", MouseEvent, {}],
              ];

              for (const [type, Ctor, extra] of steps) {
                try {
                  const EventCtor =
                    Ctor === PointerEvent && typeof PointerEvent !== "function"
                      ? MouseEvent
                      : Ctor;
                  el.dispatchEvent(new EventCtor(type, { ...common, ...extra }));
                } catch { }
              }

              try {
                el.click();
              } catch { }
              return true;
            };

            const getCandidateText = (el) =>
              normalizeText(
                el.innerText || el.textContent || el.getAttribute("aria-label") || el.value || "",
              );

            const buildCandidates = () => {
              return Array.from(
                document.querySelectorAll(
                  "button, [role='button'], a[href], input[type='button'], input[type='submit'], label, [data-tag], [class*='option'], [class*='Option'], [class*='answer'], [class*='Answer'], [class*='choice'], [class*='Choice']",
                ),
              )
                .filter((el) => el instanceof HTMLElement)
                .filter((el) => isVisible(el) && !isDisabled(el))
                .map((el) => {
                  const text = getCandidateText(el);
                  let score = 0;
                  if (!text || text.length > 120) score -= 100;
                  if (/(^sign in$|^feedback$|^privacy$|^terms$|^rewards$|^search$|^images$|^videos$|^maps$|^news$|^all$|^back$|^more$|^menu$|^settings$|^share$|^copy$|^chat$)/i.test(text)) {
                    score -= 100;
                  }
                  // Strongly penalize non-quiz navigation
                  if (el.closest("nav, header, footer, [role='navigation'], [role='banner'], [role='contentinfo']")) {
                    score -= 80;
                  }
                  if (el.matches("button, [role='button'], input[type='button'], input[type='submit']")) {
                    score += 40;
                  }
                  if (el.closest("main, [role='main'], form, [class*='quiz'], [id*='quiz'], [class*='Quiz']")) {
                    score += 20;
                  }
                  if (text.length > 0 && text.length <= 80) score += 10;
                  if (/answer|option|choice|true|false|yes|no/i.test(text)) score += 15;
                  if (/start|play|begin|continue|next|submit|check answer|see results?|take the quiz|let's go/i.test(text)) score += 35;
                  if (el.closest(".btOption, .wk_option, .geSlide, #rc-poll-container, .poll-container")) score += 30;
                  // Boost Bing conversational quiz elements
                  if (el.matches("[data-tag], [class*='option'], [class*='Option']")) score += 25;
                  if (el.closest("[class*='BingQA'], [class*='quiz-container'], [id*='quiz-container'], [class*='trivia']")) score += 30;
                  // Boost numbered options (A., B., C., 1., 2., etc.)
                  if (/^\s*[A-Da-d1-4][.)\s]/i.test(text)) score += 20;
                  return { el, text, score };
                })
                .filter((item) => item.score > 0)
                .sort((a, b) => b.score - a.score);
            };

            if (!isQuizLikePage()) {
              return { handled: false, completed: false, clicks: 0, reason: "not_quiz" };
            }

            // Wait for quiz to fully initialize before starting
            await sleep(3000);

            let clicks = 0;
            let lastClickedText = "";
            let sameClickCount = 0;
            for (let attempt = 0; attempt < 25; attempt++) {
              if (isQuizCompleted()) {
                return { handled: true, completed: true, clicks, reason: "completed" };
              }

              const candidates = buildCandidates();
              if (!candidates.length) {
                await sleep(1500);
                continue;
              }

              // Avoid clicking the same element repeatedly (stale-click detection)
              let target = candidates[0];
              if (target.text === lastClickedText) {
                sameClickCount++;
                if (sameClickCount >= 3) {
                  // Try a different candidate if available
                  target = candidates.length > 1 ? candidates[1] : candidates[0];
                  sameClickCount = 0;
                }
              } else {
                sameClickCount = 0;
              }
              lastClickedText = target.text;

              clickElement(target.el);
              clicks++;
              await sleep(2500);
            }

            return {
              handled: true,
              completed: isQuizCompleted(),
              clicks,
              reason: isQuizCompleted() ? "completed" : "no_progress",
            };
          },
        });

      return result;
    } catch (e) {
      return { handled: false, completed: false, clicks: 0, reason: e?.message || "script_failed" };
    }
  }
  async function processRewardUrl(url) {
    let deadlineAt = Date.now() + REWARD_URL_TIMEOUT_MS;
    const timedOut = () => {
      if (Date.now() >= deadlineAt) {
        deadlineAt = Date.now() + REWARD_URL_TIMEOUT_MS; // reset so we don't spam
        return true;
      }
      return false;
    };

    console.log("[Rewards] Processing " + url);
    await appendDebugLog("info", "rewards", "Processing reward URL", { url });

    // Pin all tab operations to the same window to avoid jumping to another window
    const currentWindow = await chrome.windows.getCurrent();
    const windowId = currentWindow.id;
    console.log(`[Rewards] Pinned to window ${windowId}`);

    const tabsBefore = await chrome.tabs.query({ windowId });
    const baselineTabIds = new Set(
      tabsBefore.map((t) => t.id).filter((id) => Number.isInteger(id)),
    );
    const tab = await chrome.tabs.create({ url, active: true, windowId });
    await ensureTabFocused(tab.id);
    const spawnedTabIds = new Set();
    const onCreated = (createdTab) => {
      // Only track tabs spawned in our window
      if (Number.isInteger(createdTab.id) && createdTab.windowId === windowId) {
        spawnedTabIds.add(createdTab.id);
      }
    };
    chrome.tabs.onCreated.addListener(onCreated);

    try {
      await waitForTabComplete(tab.id);
      await ensureTabFocused(tab.id);
      await new Promise((r) => setTimeout(r, /rewards\.bing\.com\/dashboard/i.test(url) ? 8000 : 2000));

      // Inject helper functions into the page MAIN world so injected scripts can use them
      await injectDomHelpers(tab.id);

      if (/rewards\.bing\.com\/dashboard/i.test(url)) {
        await appendDebugLog("info", "rewards", "Scanning for ready-to-claim card on dashboard", { url });
        const claimResult = await claimReadyPoints(tab.id);
        if (claimResult.clicked) {
          console.log(
            `[Rewards] Claimed ${claimResult.claimedPoints} ready point(s) from dashboard`,
          );
          await appendDebugLog("success", "rewards", `Claimed ${claimResult.claimedPoints} ready point(s)`, {
            url,
            points: claimResult.claimedPoints,
          });
          await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));
          await chrome.tabs.reload(tab.id);
          await waitForTabComplete(tab.id);
          await injectDomHelpers(tab.id); // Re-inject after reload
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          console.log(
            `[Rewards] No ready points claimed on dashboard (${claimResult.reason || "not_available"})`,
          );
          await appendDebugLog("info", "rewards", "No ready-to-claim card found", {
            url,
            reason: claimResult.reason || "not_available",
          });
        }
      }

      if (/rewards\.bing\.com\/earn/i.test(url)) {
        const attemptedQuestKeys = new Set();
        const maxQuestCards = 8;

        for (let i = 0; i < maxQuestCards; i++) {
          if (timedOut()) {
            console.warn("[Rewards] Timeout budget reached while processing quest cards for " + url);
            await appendDebugLog("warn", "rewards", "Timeout budget reached for quest cards, continuing...", { url });
          }
          await appendDebugLog("info", "quests", "Scanning for quest cards", { url });
          console.log("[Rewards] processRewardUrl: Scanning for quest cards...");
          const questCardsResult = await getQuestCards(tab.id);
          const questCards = Array.isArray(questCardsResult) ? questCardsResult : [];
          const nextQuest = questCards.find((card) => !attemptedQuestKeys.has(card.key));

          if (!nextQuest) {
            console.log("[Rewards] No more quest cards found for " + url);
            break;
          }

          attemptedQuestKeys.add(nextQuest.key);
          console.log("[Rewards] Opening quest " + (i + 1) + ": " + nextQuest.href);
          await appendDebugLog("info", "quests", `Opening quest ${i + 1}`, { href: nextQuest.href });

          const clicked = await clickQuestCard(tab.id, nextQuest.href);
          if (!clicked) {
            console.log("[Rewards] Failed to click quest card " + nextQuest.href);
            continue;
          }

          await waitForTabComplete(tab.id);
          await ensureTabFocused(tab.id);
          await new Promise((r) => setTimeout(r, 2000));

          const attemptedActivityKeys = new Set();
          const maxQuestActivities = 10;

          for (let j = 0; j < maxQuestActivities; j++) {
            if (timedOut()) {
              console.warn("[Rewards] Timeout budget reached while processing quest activities for " + url);
              await appendDebugLog("warn", "rewards", "Timeout budget reached for quest activities, continuing...", { url });
            }
            await appendDebugLog("info", "quests", "Scanning for quest activities for " + nextQuest.href);
            console.log("[Rewards] processRewardUrl: Scanning for quest activities...");
            const questActivitiesResult = await getQuestActivities(tab.id);
            const questActivities = Array.isArray(questActivitiesResult)
              ? questActivitiesResult
              : [];
            const nextActivity = questActivities.find(
              (activity) => !attemptedActivityKeys.has(activity.key),
            );

            if (!nextActivity) {
              console.log("[Rewards] No more quest activities found for " + nextQuest.href);
              break;
            }

            attemptedActivityKeys.add(nextActivity.key);
            console.log(
              "[Rewards] Clicking quest activity " +
              (j + 1) +
              ": " +
              nextActivity.label +
              " (" +
              (nextActivity.href || "no_href") +
              ")",
            );

            const clickResult = await clickQuestActivity(tab.id, nextActivity.key);
            const wasClicked = typeof clickResult === "object" ? clickResult.clicked : clickResult;
            const targetHref = typeof clickResult === "object" ? clickResult.href : null;

            await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));

            const currentTabs = await chrome.tabs.query({ windowId });
            let newTabIds = currentTabs
              .map((t) => t.id)
              .filter((id) => Number.isInteger(id))
              .filter((id) => !baselineTabIds.has(id))
              .filter((id) => id !== tab.id);

            // Fallback: If no new tab opened, but we have a valid href, manually open it to register the punch
            if (newTabIds.length === 0 && wasClicked && (targetHref || nextActivity.href)) {
              let fullHref = targetHref || nextActivity.href;
              if (fullHref.startsWith("/")) {
                fullHref = "https://rewards.bing.com" + fullHref;
              }
              if (fullHref.startsWith("http")) {
                await appendDebugLog("warn", "quests", "DOM click failed, falling back to manual open", { url: fullHref });
                console.log("[Rewards] DOM click failed to open new tab, falling back to manual open: " + fullHref);
                try {
                  // MUST be active: true so Bing's tracking script on the search page fires!
                  const fallbackTab = await chrome.tabs.create({ url: fullHref, active: true, windowId });
                  newTabIds.push(fallbackTab.id);
                  await waitForTabComplete(fallbackTab.id);
                } catch (e) {
                  console.warn("[Rewards] Fallback tab creation failed:", e);
                }
              }
            }

            // Scroll like a human on each child tab before closing
            for (const childTabId of newTabIds) {
              try {
                // Ensure the tab is active so that tracking pixels fire properly
                await chrome.tabs.update(childTabId, { active: true });
                await waitForTabComplete(childTabId);
                await humanScrollOnTab(childTabId);
              } catch { }
            }

            if (newTabIds.length) {
              try {
                await chrome.tabs.remove(newTabIds);
                console.log(
                  "[Rewards] Closed " + newTabIds.length + " quest activity tab(s)",
                );
              } catch (e) {
                console.warn("[Rewards] Failed closing quest activity tab(s):", e);
              }
            }
          }

          await chrome.tabs.update(tab.id, { url, active: true });
          await waitForTabComplete(tab.id);
          await ensureTabFocused(tab.id);
          await injectDomHelpers(tab.id); // Re-inject after navigation
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // Determine which sections to click based on the current URL.
      // Do NOT include "global" — it scans the entire document and picks up
      // unrelated links (redeem, shop, etc.) that aren't reward cards.
      let targetSectionIds = rewardSectionIds;
      if (/rewards\.bing\.com\/earn/i.test(url)) {
        targetSectionIds = ["moreactivities", "keepearning"];
      } else if (/rewards\.bing\.com\/dashboard/i.test(url)) {
        targetSectionIds = ["dailyset", "daily-sets", "dailypointitem", "moreactivities"];
      }

      // Collect all reward cards once, click through each one, then move on.
      // The second rewards pass after searches will handle any remaining cards.
      const rewardCardsResult = await getRewardCards(tab.id, targetSectionIds);
      const rewardCards = Array.isArray(rewardCardsResult) ? rewardCardsResult : [];
      await appendDebugLog("info", "rewards", `Found ${rewardCards.length} reward card(s) to click`, {
        url,
        cards: rewardCards.map((c) => c.key.substring(0, 60)).join(" | "),
      });

      for (let i = 0; i < rewardCards.length; i++) {
        if (timedOut()) {
          console.warn("[Rewards] Timeout budget reached while clicking reward cards for " + url);
          await appendDebugLog("warn", "rewards", "Timeout budget reached for reward cards, continuing...", { url, processed: i, total: rewardCards.length });
        }

        const card = rewardCards[i];
        console.log(`[Rewards] Clicking reward card ${i + 1}/${rewardCards.length}: ${card.href}`);
        await appendDebugLog("info", "rewards", `Clicking card ${i + 1}/${rewardCards.length}`, {
          href: card.href.substring(0, 80),
        });

        const clickResult = await clickRewardCard(tab.id, card.key, targetSectionIds);
        const wasClicked = typeof clickResult === "object" ? clickResult.clicked : clickResult;

        await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));

        // Collect and scroll child tabs that were spawned before closing
        const currentTabs = await chrome.tabs.query({ windowId });
        const newTabIds = currentTabs
          .map((t) => t.id)
          .filter((id) => Number.isInteger(id))
          .filter((id) => !baselineTabIds.has(id))
          .filter((id) => id !== tab.id);

        if (newTabIds.length === 0 && wasClicked && card.href) {
          let fullHref = card.href;
          if (fullHref.startsWith("/")) {
            fullHref = "https://rewards.bing.com" + fullHref;
          }
          if (fullHref.startsWith("http")) {
            await appendDebugLog("warn", "quests", "DOM click failed, falling back to manual open", { url: fullHref });
            console.log("[Rewards] DOM click failed to open new tab, falling back to manual open: " + fullHref);
            try {
              const fallbackTab = await chrome.tabs.create({ url: fullHref, active: true, windowId });
              newTabIds.push(fallbackTab.id);
              await waitForTabComplete(fallbackTab.id);
            } catch (e) {
              console.warn("[Rewards] Fallback tab creation failed:", e);
            }
          }
        }

        // Scroll like a human on each child tab so Bing registers the visit
        for (const childTabId of newTabIds) {
          try {
            await chrome.tabs.update(childTabId, { active: true });
            await waitForTabComplete(childTabId);
            await humanScrollOnTab(childTabId);
          } catch { }
        }

        // Close child tabs after scrolling
        if (newTabIds.length) {
          try {
            await chrome.tabs.remove(newTabIds);
            console.log(`[Rewards] Closed ${newTabIds.length} child tab(s) from card ${i + 1}`);
          } catch (e) {
            console.warn("[Rewards] Failed closing child tab(s):", e);
          }
        }

        console.log(`[Rewards] Card ${i + 1}/${rewardCards.length} done (clicked=${wasClicked}, childTabs=${newTabIds.length})`);
        await appendDebugLog("info", "rewards", `Card ${i + 1} done`, {
          href: card.href.substring(0, 80),
          clicked: wasClicked,
          childTabs: newTabIds.length,
        });

        // Navigate back to rewards page for the next card
        if (i < rewardCards.length - 1) {
          await chrome.tabs.update(tab.id, { url, active: true });
          await waitForTabComplete(tab.id);
          await ensureTabFocused(tab.id);
          await injectDomHelpers(tab.id); // Re-inject after navigation
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } finally {
      chrome.tabs.onCreated.removeListener(onCreated);
      if (tab.id) {
        if (spawnedTabIds.size) {
          try {
            const idsToClose = [...spawnedTabIds].filter((id) => id !== tab.id);
            if (idsToClose.length) {
              await chrome.tabs.remove(idsToClose);
            }
            console.log(
              `[Rewards] Closed ${idsToClose.length} tracked spawned tab(s) from ${url}`,
            );
          } catch (e) {
            console.warn(
              `[Rewards] Failed closing tracked spawned tab(s) from ${url}:`,
              e,
            );
          }
        }
        await closeChildTabs(tab.id, 4, 1200, windowId);
        await closeNewRewardTabs(baselineTabIds, [tab.id], 4, 1200, windowId);
        try {
          await chrome.tabs.remove(tab.id);
          console.log(`[Rewards] Closed tab for ${url}`);
        } catch (e) {
          console.warn(`[Rewards] Failed to close tab for ${url}:`, e);
        }
      }
    }
  }

  for (const url of rewardUrls) {
    try {
      await processRewardUrl(url);
      console.log(`[Rewards] Finished processing ${url}`);
      await appendDebugLog("success", "rewards", /dashboard/i.test(url) ? "Dashboard completed" : /earn/i.test(url) ? "Earn completed" : "Reward URL completed", { url });
    } catch (e) {
      console.warn(`[Rewards] Processing failed for ${url}:`, e);
      await appendDebugLog("error", "rewards", "Reward URL failed", { url, error: String(e) });
    }
  }
}
// ---------------- Bing search logic ----------------
async function typeInBing(query, perCharDelayMs = 80) {
  console.log("[Search-Debug] typeInBing: Starting typing simulation for query: " + query);
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  const input = document.querySelector("#sb_form_q, input[name='q']");
  if (!input) return { ok: false, reason: "input_not_found" };
  input.focus();
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  for (const ch of query.split("")) {
    input.value += ch;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(perCharDelayMs + Math.floor(Math.random() * 60));
  }
  const evOpts = (type) => ({
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
  });
  input.dispatchEvent(new KeyboardEvent("keydown", evOpts("keydown")));
  input.dispatchEvent(new KeyboardEvent("keypress", evOpts("keypress")));
  input.dispatchEvent(new KeyboardEvent("keyup", evOpts("keyup")));
  console.log("[Search-Debug] typeInBing: Finished typing, simulating Enter and submitting form.");
  const form = input.closest("form");
  if (form) form.submit();
  return { ok: true };
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    const t = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearInterval(t);
        reject(new Error("timeout waiting for tab load"));
      } else {
        let tInfo; try { tInfo = await chrome.tabs.get(tabId); } catch (e) { chrome.tabs.onUpdated.removeListener(onUpdated); clearInterval(t); return reject(e); }
        if (tInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          clearInterval(t);
          resolve();
        }
      }
    }, 200);
  });
}

async function openBingAndType(query) {
  // Resolve windowId once and reuse across the search session
  if (!singletonWindowId) {
    const currentWindow = await chrome.windows.getCurrent();
    singletonWindowId = currentWindow.id;
  }

  let tabId = singletonTabId;
  if (tabId) {
    try {
      await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, {
        url: "https://www.bing.com/",
        active: true,
      });
    } catch {
      const created = await chrome.tabs.create({
        url: "https://www.bing.com/",
        active: true,
        windowId: singletonWindowId,
      });
      tabId = created.id;
      singletonTabId = tabId;
    }
  } else {
    const created = await chrome.tabs.create({
      url: "https://www.bing.com/",
      active: true,
      windowId: singletonWindowId,
    });
    tabId = created.id;
    singletonTabId = tabId;
  }

  try {
    await waitForTabComplete(tabId);
    await ensureTabFocused(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: typeInBing,
      args: [query, 80],
    });
  } catch (e) {
    const url = "https://www.bing.com/search?q=" + encodeURIComponent(query);
    await chrome.tabs.update(tabId, { url, active: true });
  }
}

/**
 * Simulate human-like browsing on a Bing search results page.
 * - Scrolls through results in random increments with pauses
 * - Hovers over random result links
 * - Occasionally clicks a result, reads the page, then goes back
 */
async function humanBrowseSearchResults(tabId) {
  try {
    await waitForTabComplete(tabId, 15000);
    await new Promise((r) => setTimeout(r, 1500));

    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 900;
        const pageHeight = Math.max(
          document.body.scrollHeight || 0,
          document.documentElement.scrollHeight || 0,
          viewportHeight,
        );
        const maxScroll = Math.max(0, pageHeight - viewportHeight);

        // --- Phase 1: Scroll down through results (2–5 steps) ---
        let currentY = window.scrollY || 0;
        const downSteps = rand(2, 5);
        for (let i = 0; i < downSteps; i++) {
          const scrollAmount = rand(
            Math.floor(viewportHeight * 0.25),
            Math.floor(viewportHeight * 0.7),
          );
          const targetY = Math.min(currentY + scrollAmount, maxScroll);
          window.scrollTo({ top: targetY, behavior: "smooth" });
          currentY = targetY;
          // Reading pause
          await sleep(rand(600, 2200));
          if (currentY >= maxScroll) break;
        }

        // --- Phase 2: Hover over random result links ---
        const resultLinks = Array.from(
          document.querySelectorAll(
            "#b_results a[href]:not([href^='javascript']), .b_algo a[href], ol#b_results h2 a",
          ),
        ).filter((el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        });

        const hoverCount = rand(2, Math.min(5, resultLinks.length));
        const shuffled = resultLinks.sort(() => Math.random() - 0.5).slice(0, hoverCount);

        for (const link of shuffled) {
          try {
            link.scrollIntoView({ behavior: "smooth", block: "center" });
            await sleep(rand(300, 800));

            const rect = link.getBoundingClientRect();
            const cx = rect.left + rand(5, Math.max(6, rect.width - 5));
            const cy = rect.top + rand(2, Math.max(3, rect.height - 2));
            const common = { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy };

            link.dispatchEvent(new MouseEvent("mouseover", common));
            link.dispatchEvent(new MouseEvent("mouseenter", { ...common, bubbles: false }));
            link.dispatchEvent(new MouseEvent("mousemove", common));
            // Dwell on the link like reading the title
            await sleep(rand(400, 1500));
            link.dispatchEvent(new MouseEvent("mouseleave", { ...common, bubbles: false }));
            link.dispatchEvent(new MouseEvent("mouseout", common));
          } catch { }
          await sleep(rand(200, 600));
        }

        // --- Phase 3: Occasionally click a result (~30% chance) ---
        const shouldClick = Math.random() < 0.3 && resultLinks.length > 0;
        if (shouldClick) {
          // Pick a random top-5 result (more likely to click top results)
          const topResults = resultLinks.slice(0, Math.min(5, resultLinks.length));
          const target = topResults[rand(0, topResults.length - 1)];
          if (target) {
            try {
              target.scrollIntoView({ behavior: "smooth", block: "center" });
              await sleep(rand(300, 700));

              const rect = target.getBoundingClientRect();
              const cx = rect.left + rand(5, Math.max(6, rect.width - 5));
              const cy = rect.top + rand(2, Math.max(3, rect.height - 2));
              const common = {
                view: window, bubbles: true, cancelable: true, composed: true,
                button: 0, buttons: 1, clientX: cx, clientY: cy,
              };

              // Full click sequence
              target.dispatchEvent(new MouseEvent("mouseover", common));
              target.dispatchEvent(new MouseEvent("mousemove", common));
              await sleep(rand(50, 200));
              target.dispatchEvent(new MouseEvent("mousedown", common));
              await sleep(rand(50, 150));
              target.dispatchEvent(new MouseEvent("mouseup", common));
              target.dispatchEvent(new MouseEvent("click", common));

              // Wait as if reading the page
              await sleep(rand(3000, 8000));

              // Go back to search results
              window.history.back();
              await sleep(rand(1000, 2500));
            } catch { }
          }
        }

        // --- Phase 4: Scroll back up partially ---
        const upSteps = rand(1, 2);
        for (let i = 0; i < upSteps; i++) {
          const scrollAmount = rand(
            Math.floor(viewportHeight * 0.2),
            Math.floor(viewportHeight * 0.5),
          );
          const targetY = Math.max((window.scrollY || 0) - scrollAmount, 0);
          window.scrollTo({ top: targetY, behavior: "smooth" });
          await sleep(rand(300, 900));
        }

        // --- Phase 5: Small random mouse movements ---
        for (let i = 0; i < rand(1, 3); i++) {
          try {
            document.dispatchEvent(
              new MouseEvent("mousemove", {
                clientX: rand(80, window.innerWidth - 80),
                clientY: rand(80, window.innerHeight - 80),
                bubbles: true,
              }),
            );
          } catch { }
          await sleep(rand(150, 500));
        }
      },
    });

    console.log(`[Search] Human browse completed on tab ${tabId}`);
  } catch (e) {
    console.warn(`[Search] Human browse failed on tab ${tabId}:`, e?.message || e);
  }
}

// ---------------- Run task ----------------
async function runTask() {
  const cfg = await getConfig();
  if (!cfg.enabled) return;

  // 1. First run rewards auto-click
  await autoClickRewards();
  await appendDebugLog("success", "rewards", "Rewards phase completed");

  await appendDebugLog("info", "search", "Search phase started");

  // 2. Then continue with Bing searches — use awaited loop so the
  //    service worker keepalive stays active until every search finishes.
  const queries = getQueryList(cfg);

  await chrome.storage.sync.set({
    running: true,
    runEndsAt: null,
    nextOpenAt: Date.now(),
  });
  await updateBadge();
  await ensureRunTicker();

  for (let idx = 0; idx < queries.length; idx++) {
    const delaySecs = randomDelay(cfg.intervalMin, cfg.intervalMax);
    const nextOpenAt = Date.now() + delaySecs * 1000;
    await chrome.storage.sync.set({ nextOpenAt });
    await updateBadge();

    // Wait for the random delay before opening the next search
    await new Promise((r) => setTimeout(r, delaySecs * 1000));

    await appendDebugLog("info", "search", "Search opened", {
      query: queries[idx],
      index: idx + 1,
      total: queries.length,
    });
    await openBingAndType(queries[idx]);

    // Simulate human browsing on ~60% of searches (vary behavior)
    if (singletonTabId && Math.random() < 0.6) {
      try {
        await humanBrowseSearchResults(singletonTabId);
      } catch { }
    }
  }

  await chrome.storage.sync.set({ nextOpenAt: null });
  await appendDebugLog("success", "search", "Search phase completed", {
    totalQueries: queries.length,
  });

  // 3. Final sweep for rewards (second pass)
  console.log("⚡ Running second pass for Bing Rewards auto click...");
  await appendDebugLog("info", "rewards", "Second Rewards phase started");
  try {
    await autoClickRewards();
    await appendDebugLog("success", "rewards", "Second Rewards phase completed");
  } catch (e) {
    console.warn("[Rewards] Second pass failed:", e);
    await appendDebugLog("error", "rewards", "Second Rewards phase failed: " + e.message);
  }

  await chrome.storage.sync.set({
    running: false,
    runEndsAt: null,
    nextOpenAt: null,
  });
  // Reset window pinning for next run
  singletonWindowId = null;
  await updateBadge();
  await ensureRunTicker();
}

async function startRun(source = "unknown") {
  if (runPromise) {
    console.log(`[Run] Skip ${source}; a run is already in progress.`);
    await appendDebugLog("warn", "run", "Run skipped because another run is active", { source });
    return runPromise;
  }
  runPromise = (async () => {
    try {
      console.log(`[Run] Started from ${source}`);
      await appendDebugLog("info", "run", "Run started", { source });
      await startKeepAlive();
      await runTask();
    } catch (e) {
      console.error(`[Run] Failed from ${source}:`, e);
      await appendDebugLog("error", "run", "Run failed", { source, error: String(e) });
    } finally {
      await stopKeepAlive();
      runPromise = null;
      console.log(`[Run] Finished from ${source}`);
      await appendDebugLog("info", "run", "Run finished", { source });
    }
  })();
  return runPromise;
}

// ---------------- Scheduling ----------------
async function scheduleAlarm() {
  const cfg = await getConfig();
  await chrome.alarms.clear(ALARM_NAME);

  if (!cfg.enabled) {
    await chrome.storage.sync.set({ nextRunAt: null });
    await updateBadge();
    return;
  }

  const next = computeNextRunDate(cfg.time);
  chrome.alarms.create(ALARM_NAME, { when: next.getTime() });
  await chrome.storage.sync.set({ nextRunAt: next.getTime() });
  await updateBadge();
  console.log("Next run scheduled at:", next.toString());
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // No-op ping to prevent MV3 service worker from being terminated
    return;
  }
  if (alarm.name === ALARM_NAME) {
    await startRun("alarm");
    await scheduleAlarm();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  const relevant = [
    "enabled",
    "time",
    "searchesPerRun",
    "intervalMin",
    "intervalMax",
    "customQueriesRaw",
  ];
  if (relevant.some((k) => k in changes)) {
    scheduleAlarm();
  }
  if (
    "nextRunAt" in changes ||
    "running" in changes ||
    "nextOpenAt" in changes
  ) {
    updateBadge();
    ensureRunTicker();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "RESCHEDULE") {
    scheduleAlarm()
      .then(() => sendResponse?.({ ok: true }))
      .catch((e) => sendResponse?.({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "RUN_NOW") {
    startRun("run_now")
      .then(() => sendResponse?.({ ok: true }))
      .catch((e) => sendResponse?.({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "CLEAR_DEBUG_LOGS") {
    clearDebugLogs()
      .then(() => sendResponse?.({ ok: true }))
      .catch((e) => sendResponse?.({ ok: false, error: String(e) }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm();
  updateBadge();
  ensureRunTicker();
});

scheduleAlarm();
updateBadge();













