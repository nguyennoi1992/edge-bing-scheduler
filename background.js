// Use as an ES module for MV3 service worker
import { buildQueries } from "./words.js";
import {
  EMPTY_REWARD_STABLE_MS,
  QUIZ_COMPLETION_RE,
  buildQuestActivityKey,
  buildQuestCardKey,
  buildRewardCardKey,
  isActionableQuestActivity,
  isActionableRewardCard,
  isCompletedText,
  isDashboardRewardHref,
  normalizeRewardText,
  shouldFinishEmptyRewardScan,
} from "./reward-dom-helpers.js";
import { getFirstScriptResult } from "./script-result-helpers.js";

const ALARM_NAME = "bingScheduler";
const BADGE_ALARM = "badgeTick";
const REWARDS_SETTLE_MS = 8000;
const REWARD_CHILD_SYNC_MS = 5000;
const REWARD_URL_TIMEOUT_MS = 480000;
const DEBUG_LOGS_KEY = 'debugLogs';
const DEBUG_LOG_RETENTION_DAYS = 7;
const DEBUG_LOG_RETENTION_MS = DEBUG_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const KEEPALIVE_ALARM = "keepAlive";
const DEFAULT_RUN_TIME = "01:00";
const INTERNET_RETRY_ALARM = "internetRetry";
const DELAYED_START_ALARM = "delayedStartRun";
const INTERNET_RETRY_MINUTES = 1;
const PROFILE_SLOT_MAX = 100;
const SLOT_SPACING_MINUTES = 10;
const DELAYED_RUN_SOURCE_KEY = "delayedRunSource";
const LAST_SUCCESSFUL_RUN_DATE_KEY = "lastSuccessfulRunDate";
const INTERNET_CHECK_URLS = [
  "https://www.bing.com/favicon.ico",
  "https://www.google.com/generate_204",
  "https://www.cloudflare.com/cdn-cgi/trace",
];
const INTERNET_CHECK_TIMEOUT_MS = 10000;
const TAB_LOAD_TIMEOUT_MS = 30000;
const TAB_LOAD_MAX_ATTEMPTS = 3;

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
  time: DEFAULT_RUN_TIME, // 24h HH:MM
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

function normalizeProfileSlot(value) {
  const slot = Number.parseInt(value, 10);
  if (!Number.isFinite(slot) || slot < 1 || slot > PROFILE_SLOT_MAX) return 0;
  return slot;
}

async function getProfileSlot() {
  const data = await chrome.storage.local.get({ profileSlot: 0 });
  return normalizeProfileSlot(data.profileSlot);
}

function getSlotOffsetMinutes(slot) {
  const normalizedSlot = normalizeProfileSlot(slot);
  return normalizedSlot > 0 ? (normalizedSlot - 1) * SLOT_SPACING_MINUTES : 0;
}

function computeNextRunDate(timeHHMM, slotOffsetMinutes = 0) {
  const [hour, minute] = (timeHHMM || DEFAULT_RUN_TIME).split(":").map(Number);
  const now = new Date();
  const next = new Date();
  next.setHours(hour || 0, minute || 0, 0, 0);
  next.setMinutes(next.getMinutes() + Math.max(0, slotOffsetMinutes));
  const previous = new Date(next);
  previous.setDate(previous.getDate() - 1);
  if (previous > now) return previous;
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function hasRunToday() {
  const today = getLocalDateKey();
  const data = await chrome.storage.local.get(LAST_SUCCESSFUL_RUN_DATE_KEY);
  return data[LAST_SUCCESSFUL_RUN_DATE_KEY] === today;
}

async function markRunCompletedToday() {
  await chrome.storage.local.set({
    [LAST_SUCCESSFUL_RUN_DATE_KEY]: getLocalDateKey(),
  });
}

async function isInternetAvailable() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return false;
  }

  const failures = [];
  for (const url of INTERNET_CHECK_URLS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INTERNET_CHECK_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      return true;
    } catch (e) {
      failures.push(`${url}: ${e?.message || e}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  console.warn("[Internet] Connectivity check failed:", failures.join("; "));
  return false;
}

async function scheduleInternetRetry(reason = "unknown") {
  const when = Date.now() + INTERNET_RETRY_MINUTES * 60 * 1000;
  await chrome.alarms.create(INTERNET_RETRY_ALARM, { when });
  await appendDebugLog("warn", "internet", "Internet unavailable; retry scheduled", {
    reason,
    retryAt: when,
  });
}

async function clearInternetRetry() {
  await chrome.alarms.clear(INTERNET_RETRY_ALARM);
}

async function clearDelayedStart() {
  await chrome.alarms.clear(DELAYED_START_ALARM);
  await chrome.storage.local.remove(DELAYED_RUN_SOURCE_KEY);
}

async function scheduleStaggeredStart(source) {
  if (await hasRunToday()) {
    await clearDelayedStart();
    return;
  }

  const profileSlot = await getProfileSlot();
  const slotOffsetMinutes = getSlotOffsetMinutes(profileSlot);
  if (slotOffsetMinutes === 0) {
    await startRun(source);
    return;
  }

  const existingAlarm = await chrome.alarms.get(DELAYED_START_ALARM);
  if (existingAlarm) {
    await appendDebugLog("info", "scheduler", "Delayed start already scheduled", {
      profileSlot,
      slotOffsetMinutes,
      source,
      scheduledAt: existingAlarm.scheduledTime,
    });
    return;
  }

  const scheduledAt = Date.now() + slotOffsetMinutes * 60 * 1000;
  await chrome.storage.local.set({ [DELAYED_RUN_SOURCE_KEY]: source });
  await chrome.alarms.create(DELAYED_START_ALARM, { when: scheduledAt });
  await appendDebugLog("info", "scheduler", "Staggered start scheduled", {
    profileSlot,
    slotOffsetMinutes,
    source,
    scheduledAt,
  });
}

function createInternetUnavailableError(context) {
  const err = new Error(`Internet unavailable during ${context}`);
  err.name = "InternetUnavailableError";
  return err;
}

function isInternetUnavailableError(err) {
  return err?.name === "InternetUnavailableError";
}

async function ensureInternetOrThrow(context) {
  if (await isInternetAvailable()) return;
  await appendDebugLog("error", "internet", "Internet unavailable", { context });
  throw createInternetUnavailableError(context);
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
 * window.normalizeRewardText, window.buildQuestCardKey, window.buildRewardCardKey, etc.
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
    args: [EMPTY_REWARD_STABLE_MS],
    func: (emptyRewardStableMs) => {
      const helpersReady =
        typeof window.normalizeRewardText === "function" &&
        typeof window.isCompletedText === "function" &&
        typeof window.isActionableRewardCard === "function" &&
        typeof window.buildRewardCardKey === "function" &&
        typeof window.buildQuestCardKey === "function" &&
        typeof window.isActionableQuestActivity === "function" &&
        typeof window.buildQuestActivityKey === "function" &&
        typeof window.isDashboardRewardHref === "function" &&
        typeof window.shouldFinishEmptyRewardScan === "function";
      if (window.__rewardDomHelpersInjected && helpersReady) return;
      window.__rewardDomHelpersInjected = true;

      window.normalizeRewardText = function normalizeRewardText(value) {
        return (value || "").replace(/\s+/g, " ").trim();
      };

      const COMPLETED_RE =
        /\bcompleted\b|\bdone\b|ho\u00e0n th\u00e0nh|\u0111\u00e3 xong|\u5df2\u5b8c\u6210|\u5b8c\u4e86|termin\u00e9|abgeschlossen|completado|\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e/i;

      window.isCompletedText = function isCompletedText(value) {
        return COMPLETED_RE.test(window.normalizeRewardText(value).toLowerCase());
      };

      window.isDashboardRewardHref = function isDashboardRewardHref(href) {
        const value = href || "";
        return (
          /^https:\/\/(?:www\.)?bing\.com\//i.test(value) ||
          /(?:[?&]rnoreward=1\b|rewardsquiz_dailyset|global_dailyset|form=dsetqu|publ=RewardsDO|wqoskey=)/i.test(value)
        );
      };

      window.shouldFinishEmptyRewardScan = function shouldFinishEmptyRewardScan({
        readyState,
        hasTargetSection,
        count,
        stableEmptyMs,
        requiredStableMs = emptyRewardStableMs,
      } = {}) {
        return (
          readyState === "complete" &&
          hasTargetSection === true &&
          count === 0 &&
          stableEmptyMs >= requiredStableMs
        );
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
  const rewardSectionIds = ["moreactivities"];
  const rewardUrls = [
    "https://rewards.bing.com/earn",
    "https://rewards.bing.com/dashboard",
  ];

  async function claimReadyPoints(tabId) {
    const scriptResults =
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

    return getFirstScriptResult(scriptResults, {
      clicked: false,
      claimedPoints: 0,
      reason: "missing_result",
    });
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
        const closedIds = [];
        const missingIds = [];
        const failedIds = [];
        const errors = [];
        for (const childId of childIds) {
          try {
            await chrome.tabs.get(childId);
          } catch {
            missingIds.push(childId);
            continue;
          }
          try {
            await chrome.tabs.remove(childId);
            try {
              await chrome.tabs.get(childId);
              failedIds.push(childId);
              errors.push({ tabId: childId, error: "tab_still_exists_after_remove" });
            } catch {
              closedIds.push(childId);
            }
          } catch (e) {
            failedIds.push(childId);
            errors.push({ tabId: childId, error: String(e?.message || e) });
          }
        }
        const logLevel = failedIds.length ? "warn" : "info";
        await appendDebugLog(logLevel, "rewards", "Descendant reward tab cleanup result", {
          parentTabId,
          round: i + 1,
          requestedIds: childIds,
          closedIds,
          missingIds,
          failedIds,
          errors,
        });
      } else {
        await appendDebugLog("info", "rewards", "No descendant reward tabs found", {
          parentTabId,
          round: i + 1,
        });
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

  async function waitForRewardSearchCredit(tabId, waitMs = 12000) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab?.url || "";
      if (!/https:\/\/www\.bing\.com\/search/i.test(url)) return;

      await appendDebugLog("info", "rewards", "Waiting for Bing search reward credit", {
        url: url.substring(0, 120),
        waitMs,
      });
      await chrome.tabs.update(tabId, { active: true });
      await ensureTabFocused(tabId);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } catch (e) {
      console.warn("[Rewards] Failed while waiting for search reward credit:", e?.message || e);
    }
  }

  async function waitForRewardsDomReady(tabId, targetSectionIds = [], timeoutMs = 45000) {
    await injectDomHelpers(tabId);
    try {
      await waitForTabComplete(tabId);
      await ensureTabFocused(tabId);

      const scriptRes =
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [targetSectionIds || rewardSectionIds, timeoutMs],
          func: async (sectionIds, maxWaitMs) => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const startedAt = Date.now();
            const pollMs = 1500;
            let attempts = 0;
            let prevCount = -1;
            let stableRounds = 0;
            let stableEmptySince = null;
            let last = {
              readyState: document.readyState,
              hasDailyset: false,
              hasTargetSection: false,
              sectionCards: 0,
              fallbackCards: 0,
              count: 0,
              attempts: 0,
              stableEmptySince: null,
              stableEmptyMs: 0,
            };

            const normalizeText = (value) =>
              (window.normalizeRewardText || ((v) => (v || "").replace(/\s+/g, " ").trim()))(value);
            const completedText = (value) =>
              (window.isCompletedText || ((v) => /\bcompleted\b|\bdone\b|ho\u00e0n th\u00e0nh|\u0111\u00e3 xong/i.test(normalizeText(v).toLowerCase())))(value);

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

            const expandSectionIfCollapsed = (section) => {
              if (!section) return;
              const triggers = section.querySelectorAll(
                "button[slot='trigger'][aria-expanded='false'], button[aria-expanded='false'][aria-controls]",
              );
              for (const trigger of triggers) {
                try { trigger.click(); } catch { }
              }
            };

            const isPendingCard = (anchor) => {
              if (!isVisible(anchor)) return false;
              if (anchor.closest("nav, header, footer, [role='banner'], #quests")) return false;
              if (anchor.getAttribute("aria-disabled") === "true" || anchor.closest("[aria-disabled='true'], [data-disabled='true']")) {
                return false;
              }
              const text = normalizeText(anchor.innerText || anchor.textContent || "");
              if (!text || completedText(text)) return false;
              if (/^(see more tasks|earn more)$/i.test(text)) return false;
              if (!anchor.querySelector("img, mee-icon, svg, .mee-icon, [class*='icon'], [class*='Icon'], picture")) return false;
              return true;
            };

            const countSectionCards = (section) => {
              if (!section) return 0;
              expandSectionIfCollapsed(section);
              try { section.scrollIntoView({ behavior: "instant", block: "center" }); } catch { }
              return Array.from(
                section.querySelectorAll("a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault'], a[href][data-react-aria-pressable='true']"),
              ).filter(isPendingCard).length;
            };

            const countFallbackCards = () =>
              Array.from(
                document.querySelectorAll("a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault'], a[href][data-react-aria-pressable='true']"),
              )
                .filter((anchor) => window.isDashboardRewardHref(anchor.href || anchor.getAttribute("href") || ""))
                .filter(isPendingCard)
                .length;

            while (Date.now() - startedAt < maxWaitMs) {
              attempts++;
              const ids = Array.isArray(sectionIds) ? sectionIds : [];
              const sections = ids
                .filter((id) => id && id !== "global")
                .map((id) => document.querySelector(`#${id}`))
                .filter(Boolean);
              const dailyset = document.querySelector("#dailyset");
              const sectionCards = sections.reduce((sum, section) => sum + countSectionCards(section), 0);
              const fallbackCards =
                (
                  (ids.includes("dailyset") && /rewards\.bing\.com\/dashboard/i.test(location.href)) ||
                  (ids.includes("moreactivities") && /rewards\.bing\.com\/earn/i.test(location.href))
                )
                  ? countFallbackCards()
                  : 0;
              const count = Math.max(sectionCards, fallbackCards);
              const hasTargetSection = sections.length > 0;

              const now = Date.now();
              if (document.readyState === "complete" && hasTargetSection && count === 0) {
                if (stableEmptySince === null) stableEmptySince = now;
              } else {
                stableEmptySince = null;
              }
              const stableEmptyMs = stableEmptySince === null ? 0 : now - stableEmptySince;

              last = {
                readyState: document.readyState,
                hasDailyset: !!dailyset,
                hasTargetSection,
                sectionCards,
                fallbackCards,
                count,
                attempts,
                stableEmptySince,
                stableEmptyMs,
              };

              if (document.readyState === "complete" && count > 0) {
                if (count === prevCount) {
                  stableRounds++;
                } else {
                  stableRounds = 0;
                }
                if (stableRounds >= 1) {
                  return { ready: true, stableRounds, ...last };
                }
              } else {
                stableRounds = 0;
              }

              if (window.shouldFinishEmptyRewardScan(last)) {
                return { ready: true, reason: "stable_empty", stableRounds, ...last };
              }

              prevCount = count;
              await sleep(pollMs);
            }

            return { ready: false, reason: "timeout", stableRounds, ...last };
          },
        });

      const result = getFirstScriptResult(scriptRes, {
        ready: false,
        count: 0,
        reason: "missing_result",
      });
      await appendDebugLog(result.ready ? "info" : "warn", "rewards", "Rewards DOM ready check", {
        tabId,
        timeoutMs,
        ...result,
      });
      return result;
    } catch (e) {
      await appendDebugLog("warn", "rewards", "Rewards DOM ready check failed", {
        tabId,
        error: String(e?.message || e),
      });
      return { ready: false, reason: String(e?.message || e) };
    }
  }

  async function getQuestCards(tabId) {
    await injectDomHelpers(tabId);
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

            const linkText = window.normalizeRewardText(node.innerText || node.textContent || "");
            if (!linkText) continue;

            const key = window.buildQuestCardKey({ href, text: linkText });

            // Dedup by actual href (stable) to avoid re-processing the same quest
            // when dynamic text like "2/7 tasks" changes to "4/7 tasks" after activities.
            if (seen.has(href)) continue;
            seen.add(href);

            items.push({
              href: key,   // kept for clickQuestCard matching
              key: key,
              actualHref: href, // stable key for attemptedQuestKeys dedup
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
    await injectDomHelpers(tabId);
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
              const linkText = window.normalizeRewardText(el.innerText || el.textContent || "");
              const key = window.buildQuestCardKey({ href, text: linkText });
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
    await injectDomHelpers(tabId);
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
            (el) => isVisible(el) && /activities|hoạt động|tareas|activités|aufgaben/i.test(window.normalizeRewardText(el.textContent)),
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

          const candidates = Array.from(
            activitiesRoot.querySelectorAll(
              "a[href], button, [role='button'], [role='link'], [data-react-aria-pressable='true'], .rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']"
            )
          );
          
          const uniqueCards = new Set();
          const activityCards = [];
          for (const cand of candidates) {
            const card = cand.closest(".rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']") || cand;
            if (!uniqueCards.has(card) && isVisible(card) && !card.closest("#quests")) {
              uniqueCards.add(card);
              activityCards.push(card);
            }
          }
          console.log("[Rewards-Debug] getQuestActivities: Found " + activityCards.length + " activity cards inside root. Filtering actionable ones...");

          const seen = new Set();
          const items = [];
          for (const card of activityCards) {
            const cardText = window.normalizeRewardText(card.innerText || card.textContent || "");
            const actionTarget =
              card.querySelector("button:not([aria-disabled='true']), [role='button']:not([aria-disabled='true']), a[href], [role='link'], [data-react-aria-pressable='true']") ||
              card;
            const href = actionTarget.href || actionTarget.getAttribute("href") || "";
            const innerLabel = window.normalizeRewardText(actionTarget.innerText || actionTarget.textContent || cardText);
            const ariaLabel = window.normalizeRewardText(actionTarget.getAttribute("aria-label") || "");
            const label = ariaLabel || innerLabel || cardText;
            const isCompleted =
              !!card.closest("[class*='completed'], [class*='Success']") ||
              !!card.querySelector("svg[class*='Success'], mee-icon[class*='Success']") ||
              window.isCompletedText(cardText);
            const isActionable = window.isActionableQuestActivity({
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
            const key = window.buildQuestActivityKey({ href, innerLabel: `${cardText} ${label}`, ariaLabel: "" });
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
    await injectDomHelpers(tabId);
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
              (heading) => isVisible(heading) && /activities|hoạt động|tareas|activités|aufgaben/i.test(window.normalizeRewardText(heading.textContent)),
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
              const candidates = Array.from(
                activitiesRoot.querySelectorAll(
                  "a[href], button, [role='button'], [role='link'], [data-react-aria-pressable='true'], .rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']"
                )
              );
              
              const uniqueCards = new Set();
              const cards = [];
              for (const cand of candidates) {
                const card = cand.closest(".rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']") || cand;
                if (!uniqueCards.has(card) && isVisible(card) && !card.closest("#quests")) {
                  uniqueCards.add(card);
                  cards.push(card);
                }
              }

              for (const candidate of cards) {
                const cardText = window.normalizeRewardText(candidate.innerText || candidate.textContent || "");
                const target =
                  candidate.querySelector("button:not([aria-disabled='true']), [role='button']:not([aria-disabled='true']), a[href], [role='link'], [data-react-aria-pressable='true']") ||
                  candidate;
                const href = target.href || target.getAttribute("href") || "";
                const innerLabel = window.normalizeRewardText(target.innerText || target.textContent || cardText);
                const candKey = window.buildQuestActivityKey({
                  href,
                  innerLabel: `${cardText} ${innerLabel || cardText}`,
                  ariaLabel: "",
                });
                const isMatchable = window.isActionableQuestActivity({
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
                    window.isCompletedText(cardText),
                });
                if (!isMatchable) continue;

                const targetHrefPart = keyToClick.split("|")[0];
                if ((href && targetHrefPart && href === targetHrefPart && href !== "#" && href !== "/earn") || candKey === keyToClick) {
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
          const beforeText = window.normalizeRewardText(document.body?.innerText || document.body?.textContent || "");

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
            const afterText = window.normalizeRewardText(document.body?.innerText || document.body?.textContent || "");
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

  async function getRewardCards(tabId, targetSectionIds, initialStableEmptySince = null) {
    await injectDomHelpers(tabId);
    const scanTimeoutMs = 40000;
    let scanTimeoutId;
    const scanExecution = chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [targetSectionIds || rewardSectionIds, initialStableEmptySince],
      func: (sectionIds, carriedStableEmptySince) => {
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
                const t = window.normalizeRewardText(el.textContent || "").toLowerCase();
                if (window.isCompletedText(t)) return true;
              }

              const fullText = window.normalizeRewardText(cardEl.innerText || cardEl.textContent || "").toLowerCase();
              if (window.isCompletedText(fullText)) return true;

              return false;
            }

            function getRewardRejectReasons(meta) {
              const href = meta.href || "";
              const text = window.normalizeRewardText(meta.text).toLowerCase();
              const reasons = [];
              if (meta.isVisible === false) reasons.push("not_visible");
              if (meta.isDisabled) reasons.push("disabled");
              if (meta.isCompleted) reasons.push("completed");
              if (meta.isInNav) reasons.push("in_nav");
              if (meta.isQuestCard) reasons.push("quest_card");
              if (!meta.hasVisual) reasons.push("no_visual");
              if (!text) reasons.push("no_text");
              if (!href && !meta.isPressable) reasons.push("no_href_or_pressable");
              if (meta.isHeader) reasons.push("header");
              if (href === "/earn") reasons.push("earn_link");
              if (/^(see more tasks|earn more)$/i.test(text.replace(/\s+/g, " ").trim())) reasons.push("nav_button");
              return reasons;
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
                  const isDirectRewardAction =
                    node.matches?.("a[href][data-react-aria-pressable='true'], a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']");
                  const card =
                    isDirectRewardAction
                      ? node
                      :
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

            function collectSectionCardsById(sectionId, debugSections) {
              let section = null;
              const sectionDebug = {
                sectionId,
                exists: true,
                directRoundedAnchors: 0,
                cardRoots: 0,
                accepted: 0,
                rejected: [],
              };
              debugSections.push(sectionDebug);

              if (sectionId !== "global") {
                section = document.querySelector(`#${sectionId}`);
                if (!section) {
                  sectionDebug.exists = false;
                  return [];
                }
                expandSectionIfCollapsed(section);
              }
              const rootNode = section || document;
              sectionDebug.directRoundedAnchors = rootNode.querySelectorAll(
                "a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']",
              ).length;
              const cardRoots = findRewardCardRoots(rootNode);
              sectionDebug.cardRoots = cardRoots.length;

              const unique = [];
              const seen = new Set();

              for (const card of cardRoots) {
                const href =
                  card.getAttribute("href") ||
                  card.querySelector("a[href]")?.getAttribute("href") ||
                  "";
                const text = window.normalizeRewardText(card.innerText || card.textContent || "");
                const key = window.buildRewardCardKey({ href, text });
                const meta = {
                  href,
                  text,
                  hasVisual: !!card.querySelector("img, mee-icon, svg, .mee-icon, [class*='icon'], [class*='Icon'], picture"),
                  isDisabled: card.getAttribute("aria-disabled") === "true" || !!card.closest("[aria-disabled='true'], [data-disabled='true']"),
                  isCompleted: isCardCompleted(card),
                  isVisible: isVisible(card),
                  isInNav: !!card.closest("nav, header, footer, [role='banner']"),
                  isQuestCard: !!card.closest("#quests"),
                  isHeader: card.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") || !!card.closest("h1, h2, h3, h4"),
                  isPressable: card.matches?.("button, [role='button'], [role='link'], [data-react-aria-pressable='true']") || !!card.querySelector("[data-react-aria-pressable='true'], button, [role='button'], [role='link']"),
                };
                const isActionable = window.isActionableRewardCard(meta);

                if (!isActionable) {
                  // Debug logging to find out WHY the card was rejected
                  console.log(`[Rewards-Debug] Card rejected. href: ${href.substring(0, 40)}... text: ${text.substring(0, 40)}... Meta:`, JSON.stringify(meta));
                  if (sectionDebug.rejected.length < 8) {
                    sectionDebug.rejected.push({
                      href: href.substring(0, 100),
                      text: text.substring(0, 100),
                      reasons: getRewardRejectReasons(meta),
                      meta: {
                        hasVisual: meta.hasVisual,
                        isCompleted: meta.isCompleted,
                        isVisible: meta.isVisible,
                        isHeader: meta.isHeader,
                        isInNav: meta.isInNav,
                        isQuestCard: meta.isQuestCard,
                        isPressable: meta.isPressable,
                        isDisabled: meta.isDisabled,
                      },
                    });
                  }
                  continue;
                }

                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(card);
                sectionDebug.accepted++;
                console.log(`[Rewards-Debug] Card accepted! href: ${href.substring(0, 40)}... text: ${text.substring(0, 40)}...`);
              }

              for (const anchor of rootNode.querySelectorAll("a[href][data-react-aria-pressable='true']")) {
                if (seen.has(anchor)) continue;

                const href = anchor.getAttribute("href") || "";
                const text = window.normalizeRewardText(anchor.innerText || anchor.textContent || "");
                const key = window.buildRewardCardKey({ href, text });
                const meta = {
                  href,
                  text,
                  hasVisual: !!anchor.querySelector("img, mee-icon, svg, .mee-icon, [class*='icon'], [class*='Icon'], picture"),
                  isDisabled: anchor.getAttribute("aria-disabled") === "true" || !!anchor.closest("[aria-disabled='true'], [data-disabled='true']"),
                  isCompleted: isCardCompleted(anchor),
                  isVisible: isVisible(anchor),
                  isInNav: !!anchor.closest("nav, header, footer, [role='banner']"),
                  isQuestCard: !!anchor.closest("#quests"),
                  isHeader: anchor.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") || !!anchor.closest("h1, h2, h3, h4"),
                  isPressable: true,
                };

                if (!window.isActionableRewardCard(meta)) {
                  if (sectionDebug.rejected.length < 8) {
                    sectionDebug.rejected.push({
                      href: href.substring(0, 100),
                      text: text.substring(0, 100),
                      reasons: getRewardRejectReasons(meta),
                      meta: {
                        hasVisual: meta.hasVisual,
                        isCompleted: meta.isCompleted,
                        isVisible: meta.isVisible,
                        isHeader: meta.isHeader,
                        isInNav: meta.isInNav,
                        isQuestCard: meta.isQuestCard,
                        isPressable: meta.isPressable,
                        isDisabled: meta.isDisabled,
                      },
                    });
                  }
                  continue;
                }
                if (seen.has(key)) continue;

                seen.add(anchor);
                seen.add(key);
                unique.push(anchor);
                sectionDebug.accepted++;
                console.log(`[Rewards-Debug] Direct pressable anchor accepted! href: ${href.substring(0, 40)}... text: ${text.substring(0, 40)}...`);
              }

              console.log(
                `[Rewards] Section #${sectionId}: found ${unique.length} actionable card(s)`,
              );
              return unique;
            }

            function collectPageRewardFallbackCards(debugSections, sectionId) {
              const sectionDebug = {
                sectionId,
                exists: true,
                directRoundedAnchors: document.querySelectorAll(
                  "a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']",
                ).length,
                cardRoots: 0,
                accepted: 0,
                rejected: [],
                filteredOut: [],
              };
              debugSections.push(sectionDebug);

              const candidates = [...new Set([
                ...document.querySelectorAll("a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']"),
                ...document.querySelectorAll("a[href][data-react-aria-pressable='true']"),
              ])];
              const anchors = candidates.filter((anchor) =>
                window.isDashboardRewardHref(anchor.href || anchor.getAttribute("href") || "")
              );
              sectionDebug.filteredOut = candidates
                .filter((anchor) => !anchors.includes(anchor))
                .slice(0, 5)
                .map((anchor) => ({
                  href: (anchor.getAttribute("href") || "").substring(0, 100),
                  text: window.normalizeRewardText(anchor.innerText || anchor.textContent || "").substring(0, 100),
                }));
              sectionDebug.cardRoots = anchors.length;

              const unique = [];
              const seen = new Set();
              for (const anchor of anchors) {
                const href = anchor.getAttribute("href") || "";
                const text = window.normalizeRewardText(anchor.innerText || anchor.textContent || "");
                const key = window.buildRewardCardKey({ href, text });
                const meta = {
                  href,
                  text,
                  hasVisual: !!anchor.querySelector("img, mee-icon, svg, .mee-icon, [class*='icon'], [class*='Icon'], picture"),
                  isDisabled: anchor.getAttribute("aria-disabled") === "true" || !!anchor.closest("[aria-disabled='true'], [data-disabled='true']"),
                  isCompleted: isCardCompleted(anchor),
                  isVisible: isVisible(anchor),
                  isInNav: !!anchor.closest("nav, header, footer, [role='banner']"),
                  isQuestCard: !!anchor.closest("#quests"),
                  isHeader: anchor.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") || !!anchor.closest("h1, h2, h3, h4"),
                  isPressable: true,
                };

                if (!window.isActionableRewardCard(meta)) {
                  if (sectionDebug.rejected.length < 8) {
                    sectionDebug.rejected.push({
                      href: href.substring(0, 100),
                      text: text.substring(0, 100),
                      reasons: getRewardRejectReasons(meta),
                      meta: {
                        hasVisual: meta.hasVisual,
                        isCompleted: meta.isCompleted,
                        isVisible: meta.isVisible,
                        isHeader: meta.isHeader,
                        isInNav: meta.isInNav,
                        isQuestCard: meta.isQuestCard,
                        isPressable: meta.isPressable,
                        isDisabled: meta.isDisabled,
                      },
                    });
                  }
                  continue;
                }

                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(anchor);
                sectionDebug.accepted++;
              }

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
              return window.buildRewardCardKey({
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
            let stableEmptySince =
              Number.isFinite(carriedStableEmptySince) && carriedStableEmptySince <= Date.now()
                ? carriedStableEmptySince
                : null;
            let lastDebug = [];

            const timer = setInterval(() => {
              try {
                attempts++;
                const debug = [];
                const sectionCards = (sectionIds || [])
                  .map((sectionId) => collectSectionCardsById(sectionId, debug))
                  .flat();
                if (sectionCards.length === 0) {
                  const isDashboardFallback =
                    (sectionIds || []).includes("dailyset") &&
                    /rewards\.bing\.com\/dashboard/i.test(location.href);
                  const isEarnFallback =
                    (sectionIds || []).includes("moreactivities") &&
                    /rewards\.bing\.com\/earn/i.test(location.href);
                  if (isDashboardFallback || isEarnFallback) {
                    sectionCards.push(...collectPageRewardFallbackCards(
                      debug,
                      isEarnFallback ? "earn_fallback" : "dashboard_fallback",
                    ));
                  }
                }
                const cards = collectCards(sectionCards);
                lastDebug = debug;
                const hasTargetSection = (sectionIds || []).some(
                  (sectionId) => sectionId === "global" || !!document.getElementById(sectionId),
                );

                if (cards.length === prevCount) {
                  stableRounds++;
                } else {
                  stableRounds = 0;
                }
                prevCount = cards.length;

                const now = Date.now();
                if (document.readyState === "complete" && hasTargetSection && cards.length === 0) {
                  if (stableEmptySince === null) stableEmptySince = now;
                } else {
                  stableEmptySince = null;
                }
                const stableEmptyMs = stableEmptySince === null ? 0 : now - stableEmptySince;

                const stableEmpty = window.shouldFinishEmptyRewardScan({
                  readyState: document.readyState,
                  hasTargetSection,
                  count: cards.length,
                  stableEmptyMs,
                });

                console.log("[Rewards-Debug] getRewardCards: Attempt " + attempts + " - Found " + cards.length + " cards. Stable rounds: " + stableRounds + ", stable empty ms: " + stableEmptyMs);
                if ((cards.length > 0 && stableRounds >= 1) || stableEmpty || attempts >= maxAttempts) {
                  clearInterval(timer);
                  console.log(
                    `[Rewards] Actionable cards found across sections: ${cards.length} (from ${sectionCards.length} section cards, after ${attempts} polls)`,
                  );
                  resolve({
                    cards,
                    debug: lastDebug,
                    attempts,
                    reason: stableEmpty ? "stable_empty" : cards.length > 0 ? "stable_cards" : "max_attempts",
                    stableEmptySince,
                    stableEmptyMs,
                  });
                }
              } catch (error) {
                clearInterval(timer);
                resolve({
                  cards: [],
                  debug: [{ sectionId: "scan_error", error: String(error) }],
                  attempts,
                  error: String(error),
                });
              }
            }, pollMs);
          });
        },
      });
    const scanTimeout = new Promise((resolve) => {
      scanTimeoutId = setTimeout(() => {
        resolve([{
          result: {
            cards: [],
            debug: [{ sectionId: "scan_timeout", timeoutMs: scanTimeoutMs }],
            attempts: 0,
            error: `reward card scan timed out after ${scanTimeoutMs}ms`,
          },
        }]);
      }, scanTimeoutMs);
    });
    const scanResults = await Promise.race([scanExecution, scanTimeout]);
    clearTimeout(scanTimeoutId);
    const scanResult = getFirstScriptResult(scanResults, {
      cards: [],
      debug: [{ sectionId: "missing_result" }],
      attempts: 0,
      reason: "missing_result",
    });
    const rewardCards = Array.isArray(scanResult) ? scanResult : scanResult?.cards;
    const debug = Array.isArray(scanResult?.debug) ? scanResult.debug : [];
    await appendDebugLog("info", "rewards", "Reward card scan diagnostics", {
      tabId,
      sections: debug,
      attempts: scanResult?.attempts,
      reason: scanResult?.reason,
      stableEmptyMs: scanResult?.stableEmptyMs,
      error: scanResult?.error,
      cards: Array.isArray(rewardCards) ? rewardCards.length : 0,
    });
    return {
      cards: Array.isArray(rewardCards) ? rewardCards : [],
      reason: scanResult?.reason,
      sections: debug,
      stableEmptyMs: scanResult?.stableEmptyMs,
      error: scanResult?.error,
    };
  }

  async function clickRewardCard(tabId, targetKey, targetSectionIds) {
    await injectDomHelpers(tabId);
    const scriptResults =
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
              const t = window.normalizeRewardText(el.textContent || "").toLowerCase();
              if (window.isCompletedText(t)) return true;
            }

            const fullText = window.normalizeRewardText(cardEl.innerText || cardEl.textContent || "").toLowerCase();
            if (window.isCompletedText(fullText)) return true;
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
                const isDirectRewardAction =
                  node.matches?.("a[href][data-react-aria-pressable='true'], a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']");
                const card =
                  isDirectRewardAction
                    ? node
                    :
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
              const text = window.normalizeRewardText(card.innerText || card.textContent || "");
              const meta = {
                href,
                text,
                hasVisual: !!card.querySelector("img, mee-icon, svg, .mee-icon, [class*='icon'], [class*='Icon'], picture"),
                isDisabled: card.getAttribute("aria-disabled") === "true" || !!card.closest("[aria-disabled='true'], [data-disabled='true']"),
                isCompleted: isCardCompleted(card),
                isVisible: isVisible(card),
                isInNav: !!card.closest("nav, header, footer, [role='banner']"),
                isQuestCard: !!card.closest("#quests"),
                isHeader: card.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") || !!card.closest("h1, h2, h3, h4"),
                isPressable: card.matches?.("button, [role='button'], [role='link'], [data-react-aria-pressable='true']") || !!card.querySelector("[data-react-aria-pressable='true'], button, [role='button'], [role='link']"),
              };

              if (!window.isActionableRewardCard(meta)) continue;
              if (seen.has(card)) continue;
              seen.add(card);
              unique.push(card);
            }

            for (const anchor of rootNode.querySelectorAll("a[href][data-react-aria-pressable='true']")) {
              if (seen.has(anchor)) continue;

              const href = anchor.getAttribute("href") || "";
              const text = window.normalizeRewardText(anchor.innerText || anchor.textContent || "");
              const meta = {
                href,
                text,
                hasVisual: !!anchor.querySelector("img, mee-icon, svg, .mee-icon, [class*='icon'], [class*='Icon'], picture"),
                isDisabled: anchor.getAttribute("aria-disabled") === "true" || !!anchor.closest("[aria-disabled='true'], [data-disabled='true']"),
                isCompleted: isCardCompleted(anchor),
                isVisible: isVisible(anchor),
                isInNav: !!anchor.closest("nav, header, footer, [role='banner']"),
                isQuestCard: !!anchor.closest("#quests"),
                isHeader: anchor.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") || !!anchor.closest("h1, h2, h3, h4"),
                isPressable: true,
              };

              if (!window.isActionableRewardCard(meta)) continue;
              seen.add(anchor);
              unique.push(anchor);
            }

            return unique;
          }

          function collectPageRewardFallbackCards() {
            const anchors = [...new Set([
              ...document.querySelectorAll("a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']"),
              ...document.querySelectorAll("a[href][data-react-aria-pressable='true']"),
            ])].filter((anchor) =>
              window.isDashboardRewardHref(anchor.href || anchor.getAttribute("href") || "")
            );

            const unique = [];
            const seen = new Set();
            for (const anchor of anchors) {
              const href = anchor.getAttribute("href") || "";
              const text = window.normalizeRewardText(anchor.innerText || anchor.textContent || "");
              const meta = {
                href,
                text,
                hasVisual: !!anchor.querySelector("img, mee-icon, svg, .mee-icon, [class*='icon'], [class*='Icon'], picture"),
                isDisabled: anchor.getAttribute("aria-disabled") === "true" || !!anchor.closest("[aria-disabled='true'], [data-disabled='true']"),
                isCompleted: isCardCompleted(anchor),
                isVisible: isVisible(anchor),
                isInNav: !!anchor.closest("nav, header, footer, [role='banner']"),
                isQuestCard: !!anchor.closest("#quests"),
                isHeader: anchor.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") || !!anchor.closest("h1, h2, h3, h4"),
                isPressable: true,
              };

              if (!window.isActionableRewardCard(meta)) continue;
              const key = buildCardKey(anchor);
              if (seen.has(key)) continue;
              seen.add(key);
              unique.push(anchor);
            }

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
            return window.buildRewardCardKey({
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
            const status = window.normalizeRewardText(card?.innerText || card?.textContent || "").toLowerCase();
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

          function dispatchPointerMouseSequence(target, { includeClick = true } = {}) {
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
            ];
            if (includeClick) {
              eventPlan.push(["click", MouseEvent, {}]);
            }

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
              // Send pointer state once, then use one native click. The previous
              // pointer click + .click() + Enter sequence opened duplicate tabs.
              try {
                dispatchPointerMouseSequence(target, { includeClick: false });
              } catch { }

              try {
                target.click();
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
            if (cardsList.length === 0) {
              const usePageFallback =
                ((sectionIds || []).includes("dailyset") && /rewards\.bing\.com\/dashboard/i.test(location.href)) ||
                ((sectionIds || []).includes("moreactivities") && /rewards\.bing\.com\/earn/i.test(location.href));
              if (usePageFallback) {
                cardsList.push(...collectPageRewardFallbackCards());
              }
            }
            card = cardsList.find((a) => {
              const candKey = buildCardKey(a);
              const candHref = a.getAttribute("href") || a.querySelector("a[href]")?.getAttribute("href") || "";
              const targetHrefPart = keyToClick.split("|")[0];
              return candKey === keyToClick || 
                (candHref && targetHrefPart && candHref === targetHrefPart && candHref !== "#" && candHref !== "/earn");
            });
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

    return getFirstScriptResult(scriptResults, {
      clicked: false,
      href: "",
      reason: "missing_result",
    });
  }

  async function handleRewardChildTab(tabId) {
    try {
      const scriptResults =
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [QUIZ_COMPLETION_RE.source],
          func: async (quizCompletionPatternSource) => {
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

            const getPageText = () =>
              normalizeText(
                [
                  document.body?.innerText || document.body?.textContent || "",
                  ...collectAllElements(document).map((el) => el.getAttribute("aria-label") || el.textContent || ""),
                ].join(" "),
              ).toLowerCase();

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

            const getQuizCompletionEvidence = () => {
              const completionPattern = new RegExp(quizCompletionPatternSource, "i");
              const completionSelectors =
                "[role='status'], [aria-live], [class*='BingQA'], [class*='quiz'], [class*='Quiz'], [id*='quiz'], [id*='Quiz'], [class*='poll'], [id*='poll'], cib-serp, cib-shared";

              for (const el of collectAllElements(document)) {
                if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
                if (!el.matches?.(completionSelectors) && !el.closest?.(completionSelectors)) continue;
                const text = normalizeText(
                  el.innerText || el.textContent || el.getAttribute("aria-label") || "",
                );
                if (!text || text.length > 1200) continue;
                const match = text.match(completionPattern);
                if (match) {
                  return {
                    matched: match[0],
                    text: text.substring(0, 240),
                    tag: el.tagName,
                  };
                }
              }

              return null;
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
              const allElements = collectAllElements(document);
              return allElements
                .filter((el) => el instanceof HTMLElement)
                .filter((el) => {
                  return (
                    el.matches(
                      "button, [role='button'], a[href], input[type='button'], input[type='submit'], label, [data-tag], [class*='option'], [class*='Option'], [class*='answer'], [class*='Answer'], [class*='choice'], [class*='Choice']"
                    ) || /choice/i.test(el.tagName)
                  );
                })
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

                  // Boost choice elements or elements inside cib-choice/cib-shared (Copilot Conversational Quiz)
                  if (el.tagName.toLowerCase().includes("choice") || el.closest("cib-choice, cib-shared")) {
                    score += 50;
                  }
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
            let lastCandidateSnapshot = [];

            for (let attempt = 0; attempt < 25; attempt++) {
              const completionEvidence = getQuizCompletionEvidence();
              if (completionEvidence) {
                return {
                  handled: true,
                  completed: true,
                  clicks,
                  reason: "completed",
                  diagnostics: { completionEvidence },
                };
              }

              const candidates = buildCandidates();
              lastCandidateSnapshot = candidates.slice(0, 8).map((item) => ({
                text: item.text.substring(0, 100),
                score: item.score,
                tag: item.el.tagName,
              }));

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

            const completionEvidence = getQuizCompletionEvidence();
            return {
              handled: true,
              completed: !!completionEvidence,
              clicks,
              reason: completionEvidence ? "completed" : "no_progress",
              diagnostics: {
                url: location.href,
                isConversation: /isconversation/i.test(location.href),
                candidates: lastCandidateSnapshot,
                completionEvidence,
              },
            };
          },
        });

      return getFirstScriptResult(scriptResults, {
        handled: false,
        completed: false,
        clicks: 0,
        reason: "missing_result",
      });
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
    const processedChildTabIds = new Set();
    const childTabSources = new Map();
    const onCreated = (createdTab) => {
      // Only track tabs opened by the automation tab. User-created tabs in the
      // same window must not be treated as reward child tabs.
      if (
        Number.isInteger(createdTab.id) &&
        createdTab.windowId === windowId &&
        (createdTab.openerTabId === tab.id || spawnedTabIds.has(createdTab.openerTabId))
      ) {
        spawnedTabIds.add(createdTab.id);
        childTabSources.set(createdTab.id, "event");
      }
    };
    chrome.tabs.onCreated.addListener(onCreated);

    const getCurrentTabIdSet = async () => {
      const tabs = await chrome.tabs.query({ windowId });
      return new Set(tabs.map((t) => t.id).filter((id) => Number.isInteger(id)));
    };

    const isDescendantOfRewardTab = (candidateTabId, openerByTabId) => {
      const seen = new Set();
      let openerTabId = openerByTabId.get(candidateTabId);
      while (Number.isInteger(openerTabId) && !seen.has(openerTabId)) {
        if (openerTabId === tab.id) return true;
        seen.add(openerTabId);
        openerTabId = openerByTabId.get(openerTabId);
      }
      return false;
    };

    const collectTrackedDescendantTabs = async () => {
      const currentTabs = await chrome.tabs.query({ windowId });
      const openerByTabId = new Map(
        currentTabs
          .filter((currentTab) => Number.isInteger(currentTab.id))
          .map((currentTab) => [currentTab.id, currentTab.openerTabId]),
      );
      return currentTabs.filter((currentTab) =>
        Number.isInteger(currentTab.id) &&
        currentTab.id !== tab.id &&
        (spawnedTabIds.has(currentTab.id) || isDescendantOfRewardTab(currentTab.id, openerByTabId)),
      );
    };

    const collectNewChildTabIds = async (perClickBaselineIds, label) => {
      const trackedTabs = await collectTrackedDescendantTabs();
      const childTabs = trackedTabs
        .filter((t) => Number.isInteger(t.id))
        .filter((t) => !perClickBaselineIds.has(t.id))
        .filter((t) => !processedChildTabIds.has(t.id))
        .map((t) => {
          spawnedTabIds.add(t.id);
          if (!childTabSources.has(t.id)) childTabSources.set(t.id, "opener");
          return {
            id: t.id,
            url: t.url || "",
            openerTabId: t.openerTabId,
            source: childTabSources.get(t.id),
          };
        });
      await appendDebugLog("info", "rewards", "Collected reward child tabs", {
        label,
        parentTabId: tab.id,
        tabs: childTabs,
      });
      return childTabs.map((childTab) => childTab.id);
    };

    const trackFallbackChildTab = async (createdTab, childTabIds) => {
      if (!Number.isInteger(createdTab?.id)) return;
      spawnedTabIds.add(createdTab.id);
      childTabSources.set(createdTab.id, "fallback");
      if (!childTabIds.includes(createdTab.id)) {
        childTabIds.push(createdTab.id);
      }
      await appendDebugLog("info", "rewards", "Tracked fallback reward child tab", {
        parentTabId: tab.id,
        tabId: createdTab.id,
        openerTabId: createdTab.openerTabId,
        url: createdTab.url || createdTab.pendingUrl || "",
        source: "fallback",
      });
    };

    const markChildTabsProcessed = (childTabIds) => {
      for (const childTabId of childTabIds) {
        if (Number.isInteger(childTabId)) processedChildTabIds.add(childTabId);
      }
    };

    const closeExistingTabs = async (tabIds, label) => {
      const requestedIds = [...new Set(tabIds.filter((tabIdToClose) => Number.isInteger(tabIdToClose)))];
      const closedIds = [];
      const missingIds = [];
      const failedIds = [];
      const errors = [];

      for (const tabIdToClose of requestedIds) {
        let tabToClose;
        try {
          tabToClose = await chrome.tabs.get(tabIdToClose);
        } catch {
          missingIds.push(tabIdToClose);
          continue;
        }

        try {
          await chrome.tabs.remove(tabIdToClose);
          try {
            await chrome.tabs.get(tabIdToClose);
            failedIds.push(tabIdToClose);
            errors.push({ tabId: tabIdToClose, error: "tab_still_exists_after_remove" });
          } catch {
            closedIds.push(tabIdToClose);
          }
        } catch (e) {
          failedIds.push(tabIdToClose);
          errors.push({
            tabId: tabIdToClose,
            url: tabToClose?.url || "",
            error: String(e?.message || e),
          });
        }
      }

      const result = { requestedIds, closedIds, missingIds, failedIds };
      const logLevel = failedIds.length ? "warn" : "info";
      await appendDebugLog(logLevel, "rewards", "Reward child tab cleanup result", {
        label,
        parentTabId: tab.id,
        ...result,
        errors,
      });
      if (closedIds.length) console.log(`[Rewards] Closed ${closedIds.length} ${label}`);
      if (failedIds.length) console.warn(`[Rewards] Failed closing ${failedIds.length} ${label}`);
      return result;
    };

    try {
      await ensureTabLoaded(tab.id, url);
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
          await ensureTabLoaded(tab.id, url);
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
          // Use stable actualHref for dedup so "X/Y tasks" text changes don't re-trigger the same quest
          const nextQuest = questCards.find((card) => !attemptedQuestKeys.has(card.actualHref || card.key));

          if (!nextQuest) {
            console.log("[Rewards] No more quest cards found for " + url);
            break;
          }

          attemptedQuestKeys.add(nextQuest.actualHref || nextQuest.key);
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

            const childBaselineIds = await getCurrentTabIdSet();
        const clickResult = await clickQuestActivity(tab.id, nextActivity.key);
        const structuredClickResult = clickResult && typeof clickResult === "object"
          ? clickResult
          : { clicked: !!clickResult, href: "" };
        const wasClicked = structuredClickResult.clicked;
        const targetHref = structuredClickResult.href;

            await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));

            let newTabIds = await collectNewChildTabIds(
              childBaselineIds,
              `quest ${i + 1} activity ${j + 1}`,
            );

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
                  const fallbackTab = await chrome.tabs.create({ url: fullHref, active: true, windowId, openerTabId: tab.id });
                  await trackFallbackChildTab(fallbackTab, newTabIds);
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

            const questCleanupResult = newTabIds.length
              ? await closeExistingTabs(newTabIds, "quest activity tab(s)")
              : { requestedIds: [], closedIds: [], missingIds: [], failedIds: [] };
            markChildTabsProcessed([
              ...questCleanupResult.closedIds,
              ...questCleanupResult.missingIds,
            ]);
            await appendDebugLog("info", "quests", `Quest activity ${j + 1} done`, {
              quest: nextQuest.href,
              activity: nextActivity.label,
              clicked: wasClicked,
              childTabIds: newTabIds,
              closedChildTabIds: questCleanupResult.closedIds,
              missingChildTabIds: questCleanupResult.missingIds,
              failedChildTabIds: questCleanupResult.failedIds,
            });
          }

          await chrome.tabs.update(tab.id, { url, active: true });
          await ensureTabLoaded(tab.id, url);
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
        targetSectionIds = ["moreactivities"];
      } else if (/rewards\.bing\.com\/dashboard/i.test(url)) {
        targetSectionIds = ["dailyset", "moreactivities"];
      }

      // Re-scan after each card. The Rewards dashboard re-renders sections after
      // every completion, and a one-time card list can go stale or be partial.
      const cardAttemptCounts = new Map();
      const discoveredRewardCards = new Map();
      const maxRewardCardClicks = 8;
      let headerOnlyRecoveryReloads = 0;
      for (let i = 0; i < maxRewardCardClicks; i++) {
        if (timedOut()) {
          console.warn("[Rewards] Timeout budget reached while clicking reward cards for " + url);
          await appendDebugLog("warn", "rewards", "Timeout budget reached for reward cards, continuing...", { url, processed: i });
        }

        let initialStableEmptySince = null;
        const timeoutMs = /rewards\.bing\.com\/dashboard/i.test(url)
          ? (discoveredRewardCards.size > 0 ? 15000 : 45000)
          : 20000;
        const domReadyResult = await waitForRewardsDomReady(
          tab.id,
          targetSectionIds,
          timeoutMs,
        );
        initialStableEmptySince = Number.isFinite(domReadyResult?.stableEmptySince)
          ? domReadyResult.stableEmptySince
          : null;
        const rewardCardsResult = await getRewardCards(
          tab.id,
          targetSectionIds,
          initialStableEmptySince,
        );
        const rewardCards = Array.isArray(rewardCardsResult?.cards)
          ? rewardCardsResult.cards
          : Array.isArray(rewardCardsResult)
            ? rewardCardsResult
            : [];
        const scanSections = Array.isArray(rewardCardsResult?.sections)
          ? rewardCardsResult.sections
          : [];
        for (const discoveredCard of rewardCards) {
          discoveredRewardCards.set(discoveredCard.key, discoveredCard);
        }
        await appendDebugLog("info", "rewards", `Found ${rewardCards.length} reward card(s) to click`, {
          url,
          cards: rewardCards.map((c) => c.key.substring(0, 60)).join(" | "),
          scan: i + 1,
        });

        const hasHeaderOnlyTargetSection = scanSections.some((section) =>
          targetSectionIds.includes(section.sectionId) &&
          section.exists === true &&
          section.accepted === 0 &&
          section.directRoundedAnchors === 0 &&
          Array.isArray(section.rejected) &&
          section.rejected.some((candidate) => candidate.reasons?.includes("header"))
        );
        if (
          rewardCards.length === 0 &&
          discoveredRewardCards.size === 0 &&
          hasHeaderOnlyTargetSection &&
          headerOnlyRecoveryReloads < 1
        ) {
          headerOnlyRecoveryReloads++;
          await appendDebugLog("warn", "rewards", "Reward section only contained its disclosure header; reloading once", {
            url,
            scan: i + 1,
          });
          await chrome.tabs.update(tab.id, { url, active: true });
          await ensureTabLoaded(tab.id, url);
          await ensureTabFocused(tab.id);
          await injectDomHelpers(tab.id);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        let card = rewardCards.find((candidate) => !cardAttemptCounts.has(candidate.key));
        if (!card) {
          card = [...discoveredRewardCards.values()].find(
            (candidate) => (cardAttemptCounts.get(candidate.key) || 0) < 1,
          );
          if (card) {
            await appendDebugLog("warn", "rewards", "Using previously discovered reward card after empty re-scan", {
              href: card.href.substring(0, 80),
              queued: discoveredRewardCards.size,
              scan: i + 1,
            });
          }
        }
        if (!card) {
          console.log("[Rewards] No more actionable reward cards found for " + url);
          break;
        }

        cardAttemptCounts.set(card.key, (cardAttemptCounts.get(card.key) || 0) + 1);
        console.log(`[Rewards] Clicking reward card ${i + 1}: ${card.href}`);
        await appendDebugLog("info", "rewards", `Clicking card ${i + 1}`, {
          href: card.href.substring(0, 80),
          remaining: rewardCards.length,
          attempt: cardAttemptCounts.get(card.key),
        });

        const childBaselineIds = await getCurrentTabIdSet();
        const clickResult = await clickRewardCard(tab.id, card.key, targetSectionIds);
        const structuredClickResult = clickResult && typeof clickResult === "object"
          ? clickResult
          : { clicked: !!clickResult, href: "" };
        const wasClicked = structuredClickResult.clicked;
        const resultHref = structuredClickResult.href;
        let usedManualFallback = false;

        await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));

        // Collect only child tabs spawned by this card click. A card can open
        // more than one tab, and the user may close one manually while we run.
        const newTabIds = await collectNewChildTabIds(childBaselineIds, `reward card ${i + 1}`);

        if (newTabIds.length === 0 && (card.href || resultHref)) {
          let fullHref = resultHref || card.href;
          if (fullHref.startsWith("/")) {
            fullHref = "https://rewards.bing.com" + fullHref;
          }
          if (fullHref.startsWith("http")) {
            usedManualFallback = true;
            await appendDebugLog("warn", "rewards", "Reward card did not open a child tab, falling back to manual open", {
              url: fullHref,
              clicked: wasClicked,
            });
            console.log("[Rewards] Reward card did not open a child tab, falling back to manual open: " + fullHref);
            try {
              const fallbackTab = await chrome.tabs.create({ url: fullHref, active: true, windowId, openerTabId: tab.id });
              await trackFallbackChildTab(fallbackTab, newTabIds);
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
            const quizResult = await handleRewardChildTab(childTabId);
            if (quizResult?.handled) {
              await appendDebugLog("info", "rewards", "Handled reward quiz child tab", {
                completed: quizResult.completed,
                clicks: quizResult.clicks,
                reason: quizResult.reason,
                diagnostics: quizResult.diagnostics,
              });
              await new Promise((r) => setTimeout(r, 2000));
            } else {
              await humanScrollOnTab(childTabId);
              await waitForRewardSearchCredit(childTabId);
            }
          } catch { }
        }

        // Close child tabs after scrolling
        const cardCleanupResult = newTabIds.length
          ? await closeExistingTabs(newTabIds, `child tab(s) from card ${i + 1}`)
          : { requestedIds: [], closedIds: [], missingIds: [], failedIds: [] };
        markChildTabsProcessed([
          ...cardCleanupResult.closedIds,
          ...cardCleanupResult.missingIds,
        ]);

        console.log(`[Rewards] Card ${i + 1} done (clicked=${wasClicked}, childTabs=${newTabIds.length})`);
        await appendDebugLog("info", "rewards", `Card ${i + 1} done`, {
          href: card.href.substring(0, 80),
          clicked: wasClicked,
          manualFallback: usedManualFallback,
          childTabs: newTabIds.length,
          childTabIds: newTabIds,
          closedChildTabIds: cardCleanupResult.closedIds,
          missingChildTabIds: cardCleanupResult.missingIds,
          failedChildTabIds: cardCleanupResult.failedIds,
        });

        // Reward cards open child tabs. Preserve the hydrated parent DOM so the
        // remaining cards do not disappear behind another full page reload.
        let parentStillOnRewardsPage = false;
        try {
          const parentTab = await chrome.tabs.get(tab.id);
          const currentUrl = new URL(parentTab.url || "");
          const expectedUrl = new URL(url);
          parentStillOnRewardsPage =
            currentUrl.origin === expectedUrl.origin &&
            currentUrl.pathname === expectedUrl.pathname;
        } catch { }
        if (!parentStillOnRewardsPage) {
          await chrome.tabs.update(tab.id, { url, active: true });
          await ensureTabLoaded(tab.id, url);
        } else {
          await chrome.tabs.update(tab.id, { active: true });
        }
        await ensureTabFocused(tab.id);
        await injectDomHelpers(tab.id);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } finally {
      chrome.tabs.onCreated.removeListener(onCreated);
      if (tab.id) {
        const trackedDescendantTabs = await collectTrackedDescendantTabs();
        const idsToClose = [
          ...new Set([
            ...spawnedTabIds,
            ...trackedDescendantTabs.map((trackedTab) => trackedTab.id),
          ]),
        ].filter((id) => id !== tab.id && !processedChildTabIds.has(id));
        const finalCleanupResult = await closeExistingTabs(
          idsToClose,
          `tracked spawned tab(s) from ${url}`,
        );
        markChildTabsProcessed([
          ...finalCleanupResult.closedIds,
          ...finalCleanupResult.missingIds,
        ]);
        await closeChildTabs(tab.id, 4, 1200, windowId);
        try {
          await chrome.tabs.remove(tab.id);
          console.log(`[Rewards] Closed tab for ${url}`);
          await appendDebugLog("info", "rewards", "Closed reward parent tab", {
            tabId: tab.id,
            url,
          });
        } catch (e) {
          console.warn(`[Rewards] Failed to close tab for ${url}:`, e);
          await appendDebugLog("warn", "rewards", "Failed closing reward parent tab", {
            tabId: tab.id,
            url,
            error: String(e?.message || e),
          });
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

function waitForTabComplete(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearInterval(timer);
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") {
        finish();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        finish(new Error("timeout waiting for tab load"));
      } else {
        let tInfo;
        try {
          tInfo = await chrome.tabs.get(tabId);
        } catch (e) {
          finish(e);
          return;
        }
        if (tInfo.status === "complete") {
          finish();
        }
      }
    }, 200);
  });
}

async function inspectLoadedTab(tabId, expectedUrl = "") {
  const tab = await chrome.tabs.get(tabId);
  const actualUrl = tab.url || tab.pendingUrl || "";
  const browserErrorUrl = /^(?:edge|chrome)-error:\/\//i.test(actualUrl);
  const expectedHost = expectedUrl ? new URL(expectedUrl).hostname : "";
  const actualHost = /^https?:/i.test(actualUrl) ? new URL(actualUrl).hostname : "";

  let page = null;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const text = (document.body?.innerText || "").slice(0, 2000);
        const title = document.title || "";
        const errorText = `${title}\n${text}`;
        return {
          readyState: document.readyState,
          hasBody: !!document.body,
          bodyLength: text.trim().length,
          online: navigator.onLine,
          errorPage: /(?:ERR_[A-Z_]+|This site can(?:'|’)t be reached|There is no Internet connection|Hmmm… can(?:'|’)t reach this page|DNS_PROBE_)/i.test(errorText),
        };
      },
    });
    page = result || null;
  } catch {
    // Some child URLs are outside host_permissions. Tab status/URL checks still apply.
  }

  const pageComplete = !!page &&
    page.readyState === "complete" &&
    page.hasBody &&
    page.online !== false &&
    !page.errorPage;
  const loadComplete = tab.status === "complete" || pageComplete;
  const valid = loadComplete &&
    !browserErrorUrl &&
    (!expectedHost || actualHost === expectedHost) &&
    (!page || pageComplete);

  return {
    valid,
    tabStatus: tab.status || "unknown",
    loadComplete,
    actualUrl,
    expectedHost,
    actualHost,
    browserErrorUrl,
    page,
  };
}

async function ensureTabLoaded(tabId, expectedUrl, options = {}) {
  const attempts = options.attempts || TAB_LOAD_MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs || TAB_LOAD_TIMEOUT_MS;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const initialInspection = await inspectLoadedTab(tabId, expectedUrl);
      if (initialInspection.valid) return initialInspection;

      try {
        await waitForTabComplete(tabId, timeoutMs);
      } catch (waitError) {
        const timeoutInspection = await inspectLoadedTab(tabId, expectedUrl);
        if (timeoutInspection.valid) {
          await appendDebugLog("warn", "navigation", "Tab API remained loading but page DOM is ready", {
            expectedUrl,
            actualUrl: timeoutInspection.actualUrl,
            attempt,
            tabStatus: timeoutInspection.tabStatus,
            page: timeoutInspection.page,
          });
          return timeoutInspection;
        }
        throw waitError;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const inspection = await inspectLoadedTab(tabId, expectedUrl);
      if (inspection.valid) return inspection;
      lastError = new Error(`tab validation failed: ${inspection.actualUrl || "unknown URL"}`);
      await appendDebugLog("warn", "navigation", "Loaded tab failed validation", {
        expectedUrl,
        actualUrl: inspection.actualUrl,
        attempt,
        tabStatus: inspection.tabStatus,
        loadComplete: inspection.loadComplete,
        browserErrorUrl: inspection.browserErrorUrl,
        page: inspection.page,
      });
    } catch (e) {
      lastError = e;
      await appendDebugLog("warn", "navigation", "Tab load attempt failed", {
        expectedUrl,
        attempt,
        error: String(e),
      });
    }

    if (attempt < attempts) {
      await ensureInternetOrThrow(`tab_load_retry_${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      await chrome.tabs.update(tabId, { url: expectedUrl, active: true });
    }
  }

  await appendDebugLog("error", "navigation", "Tab failed to load after retries", {
    expectedUrl,
    attempts,
    error: String(lastError),
  });
  throw lastError || new Error(`failed to load ${expectedUrl}`);
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
    await ensureTabLoaded(tabId, "https://www.bing.com/");
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
    await ensureTabLoaded(tabId, url);
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

    // Resolve windowId for tab management
    const tabInfo = await chrome.tabs.get(tabId);
    const windowId = tabInfo.windowId;

    // Snapshot existing tabs so we can detect + close any new ones
    const tabsBefore = await chrome.tabs.query({ windowId });
    const baselineIds = new Set(tabsBefore.map((t) => t.id).filter((id) => Number.isInteger(id)));

    const [{ result: browseResult } = {}] = await chrome.scripting.executeScript({
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
            await sleep(rand(400, 1500));
            link.dispatchEvent(new MouseEvent("mouseleave", { ...common, bubbles: false }));
            link.dispatchEvent(new MouseEvent("mouseout", common));
          } catch { }
          await sleep(rand(200, 600));
        }

        // --- Phase 3: Pick a result to click (~30% chance) ---
        // Return the href instead of clicking — let the background script handle
        // tab creation/cleanup so we don't lose context or leave orphan tabs.
        let clickHref = null;
        const shouldClick = Math.random() < 0.3 && resultLinks.length > 0;
        if (shouldClick) {
          const topResults = resultLinks.slice(0, Math.min(5, resultLinks.length));
          const target = topResults[rand(0, topResults.length - 1)];
          if (target) {
            clickHref = target.href || target.getAttribute("href") || null;
            // Simulate hover on the chosen link before "clicking"
            if (clickHref) {
              try {
                target.scrollIntoView({ behavior: "smooth", block: "center" });
                await sleep(rand(300, 700));
                const rect = target.getBoundingClientRect();
                const cx = rect.left + rand(5, Math.max(6, rect.width - 5));
                const cy = rect.top + rand(2, Math.max(3, rect.height - 2));
                const common = { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy };
                target.dispatchEvent(new MouseEvent("mouseover", common));
                target.dispatchEvent(new MouseEvent("mousemove", common));
                await sleep(rand(200, 500));
              } catch { }
            }
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

        return { clickHref };
      },
    });

    // --- Handle click result: open in new tab, scroll, then close ---
    const clickHref = browseResult?.clickHref;
    if (clickHref && /^https?:\/\//i.test(clickHref)) {
      try {
        console.log(`[Search] Clicking search result: ${clickHref.substring(0, 80)}`);
        const childTab = await chrome.tabs.create({ url: clickHref, active: true, windowId });
        await waitForTabComplete(childTab.id, 15000);
        await humanScrollOnTab(childTab.id, 12000);
        await chrome.tabs.remove(childTab.id);
        console.log(`[Search] Closed clicked result tab ${childTab.id}`);
      } catch (e) {
        console.warn(`[Search] Failed handling clicked result:`, e?.message || e);
      }
    }

    // --- Cleanup: close any unexpected tabs spawned during browsing ---
    try {
      const tabsAfter = await chrome.tabs.query({ windowId });
      const orphanIds = tabsAfter
        .map((t) => t.id)
        .filter((id) => Number.isInteger(id))
        .filter((id) => !baselineIds.has(id) && id !== tabId);
      if (orphanIds.length) {
        await chrome.tabs.remove(orphanIds);
        console.log(`[Search] Closed ${orphanIds.length} orphan tab(s) from browse`);
      }
    } catch { }

    // Re-focus the search tab
    try {
      await chrome.tabs.update(tabId, { active: true });
      await ensureTabFocused(tabId);
    } catch { }

    console.log(`[Search] Human browse completed on tab ${tabId}`);
  } catch (e) {
    console.warn(`[Search] Human browse failed on tab ${tabId}:`, e?.message || e);
  }
}

// ---------------- Run task ----------------
async function runTask() {
  const cfg = await getConfig();
  if (!cfg.enabled) return;

  await chrome.storage.sync.set({
    running: true,
    runEndsAt: null,
    nextOpenAt: Date.now(),
  });
  await updateBadge();
  await ensureRunTicker();

  try {
    await ensureInternetOrThrow("run_start");

    // 1. First run rewards auto-click
    await autoClickRewards();
    await ensureInternetOrThrow("rewards_first_pass");
    await appendDebugLog("success", "rewards", "Rewards phase completed");

    await appendDebugLog("info", "search", "Search phase started");

    // 2. Then continue with Bing searches — use awaited loop so the
    //    service worker keepalive stays active until every search finishes.
    const queries = getQueryList(cfg);

    for (let idx = 0; idx < queries.length; idx++) {
      await ensureInternetOrThrow(`search_${idx + 1}_before_delay`);

      const delaySecs = randomDelay(cfg.intervalMin, cfg.intervalMax);
      const nextOpenAt = Date.now() + delaySecs * 1000;
      await chrome.storage.sync.set({ nextOpenAt });
      await updateBadge();

      // Wait for the random delay before opening the next search
      await new Promise((r) => setTimeout(r, delaySecs * 1000));
      await ensureInternetOrThrow(`search_${idx + 1}_before_open`);

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

      await ensureInternetOrThrow(`search_${idx + 1}_after_open`);
    }

    await chrome.storage.sync.set({ nextOpenAt: null });
    await appendDebugLog("success", "search", "Search phase completed", {
      totalQueries: queries.length,
    });

    // 3. Final sweep for rewards (second pass)
    console.log("⚡ Running second pass for Bing Rewards auto click...");
    await appendDebugLog("info", "rewards", "Second Rewards phase started");
    try {
      await ensureInternetOrThrow("rewards_second_pass_before");
      await autoClickRewards();
      await ensureInternetOrThrow("rewards_second_pass_after");
      await appendDebugLog("success", "rewards", "Second Rewards phase completed");
    } catch (e) {
      if (isInternetUnavailableError(e)) throw e;
      console.warn("[Rewards] Second pass failed:", e);
      await appendDebugLog("error", "rewards", "Second Rewards phase failed: " + e.message);
    }

    await markRunCompletedToday();
  } finally {
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
}

async function startRun(source = "unknown") {
  if (runPromise) {
    console.log(`[Run] Skip ${source}; a run is already in progress.`);
    await appendDebugLog("warn", "run", "Run skipped because another run is active", { source });
    return runPromise;
  }
  runPromise = (async () => {
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) return;
      if (source !== "run_now" && await hasRunToday()) {
        console.log(`[Run] Skip ${source}; already completed today.`);
        await appendDebugLog("info", "run", "Run skipped because today is already complete", { source });
        return;
      }

      const profileSlot = await getProfileSlot();
      const slotOffsetMinutes = getSlotOffsetMinutes(profileSlot);
      console.log(`[Run] Started from ${source}`, { profileSlot, slotOffsetMinutes });
      await appendDebugLog("info", "run", "Run started", {
        profileSlot,
        slotOffsetMinutes,
        source,
        scheduledAt: Date.now(),
      });
      await startKeepAlive();
      await ensureInternetOrThrow("before_run");
      await clearInternetRetry();
      await runTask();
    } catch (e) {
      console.error(`[Run] Failed from ${source}:`, e);
      await appendDebugLog("error", "run", "Run failed", { source, error: String(e) });
      if (isInternetUnavailableError(e) && !await hasRunToday()) {
        await scheduleInternetRetry(source);
      }
    } finally {
      await stopKeepAlive();
      await clearDelayedStart();
      runPromise = null;
      console.log(`[Run] Finished from ${source}`);
      await appendDebugLog("info", "run", "Run finished", { source });
    }
  })();
  return runPromise;
}

// ---------------- Scheduling ----------------
async function scheduleAlarm({ clearDelayed = false } = {}) {
  const cfg = await getConfig();
  await chrome.alarms.clear(ALARM_NAME);

  if (!cfg.enabled) {
    await clearDelayedStart();
    await clearInternetRetry();
    await chrome.storage.sync.set({ nextRunAt: null });
    await updateBadge();
    return;
  }

  if (clearDelayed) await clearDelayedStart();

  const profileSlot = await getProfileSlot();
  const slotOffsetMinutes = getSlotOffsetMinutes(profileSlot);
  const next = computeNextRunDate(cfg.time, slotOffsetMinutes);
  chrome.alarms.create(ALARM_NAME, { when: next.getTime() });
  await chrome.storage.sync.set({ nextRunAt: next.getTime() });
  await updateBadge();
  console.log("Next run scheduled at:", next.toString(), { profileSlot, slotOffsetMinutes });
  await appendDebugLog("info", "scheduler", "Next run scheduled", {
    profileSlot,
    slotOffsetMinutes,
    source: "daily_alarm",
    scheduledAt: next.getTime(),
  });
}

async function handleInternetRetry() {
  const cfg = await getConfig();
  if (!cfg.enabled || await hasRunToday()) {
    await clearInternetRetry();
    return;
  }

  if (await isInternetAvailable()) {
    await clearInternetRetry();
    await scheduleAlarm();
    await scheduleStaggeredStart("internet_retry");
    return;
  }

  await scheduleInternetRetry("retry_check");
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // No-op ping to prevent MV3 service worker from being terminated
    return;
  }
  if (alarm.name === ALARM_NAME) {
    await startRun("alarm");
    await scheduleAlarm();
    return;
  }
  if (alarm.name === INTERNET_RETRY_ALARM) {
    await handleInternetRetry();
    return;
  }
  if (alarm.name === DELAYED_START_ALARM) {
    const data = await chrome.storage.local.get(DELAYED_RUN_SOURCE_KEY);
    const source = data[DELAYED_RUN_SOURCE_KEY] || "unknown";
    await clearDelayedStart();
    await startRun(`delayed_${source}`);
    await scheduleAlarm();
    return;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "profileSlot" in changes) {
    scheduleAlarm({ clearDelayed: true });
    return;
  }
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
    scheduleAlarm({ clearDelayed: true });
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
    scheduleAlarm({ clearDelayed: true })
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

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(["enabled", "time"]);
  const updates = {};

  if (current.enabled === undefined) {
    updates.enabled = DEFAULTS.enabled;
  }
  if (!current.time || current.time === "08:00") {
    updates.time = DEFAULT_RUN_TIME;
  }
  if (Object.keys(updates).length) {
    await chrome.storage.sync.set(updates);
  }

  await scheduleAlarm({ clearDelayed: true });
  await updateBadge();
  await ensureRunTicker();
});

scheduleAlarm();
updateBadge();
