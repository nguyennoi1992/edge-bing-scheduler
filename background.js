// Use as an ES module for MV3 service worker
import { buildQueries } from "./words.js";
import {
  CLAIM_MATCH_RE,
  EMPTY_REWARD_STABLE_MS,
  READY_TO_CLAIM_LABEL_RE,
  QUIZ_COMPLETION_RE,
  buildQuestActivityKey,
  buildQuestCardKey,
  buildRewardCardKey,
  classifyRewardScanState,
  extractDailySetFromFlyoutHtml,
  extractYourActivityFromFlyoutHtml,
  getRewardHydrationRetryDelay,
  isActionableQuestActivity,
  isActionableRewardCard,
  isCompletedText,
  isDashboardRewardHref,
  isRewardsPageUrl,
  normalizeRewardText,
  shouldFinishEmptyRewardScan,
} from "./reward-dom-helpers.js";
import { getFirstScriptResult } from "./script-result-helpers.js";

const ALARM_NAME = "bingScheduler";
const BADGE_ALARM = "badgeTick";
const REWARDS_SETTLE_MS = 8000;
const REWARD_CHILD_SYNC_MS = 5000;
const REWARD_URL_TIMEOUT_MS = 360000;
const MIN_QUEST_REMAINING_BUDGET_MS = 60000;
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
  searchesPerRun: 4, // how many queries to open per run (reduced to 4 per user request)
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
function getBrowserName() {
  const ua = globalThis.navigator?.userAgent || "";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/Chrome\//.test(ua)) return "chrome";
  return "unknown";
}

function isProtectedPageScriptError(error) {
  const message = String(error?.message || error?.originalError?.message || error || "");
  return (
    error?.code === "PAGE_SCRIPTING_BLOCKED" ||
    /extensions gallery cannot be scripted|cannot be scripted by extensions|cannot access a (?:chrome|edge):\/\/|protected page/i.test(message)
  );
}

async function assertScriptableRewardsTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || tab.pendingUrl || "";

  if (!isRewardsPageUrl(url)) {
    const error = new Error(
      `Rewards tab is not scriptable: ${url || "(empty URL)"}`
    );
    error.code = "REWARDS_TAB_NOT_SCRIPTABLE";
    error.tabUrl = url;
    throw error;
  }

  return tab;
}

async function executeRewardsScript(tabId, scriptOptions) {
  await assertScriptableRewardsTab(tabId);
  try {
    return await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      ...scriptOptions,
    });
  } catch (e) {
    if (isProtectedPageScriptError(e)) {
      const protectedError = new Error(
        `Browser protects this page from extension scripting: ${e?.message || e}`
      );
      protectedError.code = "PAGE_SCRIPTING_BLOCKED";
      protectedError.originalError = e;
      throw protectedError;
    }
    throw e;
  }
}

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
  await executeRewardsScript(tabId, {
    files: ["reward-scanner-helpers.js"],
  });

  await executeRewardsScript(tabId, {
    args: [EMPTY_REWARD_STABLE_MS, READY_TO_CLAIM_LABEL_RE.source, CLAIM_MATCH_RE.source],
    func: (emptyRewardStableMs, readyToClaimSource, claimMatchSource) => {
      const helpersReady =
        typeof window.normalizeRewardText === "function" &&
        typeof window.isCompletedText === "function" &&
        typeof window.collectProgressRatioMatches === "function" &&
        typeof window.isCompletedQuestText === "function" &&
        typeof window.isActionableRewardCard === "function" &&
        typeof window.buildRewardCardKey === "function" &&
        typeof window.buildQuestCardKey === "function" &&
        typeof window.isActionableQuestActivity === "function" &&
        typeof window.buildQuestActivityKey === "function" &&
        typeof window.isDashboardRewardHref === "function" &&
        typeof window.findRewardCardRoots === "function" &&
        typeof window.expandRewardSection === "function" &&
        typeof window.isRewardSectionChrome === "function" &&
        typeof window.shouldFinishEmptyRewardScan === "function" &&
        typeof window.parsePointsFromText === "function" &&
        typeof window.isCardCompleted === "function" &&
        window.READY_TO_CLAIM_LABEL_RE instanceof RegExp &&
        window.READY_TO_CLAIM_LABEL_RE.source === readyToClaimSource &&
        window.CLAIM_MATCH_RE instanceof RegExp &&
        window.CLAIM_MATCH_RE.source === claimMatchSource;
      if (window.__rewardDomHelpersInjected && helpersReady) return;
      window.__rewardDomHelpersInjected = true;

      window.normalizeRewardText = function normalizeRewardText(value) {
        return (value || "").replace(/\s+/g, " ").trim();
      };

      window.READY_TO_CLAIM_LABEL_RE = new RegExp(readyToClaimSource, "i");
      window.CLAIM_MATCH_RE = new RegExp(claimMatchSource, "i");

      window.parsePointsFromText = function parsePointsFromText(text) {
        const input = typeof text === "string" ? text : String(text ?? "");
        // 1. Explicit points with keyword or plus (e.g. "+6", "6 points", "+1,000 pts")
        const pointMatch =
          input.match(/(?:\+\s*|\b)(\d[\d,.]*)\s*(?:points?|pts?)\b/i) ||
          input.match(/\+\s*(\d[\d,.]*)\b(?!\s*(?:days?|hours?|hrs?|mins?|minutes?|ngày|giờ|phút|streak|friends?|bạn)(?:[\s,.]|$))/i);
        if (pointMatch) {
          const parsed = Number(pointMatch[1].replace(/[,.]/g, ""));
          if (Number.isFinite(parsed)) return parsed;
        }
        // 2. Ready to claim / Claim card context: number near claim / pending (e.g. "Ready to claim 6 Claim", "6 Pending", "Ready to claim: +50")
        const contextualMatch =
          input.match(
            /(?:ready to claim|sẵn sàng nhận|可领取|prêt à réclamer|bereit zum einlösen|listo para reclamar|готово к получению|\bclaim\b|\bnhận\b|\breclamar\b|\beinlösen\b|\bpending\b)(?:\s+(?:points?|pts?|điểm|puntos))?[\s!:+\-]*\b(\d[\d,.]*)\b(?!\s*(?:days?|hours?|hrs?|mins?|minutes?|ngày|giờ|phút|of\b|\/\s*\d+)(?:[\s,.]|$))/i,
          ) ||
          input.match(/\b(\d[\d,.]*)\b[\s!:+\-]*(?:\bpending\b|\bclaim\b|\bnhận\b|\breclamar\b|\beinlösen\b)(?!\w)/i);
        if (contextualMatch) {
          const parsed = Number(contextualMatch[1].replace(/[,.]/g, ""));
          if (Number.isFinite(parsed)) return parsed;
        }
        // 3. Standalone short number
        const standaloneMatch = input.trim().match(/^(\d[\d,.]*)$/);
        if (standaloneMatch) {
          const parsed = Number(standaloneMatch[1].replace(/[,.]/g, ""));
          if (Number.isFinite(parsed)) return parsed;
        }
        return 0;
      };

      const COMPLETED_RE =
        /\bcompleted\b|\bdone\b|ho\u00e0n th\u00e0nh|\u0111\u00e3 xong|\u5df2\u5b8c\u6210|\u5b8c\u4e86|termin\u00e9|abgeschlossen|completado|\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e/i;

      window.isCompletedText = function isCompletedText(value) {
        return COMPLETED_RE.test(window.normalizeRewardText(value).toLowerCase());
      };

      window.collectProgressRatioMatches = function collectProgressRatioMatches(text) {
        if (!text) return [];
        return [
          ...text.matchAll(/(?<![\/\d])\b(\d+)\s*\/\s*([1-9]\d*)\b(?:\s+(?:tasks?|points?|pts?|quests?|activities|hoạt động|nhiệm vụ|tareas?|activités?|aufgaben))(?!\s*[\/\d])/gi),
          ...text.matchAll(/\b(?:quests?|nhiệm vụ|hoạt động|tareas?|activités?|aufgaben)\s+(\d+)\s*\/\s*([1-9]\d*)\b(?!\s*[\/\d])/gi),
          ...text.matchAll(/(?:\bcompleted\b|\bdone\b|ho\u00e0n th\u00e0nh|\u0111\u00e3 xong|\u5df2\u5b8c\u6210|\u5b8c\u4e86|termin\u00e9|abgeschlossen|completado|\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e)[\s!:()\-–—[\]]*(\d+)\s*\/\s*([1-9]\d*)\b(?!\s*[\/\d])/gi),
          ...text.matchAll(/(?<![\/\d])\b(\d+)\s*\/\s*([1-9]\d*)[\s!:()\-–—[\]]*(?:\bcompleted\b|\bdone\b|ho\u00e0n th\u00e0nh|\u0111\u00e3 xong|\u5df2\u5b8c\u6210|\u5b8c\u4e86|termin\u00e9|abgeschlossen|completado|\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e)/gi),
        ];
      };

      window.isCompletedQuestText = function isCompletedQuestText(value) {
        const text = window.normalizeRewardText(value);
        if (!text) return false;

        // 1. Collect all explicit progress ratio matches (tasks, points, quests, activities, completed prefix/suffix)
        const allRatioMatches = window.collectProgressRatioMatches(text);
        if (allRatioMatches.length > 0) {
          return allRatioMatches.every((m) => Number(m[1]) >= Number(m[2]));
        }

        // 2. If no explicit ratios found, inspect completion keywords
        if (window.isCompletedText(text)) return true;

        // 3. Standalone ratio badge (e.g. "1/1", "5/5")
        const exactRatioMatch = text.match(/^(\d+)\s*\/\s*([1-9]\d*)$/);
        if (exactRatioMatch) {
          return Number(exactRatioMatch[1]) >= Number(exactRatioMatch[2]);
        }

        return false;
      };

      window.isCardCompleted = function isCardCompleted(cardEl) {
        if (!cardEl) return false;
        if (cardEl.getAttribute?.("data-ext-completed") === "true") return true;
        if (cardEl.querySelector?.("[data-ext-completed='true']")) return true;
        const BADGE_SELECTOR =
          "[class*='statusSuccess'], [class*='Success'], [class*='CheckMark'], [class*='checkMark']";
        const DIRECT_BADGE_SELECTOR =
          "svg[class*='statusSuccess'], mee-icon[class*='statusSuccess'], svg[class*='Success'], mee-icon[class*='Success'], mee-icon[class*='CheckMark'], svg[class*='CheckMark'], mee-icon[class*='checkMark'], svg[class*='checkMark']";

        const matchedList = cardEl.querySelectorAll?.(BADGE_SELECTOR);
        let matchedElements = [];
        if (matchedList) {
          matchedElements = Array.from(matchedList);
        } else {
          const single = cardEl.querySelector?.(BADGE_SELECTOR);
          if (single) matchedElements = [single];
        }

        const badgeElements = [
          ...(typeof cardEl.matches === "function" && cardEl.matches(DIRECT_BADGE_SELECTOR) ? [cardEl] : []),
          ...matchedElements,
        ];

        for (const successBadge of badgeElements) {
          const isDirectIcon =
            successBadge.tagName?.toLowerCase() === "svg" ||
            successBadge.tagName?.toLowerCase() === "mee-icon";
          const classStr =
            typeof successBadge.className === "string"
              ? successBadge.className
              : successBadge.getAttribute?.("class") || "";
          const hasCheckmarkClass = /mee-icon-CheckMark|\bcheck-?mark\b/i.test(classStr);
          const hasSuccessClass = /Success/i.test(classStr);

          if (isDirectIcon && (hasCheckmarkClass || hasSuccessClass)) {
            return true;
          }
          if (
            successBadge !== cardEl &&
            (hasCheckmarkClass || hasSuccessClass) &&
            Boolean(successBadge.querySelector?.(DIRECT_BADGE_SELECTOR))
          ) {
            return true;
          }
        }

        const statusEls =
          cardEl.querySelectorAll?.(
            "[class*='metadata'], [class*='fgCtrlNeutralSecondary']",
          ) || [];
        for (const el of statusEls) {
          const t = typeof window.normalizeRewardText === "function"
            ? window.normalizeRewardText(el.textContent || "")
            : (el.textContent || "").replace(/\s+/g, " ").trim();
          if (typeof window.isCompletedQuestText === "function") {
            if (window.isCompletedQuestText(t)) return true;
          } else if (typeof window.isCompletedText === "function" && window.isCompletedText(t)) {
            return true;
          }
        }

        return false;
      };

      window.isDashboardRewardHref = function isDashboardRewardHref(href) {
        const value = href || "";
        return (
          /^(?:https?:\/\/(?:[a-z0-9-]+\.)?bing\.com)?\/(?:search|spotlight\/imagepuzzle)\b/i.test(value) ||
          /^https?:\/\/(?!rewards\b)(?:[a-z0-9-]+\.)?bing\.com\//i.test(value) ||
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
      const QUEST_INFO_RE =
        /^(?:about(?:\s+(?:this\s+)?(?:quest|daily set|rewards|activities))?|về(?:\s+(?:nhiệm vụ|hoạt động))?|level up activities)$/i;
      const QUEST_STREAK_RE = /\b(?:\d+\s+days\s+in\s+a\s+row|for\s+\d+\s+days|streak)\b/i;

      window.isActionableRewardCard = function isActionableRewardCard(meta) {
        const href = meta.href || "";
        const text = window.normalizeRewardText(meta.text).toLowerCase();
        const hasValidHref = Boolean(href && !/^(?:#|javascript:)/i.test(href.trim()));

        if (meta.isVisible === false) return false;
        if (meta.isDisabled) return false;
        if (meta.isCompleted) return false;
        if (meta.isInNav) return false;
        if (meta.isQuestCard) return false;
        if (meta.isSectionChrome) return false;
        if (!meta.hasVisual) return false;
        if (!text) return false;
        if (!hasValidHref && !meta.isPressable) return false;
        if (meta.isHeader) return false;
        if (/^(?:https?:\/\/rewards\.bing\.com)?\/(?:earn|about|redeem|refer|status|optout)\/?(?:[?#].*)?$/i.test(href)) return false;
        // Only skip short navigation buttons like "Earn more" or "See more tasks",
        // NOT cards whose longer description happens to contain these phrases.
        if (/^(see more tasks|earn more)$/i.test(text.replace(/\s+/g, " ").trim())) return false;
        if (!hasValidHref) {
          const compactText = text.replace(/\s+/g, " ").trim();
          if (/^\+?\d+(?:\s*(?:pts?|points?|days?|ngày))?$/i.test(compactText)) return false;
          if (/^(?:(?:\+?\d[\d,.]*\s+)?bonus|.*streak|level up activities)$/i.test(compactText)) return false;
          if (/\b\d+\s+days\s+in\s+a\s+row\b/i.test(compactText)) return false;
        }

        return true;
      };

      window.buildRewardCardKey = function buildRewardCardKey({ href = "", title = "", text = "" }) {
        const normalizedTitle = window.normalizeRewardText(title || text).toLowerCase();
        return `${href}|${normalizedTitle}`;
      };

      window.buildQuestCardKey = function buildQuestCardKey({ href = "", text = "" }) {
        return `${href || "btn"}|${window.normalizeRewardText(text).toLowerCase()}`;
      };

      window.isActionableQuestActivity = function isActionableQuestActivity(meta = {}) {
        const innerLabel = window.normalizeRewardText(meta.innerLabel);
        const ariaLabel = window.normalizeRewardText(meta.ariaLabel);
        const label = window.normalizeRewardText(`${ariaLabel} ${innerLabel}`).toLowerCase();

        if (meta.isVisible === false) return false;
        const hasValidHref = Boolean(meta.href && !/^(?:#|javascript:)/i.test(meta.href.trim()));
        const isExclusiveApp =
          meta.isExclusiveAppCard ||
          /\b(?:rewards\s+app|bing\s+app|exclusive)\b/i.test(label) ||
          /[?&](?:PUBL=RewardsDO|form=ML2Y2H|rnoreward=1)\b/i.test(meta.href || "");

        if (meta.isDisabled && (!isExclusiveApp || !hasValidHref)) return false;
        if (meta.isInNav) return false;
        if (meta.isQuestCard) return false;
        if (!label) return false;
        if (QUEST_HEADING_RE.test(label)) return false;
        if (QUEST_META_RE.test(label)) return false;
        if (QUEST_CHROME_RE.test(label)) return false;
        if (QUEST_CLOSE_RE.test(innerLabel)) return false;
        if (QUEST_INFO_RE.test(innerLabel) || QUEST_INFO_RE.test(ariaLabel) || QUEST_INFO_RE.test(label)) return false;
        if (!hasValidHref && !meta.isPressable) return false;
        if (!hasValidHref && QUEST_STREAK_RE.test(label)) return false;

        if (meta.hasSuccessBadge) return false;

        const standaloneRatioMatches = [innerLabel, ariaLabel, label]
          .map((str) => (str || "").match(/^(\d+)\s*\/\s*([1-9]\d*)$/))
          .filter(Boolean);

        const hasIncompleteRatio = [
          ...window.collectProgressRatioMatches(label),
          ...standaloneRatioMatches,
        ].some((m) => Number(m[1]) < Number(m[2]));

        if (hasIncompleteRatio) {
          return true;
        }

        if (
          meta.isCompleted ||
          window.isCompletedQuestText(label) ||
          window.isCompletedQuestText(innerLabel) ||
          window.isCompletedQuestText(ariaLabel)
        ) {
          return false;
        }

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

async function fetchAndRestoreDailySet(tabId, { forceFresh = false } = {}) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const cached = await chrome.storage.local.get(["cachedDailySetData", "cachedDailySetDate"]);
    let dailySetData = cached?.cachedDailySetData;
    const cachedDate = cached?.cachedDailySetDate;

    if (forceFresh || !dailySetData || cachedDate !== today || !Array.isArray(dailySetData.cards) || dailySetData.cards.length === 0) {
      const flyoutRes = await fetch("https://www.bing.com/rewards/panelflyout", {
        credentials: "include",
      });
      if (flyoutRes.ok) {
        const flyoutHtml = await flyoutRes.text();
        dailySetData = extractDailySetFromFlyoutHtml(flyoutHtml);
        if (dailySetData && dailySetData.cards.length > 0) {
          await chrome.storage.local.set({ cachedDailySetData: dailySetData, cachedDailySetDate: today });
        }
      }
    }

    if (dailySetData && dailySetData.cards.length > 0) {
      console.log(
        `[Rewards] Restoring daily set: ${dailySetData.cards.length} cards, streak: ${dailySetData.streakDays} days, forceFresh=${forceFresh}`,
      );
      try {
        if (tabId) {
          await injectDomHelpers(tabId);
          await executeRewardsScript(tabId, {
            args: [dailySetData, forceFresh],
            func: (data, force) => {
              if (typeof window.ensurePersistentDailySet === "function") {
                return window.ensurePersistentDailySet(data, force);
              }
              if (typeof window.injectRestoredDailySet === "function") {
                return window.injectRestoredDailySet(data, force);
              }
              return false;
            },
          });
        }
      } catch (domErr) {
        if (!isProtectedPageScriptError(domErr)) throw domErr;
        // Edge blocks scripting on rewards.bing.com; dailySetData is cached in storage for popup/sidebar
      }

      // Background revalidation to keep data fresh without blocking UI
      if (!forceFresh) {
        fetch("https://www.bing.com/rewards/panelflyout", { credentials: "include" })
          .then((r) => (r.ok ? r.text() : ""))
          .then((html) => {
            if (!html) return;
            const freshData = extractDailySetFromFlyoutHtml(html);
            if (freshData && freshData.cards.length > 0) {
              chrome.storage.local.set({ cachedDailySetData: freshData, cachedDailySetDate: today });
              if (tabId) {
                executeRewardsScript(tabId, {
                  args: [freshData, true],
                  func: (data, force) => {
                    if (typeof window.ensurePersistentDailySet === "function") {
                      window.ensurePersistentDailySet(data, force);
                    }
                  },
                }).catch(() => {});
              }
            }
          })
          .catch(() => {});
      }

      return dailySetData;
    }
  } catch (err) {
    console.warn("[Rewards] fetchAndRestoreDailySet failed:", err);
  }
  return null;
}
globalThis.fetchAndRestoreDailySet = fetchAndRestoreDailySet;
globalThis.extractDailySetFromFlyoutHtml = extractDailySetFromFlyoutHtml;

const REWARD_MOBILE_DNR_RULE_ID = 9021;
const REWARD_MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0";

async function enableRewardMobileEmulation() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REWARD_MOBILE_DNR_RULE_ID],
      addRules: [
        {
          id: REWARD_MOBILE_DNR_RULE_ID,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "User-Agent", operation: "set", value: REWARD_MOBILE_USER_AGENT },
              { header: "sec-ch-ua-mobile", operation: "set", value: "?1" },
              { header: "sec-ch-ua-platform", operation: "set", value: '"Android"' },
              {
                header: "sec-ch-ua",
                operation: "set",
                value: '"Chromium";v="130", "Microsoft Edge";v="130", "Not?A_Brand";v="99"',
              },
            ],
          },
          condition: {
            urlFilter: "||bing.com/*",
            resourceTypes: [
              "main_frame",
              "sub_frame",
              "xmlhttprequest",
              "fetch",
              "other",
            ],
          },
        },
      ],
    });
    console.log("[Rewards] Mobile emulation DNR session rule enabled for Bing search");
  } catch (err) {
    console.warn("[Rewards] Failed to enable mobile emulation DNR rule:", err);
  }
}

async function disableRewardMobileEmulation() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REWARD_MOBILE_DNR_RULE_ID],
    });
    console.log("[Rewards] Mobile emulation DNR session rule disabled");
  } catch (err) {
    console.warn("[Rewards] Failed to disable mobile emulation DNR rule:", err);
  }
}
globalThis.enableRewardMobileEmulation = enableRewardMobileEmulation;
globalThis.disableRewardMobileEmulation = disableRewardMobileEmulation;

async function autoClickRewards() {
  console.log("⚡ Auto-clicking Bing Rewards cards...");
  await appendDebugLog("info", "rewards", "Rewards phase started");
  const rewardSectionIds = ["moreactivities"];
  const rewardUrls = [
    "https://rewards.bing.com/earn",
    "https://rewards.bing.com/dashboard",
  ];

  async function claimReadyPoints(tabId) {
    try {
      await injectDomHelpers(tabId);
      const scriptResults =
        await executeRewardsScript(tabId, {
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

          const centerPoint = (el) => {
            const rect = el.getBoundingClientRect();
            return {
              clientX: Math.round(rect.left + Math.max(rect.width / 2, 1)),
              clientY: Math.round(rect.top + Math.max(rect.height / 2, 1)),
            };
          };

          const clickElement = (el) => {
            if (!el) return false;
            try {
              el.scrollIntoView({ behavior: "instant", block: "center" });
            } catch { }

            try {
              if (typeof el.focus === "function") el.focus();
            } catch { }

            const pt = centerPoint(el);
            const common = {
              view: window,
              bubbles: true,
              cancelable: true,
              composed: true,
              clientX: pt.clientX,
              clientY: pt.clientY,
              screenX: pt.clientX,
              screenY: pt.clientY,
            };

            const PointerCtor = typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
            const sequence = [
              ["pointerover", PointerCtor, { pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: 0 }],
              ["pointerenter", PointerCtor, { pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: 0 }],
              ["mouseover", MouseEvent, { button: 0, buttons: 0 }],
              ["mouseenter", MouseEvent, { button: 0, buttons: 0 }],
              ["pointermove", PointerCtor, { pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: 0 }],
              ["mousemove", MouseEvent, { button: 0, buttons: 0 }],
              ["pointerdown", PointerCtor, { pointerId: 1, isPrimary: true, pointerType: "mouse", pressure: 0.5, button: 0, buttons: 1 }],
              ["mousedown", MouseEvent, { button: 0, buttons: 1 }],
              ["pointerup", PointerCtor, { pointerId: 1, isPrimary: true, pointerType: "mouse", pressure: 0, button: 0, buttons: 0 }],
              ["mouseup", MouseEvent, { button: 0, buttons: 0 }],
              ["click", MouseEvent, { button: 0, buttons: 0 }],
            ];

            for (const [type, Ctor, extra] of sequence) {
              try {
                el.dispatchEvent(new Ctor(type, { ...common, ...extra }));
              } catch { }
            }

            try {
              el.click();
            } catch { }
            return true;
          };

          const isSingleActivity = (el) => {
            if (!el || !(el instanceof HTMLElement)) return false;
            if (el.matches?.("section, body, #dailyset, #moreactivities, #ext-restored-dailyset")) return false;
            if (typeof window.findRewardCardRoots !== "function") {
              return Boolean(el.matches?.("button, [role='button'], [data-react-aria-pressable='true'], a"));
            }
            const roots = window.findRewardCardRoots(el);
            const count = roots.length === 0 && el.matches?.("button, [role='button'], [data-react-aria-pressable='true'], a") ? 1 : roots.length;
            return count === 1;
          };

          const findReadyToClaimCard = () => {
            const allButtons = Array.from(
              document.querySelectorAll("button, [role='button'], [data-react-aria-pressable='true'], a"),
            );
            for (const directCard of allButtons) {
              if (!isVisible(directCard) || directCard.disabled || directCard.getAttribute("aria-disabled") === "true") continue;
              const text = getNodeText(directCard);
              const matchesLabel = window.READY_TO_CLAIM_LABEL_RE
                ? window.READY_TO_CLAIM_LABEL_RE.test(text)
                : /ready to claim|sẵn sàng nhận|可领取|prêt à réclamer|bereit zum einlösen|listo para reclamar|готово к получению/i.test(text);
              if (!matchesLabel) continue;

              let points = typeof window.parsePointsFromText === "function"
                ? window.parsePointsFromText(text)
                : 0;
              let cardContainer = directCard;

              if (points === 0 && !/\d/.test(text)) {
                const parentCard = directCard.parentElement?.closest?.(
                  "[data-reward-card-name], [data-offer-id], [class*='rounded-cornerCardDefault'], [class*='card' i], [data-rac]:not(section):not(body), article, li",
                );
                if (parentCard && parentCard !== directCard && isSingleActivity(parentCard)) {
                  const containerText = getNodeText(parentCard);
                  const parentPoints = typeof window.parsePointsFromText === "function"
                    ? window.parsePointsFromText(containerText)
                    : 0;
                  if (parentPoints > 0) {
                    points = parentPoints;
                    cardContainer = parentCard;
                  }
                }
              }

              if (points > 0) {
                return {
                  cardButton: directCard,
                  cardContainer,
                  points,
                };
              }
            }

            const elements = collectAllElements(document);
            const candidates = elements.filter((el) => {
              if (!(el instanceof HTMLElement) || !isVisible(el)) return false;
              if (el.children.length > 2) return false;
              if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
              const text = getNodeText(el);
              return /ready to claim|sẵn sàng nhận|可领取|prêt à réclamer|bereit zum einlösen|listo para reclamar|готово к получению/i.test(text);
            });

            for (const cand of candidates) {
              const cardContainer =
                cand.closest(
                  "button, [role='button'], [data-react-aria-pressable='true'], [data-reward-card-name], [data-offer-id], [class*='rounded-cornerCardDefault'], [class*='card' i], [data-rac]:not(section):not(body), article, li",
                ) || cand.parentElement;
              if (!cardContainer || !isVisible(cardContainer) || !isSingleActivity(cardContainer)) continue;

              const clickable =
                cardContainer.querySelector(
                  "button, [role='button'], a[role='button'], [data-react-aria-pressable='true'], a[href]",
                ) ||
                (cardContainer.matches?.("button, [role='button'], a[role='button'], [data-react-aria-pressable='true'], a[href]")
                  ? cardContainer
                  : cand);

              const actionText = getNodeText(clickable) || getNodeText(cand);
              let points = typeof window.parsePointsFromText === "function"
                ? window.parsePointsFromText(actionText)
                : 0;

              if (points === 0 && !/\d/.test(actionText)) {
                if (cardContainer !== clickable) {
                  const containerText = getNodeText(cardContainer);
                  const containerPoints = typeof window.parsePointsFromText === "function"
                    ? window.parsePointsFromText(containerText)
                    : 0;
                  if (containerPoints > 0) {
                    points = containerPoints;
                  }
                }
              }

              if (points > 0) {
                return {
                  cardButton: clickable,
                  cardContainer,
                  points,
                };
              }
            }

            return null;
          };

          const findDialogClaimButton = (readyCardInfo) => {
            const CLAIM_POINTS_RE =
              window.CLAIM_MATCH_RE ||
              /claim points|nhận điểm|领取积分|réclamer des points|punkte einlösen|reclamar puntos|получить баллы|pending.*claim|\bclaim\b|\bnhận\b/i;

            const dialogs = collectAllElements(document).filter((el) => {
              if (!(el instanceof HTMLElement)) return false;
              if (!isVisible(el)) return false;
              if (el.classList?.contains("bottom-0") && el.classList?.contains("sticky")) return false;
              const role = (el.getAttribute("role") || "").toLowerCase();
              return (
                role === "dialog" ||
                el.tagName.toLowerCase() === "dialog" ||
                el.classList?.contains("shadow-shadowFlyout") ||
                el.classList?.contains("bg-flyout") ||
                el.getAttribute("aria-modal") === "true" ||
                (el.getAttribute("data-rac") !== null && /flyout|dialog|react-aria/i.test(el.className || "")) ||
                Boolean(el.querySelector?.("h2[slot='title'], [slot='title']"))
              );
            });

            if (!dialogs.length) return null;

            for (const scope of dialogs) {
              const buttons = Array.from(
                scope.querySelectorAll(
                  "button, [role='button'], [data-react-aria-pressable='true'], input[type='button'], input[type='submit']",
                ),
              );
              for (const btn of buttons) {
                if (!(btn instanceof HTMLElement) || !isVisible(btn)) continue;
                if (btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
                if (readyCardInfo && (btn === readyCardInfo.cardButton || (readyCardInfo.cardContainer && readyCardInfo.cardContainer.contains(btn)))) {
                  continue;
                }
                const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
                const slot = (btn.getAttribute("slot") || "").toLowerCase();
                if (slot === "close" || /close|dismiss|how it works|đóng|bỏ qua/i.test(ariaLabel)) continue;
                const text = getNodeText(btn);
                if (/how it works|close|dismiss|đóng|bỏ qua/i.test(text)) continue;
                if (window.READY_TO_CLAIM_LABEL_RE ? window.READY_TO_CLAIM_LABEL_RE.test(text) : /ready to claim|sẵn sàng nhận/i.test(text)) continue;
                if (CLAIM_POINTS_RE.test(text)) return btn;
              }
            }

            return null;
          };

          console.log("[Rewards-Debug] claimReadyPoints: Scanning for ready-to-claim cards...");
          const readyCard = findReadyToClaimCard();
          if (!readyCard || readyCard.points <= 0) {
            console.log("[Rewards-Debug] claimReadyPoints: No ready-to-claim card found.");
            return { clicked: false, claimedPoints: 0, reason: "not_ready" };
          }

          console.log("[Rewards-Debug] claimReadyPoints: Found ready card for " + readyCard.points + " points. Clicking...");
          clickElement(readyCard.cardButton);
          if (typeof window.dispatchRewardPress === "function") {
            try { window.dispatchRewardPress(readyCard.cardButton); } catch { }
          }
          if (readyCard.cardContainer && readyCard.cardContainer !== readyCard.cardButton) {
            clickElement(readyCard.cardContainer);
            const claimTextEl = Array.from(readyCard.cardContainer.querySelectorAll("p, span, div")).find((el) => /claim|nhận/i.test(getNodeText(el)));
            if (claimTextEl) {
              clickElement(claimTextEl);
              if (typeof window.dispatchRewardPress === "function") {
                try { window.dispatchRewardPress(claimTextEl); } catch { }
              }
            }
          }

          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await sleep(pollMs);

            if (attempt >= 2) {
              const checkCard = findReadyToClaimCard();
              if (!checkCard || checkCard.points === 0) {
                console.log("[Rewards-Debug] claimReadyPoints: Ready card is gone or points 0, claim succeeded directly!");
                return { clicked: true, claimedPoints: readyCard.points, reason: "claimed_directly" };
              }
            }

            const claimPointsButton = findDialogClaimButton(readyCard);
            if (!claimPointsButton) {
              if ((attempt + 1) % 3 === 0) {
                console.log("[Rewards-Debug] claimReadyPoints: Dialog not opened yet, re-clicking card button...");
                const currentCard = findReadyToClaimCard();
                const btnToClick = currentCard?.cardButton || readyCard.cardButton;
                clickElement(btnToClick);
                if (typeof window.dispatchRewardPress === "function") {
                  try { window.dispatchRewardPress(btnToClick); } catch { }
                }
              }
              continue;
            }

            console.log("[Rewards-Debug] claimReadyPoints: Claim points dialog found. Clicking claim...");
            const dialogScope =
              claimPointsButton.closest("dialog, [role='dialog'], [class*='flyout' i], section") ||
              null;
            clickElement(claimPointsButton);
            if (typeof window.dispatchRewardPress === "function") {
              try { window.dispatchRewardPress(claimPointsButton); } catch { }
            }
            const innerTarget = claimPointsButton.querySelector(
              "[class*='brand' i], [class*='Button'], span[class*='text' i], span",
            );
            if (innerTarget && innerTarget !== claimPointsButton && isVisible(innerTarget)) {
              clickElement(innerTarget);
              if (typeof window.dispatchRewardPress === "function") {
                try { window.dispatchRewardPress(innerTarget); } catch { }
              }
            }
            await sleep(2500);

            if (dialogScope) {
              const closeSelectors =
                "button[slot='close'], button[aria-label='Close' i], button[aria-label='Đóng' i], button[aria-label='Schließen' i], button[aria-label='Fermer' i], button[aria-label='Cerrar' i], button[aria-label='关闭' i], button[aria-label='Закрыть' i]";
              const closeBtn =
                Array.from(dialogScope.querySelectorAll(closeSelectors)).find((el) => el instanceof HTMLElement && isVisible(el)) ||
                collectAllElements(dialogScope).find((el) => {
                  if (!(el instanceof HTMLElement) || !isVisible(el)) return false;
                  if (!el.matches?.("button, [role='button'], [data-react-aria-pressable='true']")) return false;
                  const aria = (el.getAttribute("aria-label") || "").toLowerCase();
                  const slot = el.getAttribute("slot") || "";
                  return slot === "close" || /^(close|dismiss|đóng|schließen|fermer|cerrar|关闭|закрыть)$/i.test(aria);
                });
              if (closeBtn) {
                clickElement(closeBtn);
              }
            }

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
  } catch (e) {
    const isBlocked = isProtectedPageScriptError(e) || e?.code === "PAGE_SCRIPTING_BLOCKED";
    const notScriptable = e?.code === "REWARDS_TAB_NOT_SCRIPTABLE";
    console.warn("[Rewards] claimReadyPoints skipped or failed:", e?.message || e);
    return {
      clicked: false,
      claimedPoints: 0,
      reason: isBlocked
        ? "page_scripting_blocked"
        : notScriptable
          ? "tab_not_scriptable"
          : (e?.message || "script_failed"),
    };
  }
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

  async function waitForRewardsDomReady(
    tabId,
    targetSectionIds = [],
    timeoutMs = 45000,
    previouslyHydrated = false,
  ) {
    await injectDomHelpers(tabId);
    try {
      await waitForTabComplete(
        tabId,
        Math.max(1000, Math.min(TAB_LOAD_TIMEOUT_MS, timeoutMs)),
      );
      await ensureTabFocused(tabId);

      const scriptRes =
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [targetSectionIds || rewardSectionIds, timeoutMs, previouslyHydrated],
          func: async (sectionIds, maxWaitMs, allowPreviouslyHydratedEmpty) => {
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
              hydratedCards: 0,
              hydrated: false,
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
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
                return false;
              }
              if (typeof el.checkVisibility === "function") {
                if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
                  return false;
                }
              }
              if (typeof el.getBoundingClientRect === "function") {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return true;
                for (const child of el.children || []) {
                  if (typeof child.getBoundingClientRect === "function") {
                    const childRect = child.getBoundingClientRect();
                    if (childRect.width > 0 && childRect.height > 0) return true;
                  }
                }
              }
              return false;
            };

            const expandSectionIfCollapsed = (section) => {
              if (!section) return;
              if (typeof window.expandRewardSection === "function") {
                try {
                  window.expandRewardSection(section);
                  return;
                } catch { }
              }
              const triggers = section.querySelectorAll?.(
                "button[slot='trigger'][aria-expanded='false'], button[aria-expanded='false'][aria-controls], [data-rac][aria-expanded='false'][slot='trigger'], [data-react-aria-pressable='true'][aria-expanded='false'], [aria-expanded='false'][aria-controls], [role='button'][aria-expanded='false'][aria-controls]",
              ) || [];
              for (const trigger of triggers) {
                try {
                  if (typeof window.dispatchRewardPress === "function") {
                    window.dispatchRewardPress(trigger);
                  } else {
                    trigger.click();
                  }
                } catch { }
              }
            };

            const isRewardCardShell = (card, rootNode) => {
              if (!isVisible(card)) return false;
              if (card.closest("nav, header, footer, [role='banner'], #quests")) return false;
              if (window.isRewardSectionChrome(card, rootNode)) return false;
              if (card.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") || card.closest("h1, h2, h3, h4")) {
                return false;
              }
              const text = normalizeText(card.innerText || card.textContent || "");
              const href =
                card.getAttribute?.("href") ||
                card.querySelector?.("a[href]")?.getAttribute?.("href") ||
                "";
              const isPressable =
                card.matches?.("button, [role='button'], [role='link'], [data-react-aria-pressable='true']") ||
                !!card.querySelector?.("[data-react-aria-pressable='true'], button, [role='button'], [role='link']");
              if (!text || (!href && !isPressable)) return false;
              if (!card.querySelector("img, mee-icon, svg, .mee-icon, [class*='icon'], [class*='Icon'], picture")) return false;
              return true;
            };

            const isPendingCard = (card, rootNode) => {
              if (!isRewardCardShell(card, rootNode)) return false;
              if (card.getAttribute("aria-disabled") === "true" || card.closest("[aria-disabled='true'], [data-disabled='true']")) {
                return false;
              }
              const text = normalizeText(card.innerText || card.textContent || "");
              if (!text || completedText(text)) return false;
              if (/^(see more tasks|earn more)$/i.test(text)) return false;
              return true;
            };

            const countSectionCards = (section) => {
              if (!section) return 0;
              expandSectionIfCollapsed(section);
              try { section.scrollIntoView({ behavior: "instant", block: "center" }); } catch { }
              return window.findRewardCardRoots(section)
                .filter((card) => isPendingCard(card, section))
                .length;
            };

            const countSectionCardShells = (section) => {
              if (!section) return 0;
              return window.findRewardCardRoots(section)
                .filter((card) => isRewardCardShell(card, section))
                .length;
            };

            const countFallbackCards = () => {
              expandSectionIfCollapsed(document);
              return Array.from(
                document.querySelectorAll("a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault'], a[href][data-react-aria-pressable='true']"),
              )
                .filter((anchor) => window.isDashboardRewardHref(anchor.href || anchor.getAttribute("href") || ""))
                .filter((anchor) => isPendingCard(anchor, document))
                .length;
            };

            const countFallbackCardShells = () => {
              expandSectionIfCollapsed(document);
              return Array.from(
                document.querySelectorAll("a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault'], a[href][data-react-aria-pressable='true']"),
              )
                .filter((anchor) => window.isDashboardRewardHref(anchor.href || anchor.getAttribute("href") || ""))
                .filter((anchor) => isRewardCardShell(anchor, document))
                .length;
            };

            while (Date.now() - startedAt < maxWaitMs) {
              attempts++;
              const ids = Array.isArray(sectionIds) ? sectionIds : [];
              const sections = ids
                .filter((id) => id && id !== "global")
                .map((id) => document.querySelector(`#${id}`))
                .filter(Boolean);
              const dailyset = document.querySelector("#dailyset") || document.querySelector("#ext-restored-dailyset");
              const sectionCards = sections.reduce((sum, section) => sum + countSectionCards(section), 0);
              const sectionCardShells = sections.reduce((sum, section) => sum + countSectionCardShells(section), 0);
              const fallbackCards =
                (
                  ((ids.includes("dailyset") || ids.includes("ext-restored-dailyset")) && /rewards\.bing\.com\/dashboard/i.test(location.href)) ||
                  (ids.includes("moreactivities") && /rewards\.bing\.com\/earn/i.test(location.href))
                )
                  ? countFallbackCards()
                  : 0;
              const fallbackCardShells =
                (
                  ((ids.includes("dailyset") || ids.includes("ext-restored-dailyset")) && /rewards\.bing\.com\/dashboard/i.test(location.href)) ||
                  (ids.includes("moreactivities") && /rewards\.bing\.com\/earn/i.test(location.href))
                )
                  ? countFallbackCardShells()
                  : 0;
              const count = Math.max(sectionCards, fallbackCards);
              const hydratedCards = Math.max(sectionCardShells, fallbackCardShells);
              const directRoundedAnchors = document.querySelectorAll(
                "a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']",
              ).length;
              const targetSectionDirectRoundedAnchors = sections.reduce(
                (sum, s) =>
                  sum +
                  (s.querySelectorAll?.(
                    "a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']",
                  )?.length || 0),
                0,
              );
              const hydrated =
                hydratedCards > 0 ||
                targetSectionDirectRoundedAnchors > 0 ||
                (sections.length === 0 && directRoundedAnchors > 0) ||
                allowPreviouslyHydratedEmpty === true;
              const hasTargetSection = sections.length > 0;

              const now = Date.now();
              if (document.readyState === "complete" && hasTargetSection && hydrated && count === 0) {
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
                hydratedCards,
                hydrated,
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

              if (window.shouldFinishEmptyRewardScan({
                ...last,
                hasTargetSection: hasTargetSection && hydrated,
              })) {
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
      await executeRewardsScript(tabId, {
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
            if (window.isCompletedQuestText?.(linkText)) continue;

            const key = window.buildQuestCardKey({ href, text: linkText });

            // Dedup by stable key to avoid re-processing the same quest
            // when dynamic text like "2/7 tasks" changes to "4/7 tasks" after activities.
            const cleanText = (str) =>
              str
                ? window.normalizeRewardText(str)
                    .replace(/\b\d+\s*\/\s*\d+(?:\s+tasks?)?\b/gi, "")
                    .replace(/\bexpires\s+in\s+[^.]+/gi, "")
                    .replace(/\s+/g, " ")
                    .trim()
                : "";
            const normalizedButtonText = cleanText(linkText);
            const cardContainer =
              node.closest(".rounded-cornerCardDefault, [role='article'], li") ||
              node.closest("div[class*='card' i]") ||
              node;
            const rawHeading =
              node.querySelector("h2, h3, h4, [class*='title'], [class*='Title']")?.textContent ||
              cardContainer.querySelector("h2, h3, h4, [class*='title'], [class*='Title']")?.textContent;
            const cardId =
              node.id ||
              cleanText(node.getAttribute("aria-label")) ||
              cleanText(rawHeading) ||
              normalizedButtonText;
            const domIndex = cardContainer.parentElement
              ? Array.prototype.indexOf.call(cardContainer.parentElement.children, cardContainer)
              : -1;
            const isDistinctQuestHref = href && !/^(?:#|javascript:)/i.test(href);
            const fallbackIndex = domIndex >= 0 ? domIndex : 0;
            let stableKey;
            if (isDistinctQuestHref) {
              stableKey = cardId ? `${href}|${cardId}` : `${href}|${fallbackIndex}`;
            } else {
              stableKey = cardId ? `btn|${cardId}` : `btn|quest|${fallbackIndex}`;
            }

            if (seen.has(stableKey)) continue;
            seen.add(stableKey);

            items.push({
              href: key,   // kept for clickQuestCard matching
              key: key,
              actualHref: stableKey, // stable key for attemptedQuestKeys dedup
            });
          }

          console.log("[Rewards-Debug] getQuestCards: Returning " + items.length + " valid actionable quest cards.");
          return items;
        },
      });

    return Array.isArray(questCards) ? questCards : [];
  }

  async function clickQuestCard(tabId, targetHref) {
    await injectDomHelpers(tabId);
    const [{ result: clicked = false }] =
      await executeRewardsScript(tabId, {
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
      await executeRewardsScript(tabId, {
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
              "a[href], button, [role='button'], [role='link'], [data-react-aria-pressable='true']"
            )
          );
          
          const uniqueCards = new Set();
          const activityCards = [];
          for (const cand of candidates) {
            const card = cand.closest(".flex-row, [role='row'], [role='listitem'], .rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']") || cand;
            if (!uniqueCards.has(card) && isVisible(card) && !card.closest("#quests")) {
              uniqueCards.add(card);
              activityCards.push({ card, cand });
            }
          }
          console.log("[Rewards-Debug] getQuestActivities: Found " + activityCards.length + " activity cards inside root. Filtering actionable ones...");

          const seen = new Set();
          const items = [];
          for (const { card, cand } of activityCards) {
            const cardText = window.normalizeRewardText(card.innerText || card.textContent || "");
            const actionTarget = cand;
            const href = actionTarget.href || actionTarget.getAttribute("href") || card.getAttribute("href") || card.querySelector("[href]")?.getAttribute("href") || "";
            const innerLabel = window.normalizeRewardText(actionTarget.innerText || actionTarget.textContent || cardText);
            const ariaLabel = window.normalizeRewardText(actionTarget.getAttribute("aria-label") || card.getAttribute("aria-label") || "");
            const label = ariaLabel || innerLabel || cardText;
            const hasSuccessBadge =
              !!card.closest("[class*='completed'], [class*='Success']") ||
              (typeof window.isCardCompleted === "function"
                ? window.isCardCompleted(card)
                : !!card.querySelector(
                    "svg[class*='Success'], mee-icon[class*='Success'], svg[class*='statusSuccess'], mee-icon[class*='statusSuccess'], mee-icon[class*='CheckMark'], svg[class*='CheckMark'], mee-icon[class*='checkMark'], svg[class*='checkMark']",
                  ));
            let isCompleted = hasSuccessBadge;
            if (!isCompleted && typeof window.isCardCompleted !== "function") {
              const statusEls = card.querySelectorAll(
                "[class*='metadata'], [class*='fgCtrlNeutralSecondary']",
              );
              for (const el of statusEls) {
                const t = window.normalizeRewardText(el.textContent || "");
                if (typeof window.isCompletedQuestText === "function") {
                  if (window.isCompletedQuestText(t)) {
                    isCompleted = true;
                    break;
                  }
                } else if (typeof window.isCompletedText === "function" && window.isCompletedText(t)) {
                  isCompleted = true;
                  break;
                }
              }
            }
            const isExclusiveApp =
              /\b(?:rewards\s+app|bing\s+app|exclusive)\b/i.test(`${label} ${cardText}`) ||
              /[?&](?:PUBL=RewardsDO|form=ML2Y2H|rnoreward=1)\b/i.test(href);
            const isActionable = window.isActionableQuestActivity({
              href,
              innerLabel: label,
              ariaLabel: "",
              isVisible: true,
              isPressable: actionTarget.matches?.("button, [role='button'], [role='link'], a[href], [data-react-aria-pressable='true']"),
              isDisabled:
                actionTarget.getAttribute("aria-disabled") === "true" ||
                !!actionTarget.closest("[aria-disabled='true'], [data-disabled='true']"),
              isInNav: !!card.closest("nav, header, [role='banner']"),
              isQuestCard: false,
              hasSuccessBadge,
              isCompleted,
              isExclusiveAppCard: isExclusiveApp,
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
      await executeRewardsScript(tabId, {
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
                  "a[href], button, [role='button'], [role='link'], [data-react-aria-pressable='true']"
                )
              );
              
              const uniqueCards = new Set();
              const cards = [];
              for (const cand of candidates) {
                const card = cand.closest(".flex-row, [role='row'], [role='listitem'], .rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']") || cand;
                if (!uniqueCards.has(card) && isVisible(card) && !card.closest("#quests")) {
                  uniqueCards.add(card);
                  cards.push({ card, cand });
                }
              }

              for (const { card: candidate, cand: target } of cards) {
                const cardText = window.normalizeRewardText(candidate.innerText || candidate.textContent || "");
                const href = target.href || target.getAttribute("href") || candidate.getAttribute("href") || candidate.querySelector("[href]")?.getAttribute("href") || "";
                const innerLabel = window.normalizeRewardText(target.innerText || target.textContent || cardText);
                const ariaLabel = window.normalizeRewardText(target.getAttribute("aria-label") || candidate.getAttribute("aria-label") || "");
                const candKey = window.buildQuestActivityKey({
                  href,
                  innerLabel: `${cardText} ${ariaLabel || innerLabel || cardText}`,
                  ariaLabel: "",
                });
                const hasSuccessBadge =
                  !!candidate.closest("[class*='completed'], [class*='Success']") ||
                  (typeof window.isCardCompleted === "function"
                    ? window.isCardCompleted(candidate)
                    : !!candidate.querySelector(
                        "svg[class*='Success'], mee-icon[class*='Success'], svg[class*='statusSuccess'], mee-icon[class*='statusSuccess'], mee-icon[class*='CheckMark'], svg[class*='CheckMark'], mee-icon[class*='checkMark'], svg[class*='checkMark']",
                      ));
                let isCompleted = hasSuccessBadge;
                if (!isCompleted && typeof window.isCardCompleted !== "function") {
                  const statusEls = candidate.querySelectorAll(
                    "[class*='metadata'], [class*='fgCtrlNeutralSecondary']",
                  );
                  for (const el of statusEls) {
                    const t = window.normalizeRewardText(el.textContent || "");
                    if (typeof window.isCompletedQuestText === "function") {
                      if (window.isCompletedQuestText(t)) {
                        isCompleted = true;
                        break;
                      }
                    } else if (typeof window.isCompletedText === "function" && window.isCompletedText(t)) {
                      isCompleted = true;
                      break;
                    }
                  }
                }
                const isExclusiveApp =
                  /\b(?:rewards\s+app|bing\s+app|exclusive)\b/i.test(`${ariaLabel} ${innerLabel} ${cardText}`) ||
                  /[?&](?:PUBL=RewardsDO|form=ML2Y2H|rnoreward=1)\b/i.test(href);
                const isMatchable = window.isActionableQuestActivity({
                  href,
                  innerLabel: innerLabel || cardText,
                  ariaLabel,
                  isVisible: true,
                  isPressable: target.matches?.("button, [role='button'], [role='link'], a[href], [data-react-aria-pressable='true']"),
                  isDisabled:
                    target.getAttribute("aria-disabled") === "true" ||
                    !!target.closest("[aria-disabled='true'], [data-disabled='true']"),
                  isInNav: !!candidate.closest("nav, header, [role='banner']"),
                  isQuestCard: false,
                  hasSuccessBadge,
                  isCompleted,
                  isExclusiveAppCard: isExclusiveApp,
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
            clicked:
              success ||
              Boolean(
                actionEl?.getAttribute?.("href") ||
                actionEl?.href ||
                el?.getAttribute?.("href") ||
                el?.href
              ),
            href:
              actionEl?.href ||
              actionEl?.getAttribute?.("href") ||
              el?.href ||
              el?.getAttribute?.("href") ||
              "",
          };
        },
      });

    return clicked;
  }

  async function getRewardCards(
    tabId,
    targetSectionIds,
    initialStableEmptySince = null,
    maxScanMs = 40000,
    previouslyHydrated = false,
  ) {
    await injectDomHelpers(tabId);
    const scanTimeoutMs = Math.max(1000, Math.min(40000, maxScanMs));
    let scanTimeoutId;
    const scanExecution = executeRewardsScript(tabId, {
      args: [
        targetSectionIds || rewardSectionIds,
        initialStableEmptySince,
        scanTimeoutMs,
        previouslyHydrated,
      ],
      func: (sectionIds, carriedStableEmptySince, maxWaitMs, allowPreviouslyHydratedEmpty) => {
        return new Promise((resolve) => {
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
              return false;
            }
            if (typeof el.checkVisibility === "function") {
              if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
                return false;
              }
            }
            if (typeof el.getBoundingClientRect === "function") {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return true;
              for (const child of el.children || []) {
                if (typeof child.getBoundingClientRect === "function") {
                  const childRect = child.getBoundingClientRect();
                  if (childRect.width > 0 && childRect.height > 0) return true;
                }
              }
            }
            return false;
          };

            function expandSectionIfCollapsed(section) {
              if (!section) return;
              if (typeof window.expandRewardSection === "function") {
                try {
                  window.expandRewardSection(section);
                  return;
                } catch { }
              }
              const triggers = section.querySelectorAll?.(
                "button[slot='trigger'][aria-expanded='false'], button[aria-expanded='false'][aria-controls], [data-rac][aria-expanded='false'][slot='trigger'], [data-react-aria-pressable='true'][aria-expanded='false'], [aria-expanded='false'][aria-controls], [role='button'][aria-expanded='false'][aria-controls]",
              ) || [];
              for (const trigger of triggers) {
                try {
                  if (typeof window.dispatchRewardPress === "function") {
                    window.dispatchRewardPress(trigger);
                  } else {
                    trigger.click();
                  }
                } catch { }
              }
            }

            function isCardCompleted(cardEl) {
              if (typeof window.isCardCompleted === "function") {
                return window.isCardCompleted(cardEl);
              }
              if (!cardEl) return false;
              if (
                cardEl.querySelector(
                  "svg[class*='Success'], mee-icon[class*='Success'], svg[class*='statusSuccess'], mee-icon[class*='statusSuccess'], mee-icon[class*='CheckMark'], svg[class*='CheckMark'], mee-icon[class*='checkMark'], svg[class*='checkMark']",
                )
              ) {
                return true;
              }
              const statusEls = cardEl.querySelectorAll(
                "[class*='metadata'], [class*='fgCtrlNeutralSecondary']",
              );
              for (const el of statusEls) {
                const t = typeof window.normalizeRewardText === "function"
                  ? window.normalizeRewardText(el.textContent || "")
                  : (el.textContent || "").replace(/\s+/g, " ").trim();
                if (typeof window.isCompletedQuestText === "function") {
                  if (window.isCompletedQuestText(t)) return true;
                } else if (typeof window.isCompletedText === "function" && window.isCompletedText(t)) {
                  return true;
                }
              }
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
              if (meta.isSectionChrome) reasons.push("section_chrome");
              if (!meta.hasVisual) reasons.push("no_visual");
              if (!text) reasons.push("no_text");
              if (!href && !meta.isPressable) reasons.push("no_href_or_pressable");
              if (meta.isHeader) reasons.push("header");
              if (/^(?:https?:\/\/rewards\.bing\.com)?\/earn\/?(?:[?#].*)?$/i.test(href)) reasons.push("earn_link");
              if (/^(see more tasks|earn more)$/i.test(text.replace(/\s+/g, " ").trim())) reasons.push("nav_button");
              return reasons;
            }

            function isHydratedRewardCardShell(meta) {
              return window.isActionableRewardCard({
                ...meta,
                isCompleted: false,
                isDisabled: false,
              });
            }

            function collectSectionCardsById(sectionId, debugSections) {
              let section = null;
              const sectionDebug = {
                sectionId,
                exists: true,
                directRoundedAnchors: 0,
                cardRoots: 0,
                accepted: 0,
                completed: 0,
                sectionChrome: 0,
                cardShells: 0,
                hydrated: false,
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
              const cardRoots = window.findRewardCardRoots(rootNode);
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
                  isSectionChrome: window.isRewardSectionChrome(card, rootNode),
                  isHeader: card.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") || !!card.closest("h1, h2, h3, h4"),
                  isPressable: card.matches?.("button, [role='button'], [role='link'], [data-react-aria-pressable='true']") || !!card.querySelector("[data-react-aria-pressable='true'], button, [role='button'], [role='link']"),
                };
                if (meta.isCompleted) sectionDebug.completed++;
                if (meta.isSectionChrome) sectionDebug.sectionChrome++;
                if (isHydratedRewardCardShell(meta)) sectionDebug.cardShells++;
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
                        isSectionChrome: meta.isSectionChrome,
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
                  isSectionChrome: window.isRewardSectionChrome(anchor, rootNode),
                  isHeader: anchor.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") || !!anchor.closest("h1, h2, h3, h4"),
                  isPressable: true,
                };
                if (meta.isCompleted) sectionDebug.completed++;
                if (meta.isSectionChrome) sectionDebug.sectionChrome++;
                if (isHydratedRewardCardShell(meta)) sectionDebug.cardShells++;

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
                        isSectionChrome: meta.isSectionChrome,
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
              sectionDebug.hydrated =
                sectionDebug.cardShells > 0 ||
                sectionDebug.completed > 0 ||
                sectionDebug.directRoundedAnchors > 0;
              return unique;
            }

            function collectPageRewardFallbackCards(debugSections, sectionId) {
              expandSectionIfCollapsed(document);
              const sectionDebug = {
                sectionId,
                exists: true,
                directRoundedAnchors: document.querySelectorAll(
                  "a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']",
                ).length,
                cardRoots: 0,
                accepted: 0,
                completed: 0,
                sectionChrome: 0,
                cardShells: 0,
                hydrated: false,
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
                  isSectionChrome: window.isRewardSectionChrome(anchor, document),
                  isHeader: anchor.matches?.("h1, h2, h3, h4, [slot='trigger'], [aria-expanded][aria-controls]") || !!anchor.closest("h1, h2, h3, h4"),
                  isPressable: true,
                };
                if (meta.isCompleted) sectionDebug.completed++;
                if (meta.isSectionChrome) sectionDebug.sectionChrome++;
                if (isHydratedRewardCardShell(meta)) sectionDebug.cardShells++;

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
                        isSectionChrome: meta.isSectionChrome,
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

              sectionDebug.hydrated =
                sectionDebug.cardShells > 0 ||
                sectionDebug.completed > 0 ||
                sectionDebug.directRoundedAnchors > 0;
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
              if (typeof window.buildRewardCardKey === "function") {
                return window.buildRewardCardKey({
                  href,
                  title: rawTitle,
                  text: card?.innerText || card?.textContent || "",
                });
              }
              const normalized = (rawTitle || card?.innerText || card?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
              return `${href || "btn"}|${normalized}`;
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
                const isRestored = Boolean(
                  (typeof card?.closest === "function" && card.closest("#ext-restored-dailyset")) ||
                  card?.id === "ext-restored-dailyset" ||
                  (typeof card?.getAttribute === "function" && card.getAttribute("data-reward-card-name")) ||
                  (typeof card?.querySelector === "function" && card.querySelector("[data-reward-card-name]"))
                );
                const offerId = (typeof card?.getAttribute === "function" && card.getAttribute("data-offer-id")) || "";
                const authKey = (typeof card?.getAttribute === "function" && card.getAttribute("data-auth-key")) || "";
                const activityType = (typeof card?.getAttribute === "function" && card.getAttribute("data-activity-type")) || "";
                const userId = (typeof card?.getAttribute === "function" && card.getAttribute("data-user-id")) || "";
                items.push({ key, href, isRestored, offerId, authKey, activityType, userId });
              }

              return items;
            }

            let attempts = 0;
            const pollMs = 1500;
            const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / pollMs));
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
                    ((sectionIds || []).includes("dailyset") || (sectionIds || []).includes("ext-restored-dailyset")) &&
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
                const hydrated =
                  allowPreviouslyHydratedEmpty === true ||
                  debug.some(
                    (section) =>
                      ((sectionIds || []).includes(section.sectionId) || section.sectionId.endsWith("_fallback")) &&
                      section.exists === true &&
                      section.hydrated === true,
                  );

                if (cards.length === prevCount) {
                  stableRounds++;
                } else {
                  stableRounds = 0;
                }
                prevCount = cards.length;

                const now = Date.now();
                if (document.readyState === "complete" && hasTargetSection && hydrated && cards.length === 0) {
                  if (stableEmptySince === null) stableEmptySince = now;
                } else {
                  stableEmptySince = null;
                }
                const stableEmptyMs = stableEmptySince === null ? 0 : now - stableEmptySince;

                const stableEmpty = window.shouldFinishEmptyRewardScan({
                  readyState: document.readyState,
                  hasTargetSection: hasTargetSection && hydrated,
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
                    hydrated,
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
      }, scanTimeoutMs + 1500);
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
    const hydrationStatus = classifyRewardScanState({
      cardsCount: Array.isArray(rewardCards) ? rewardCards.length : 0,
      sections: debug,
      targetSectionIds: targetSectionIds || rewardSectionIds,
      stableEmpty: scanResult?.reason === "stable_empty",
      previouslyHydrated,
    });
    const compactSections = debug.map((s) => ({
      sectionId: s.sectionId,
      exists: s.exists,
      hydrated: s.hydrated,
      cardRoots: s.cardRoots,
      accepted: s.accepted,
      completed: s.completed,
      directRoundedAnchors: s.directRoundedAnchors,
      sectionChrome: s.sectionChrome,
      cardShells: s.cardShells,
      rejectionReasons: [...new Set((s.rejected || []).flatMap((r) => (typeof r === "object" && r ? r.reasons || [] : [r])))],
      filteredOutCount: (s.filteredOut || []).length,
    }));
    await appendDebugLog("info", "rewards", "Reward card scan diagnostics", {
      tabId,
      sections: compactSections,
      attempts: scanResult?.attempts,
      reason: scanResult?.reason,
      stableEmptyMs: scanResult?.stableEmptyMs,
      error: scanResult?.error,
      hydrationStatus,
      hydrated: scanResult?.hydrated === true,
      cards: Array.isArray(rewardCards) ? rewardCards.length : 0,
    });
    return {
      cards: Array.isArray(rewardCards) ? rewardCards : [],
      reason: scanResult?.reason,
      hydrationStatus,
      hydrated: scanResult?.hydrated === true,
      sections: debug,
      stableEmptyMs: scanResult?.stableEmptyMs,
      error: scanResult?.error,
    };
  }

  async function clickRewardCard(tabId, targetKey, targetSectionIds) {
    await injectDomHelpers(tabId);
    const scriptResults =
      await executeRewardsScript(tabId, {
        args: [targetKey, targetSectionIds || rewardSectionIds],
        func: async (keyToClick, sectionIds) => {
          console.log("[Rewards-Debug] clickRewardCard: Attempting to click reward card with key:", keyToClick);
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
              return false;
            }
            if (typeof el.checkVisibility === "function") {
              if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
                return false;
              }
            }
            if (typeof el.getBoundingClientRect === "function") {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return true;
              for (const child of el.children || []) {
                if (typeof child.getBoundingClientRect === "function") {
                  const childRect = child.getBoundingClientRect();
                  if (childRect.width > 0 && childRect.height > 0) return true;
                }
              }
            }
            return false;
          };

          const isDisabled = (el) =>
            !el ||
            el.getAttribute("aria-disabled") === "true" ||
            !!el.closest("[aria-disabled='true'], [data-disabled='true']");

          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

          function expandSectionIfCollapsed(section) {
            if (!section) return;
            if (typeof window.expandRewardSection === "function") {
              try {
                window.expandRewardSection(section);
                return;
              } catch { }
            }
            const triggers = section.querySelectorAll?.(
              "button[slot='trigger'][aria-expanded='false'], button[aria-expanded='false'][aria-controls], [data-rac][aria-expanded='false'][slot='trigger'], [data-react-aria-pressable='true'][aria-expanded='false'], [aria-expanded='false'][aria-controls], [role='button'][aria-expanded='false'][aria-controls]",
            ) || [];
            for (const trigger of triggers) {
              try {
                if (typeof window.dispatchRewardPress === "function") {
                  window.dispatchRewardPress(trigger);
                } else {
                  trigger.click();
                }
              } catch { }
            }
          }

          function isCardCompleted(cardEl) {
            if (typeof window.isCardCompleted === "function") {
              return window.isCardCompleted(cardEl);
            }
            if (!cardEl) return false;
            if (
              cardEl.querySelector(
                "svg[class*='Success'], mee-icon[class*='Success'], svg[class*='statusSuccess'], mee-icon[class*='statusSuccess'], mee-icon[class*='CheckMark'], svg[class*='CheckMark'], mee-icon[class*='checkMark'], svg[class*='checkMark']",
              )
            ) {
              return true;
            }
            const statusEls = cardEl.querySelectorAll(
              "[class*='metadata'], [class*='fgCtrlNeutralSecondary']",
            );
            for (const el of statusEls) {
              const t = typeof window.normalizeRewardText === "function"
                ? window.normalizeRewardText(el.textContent || "")
                : (el.textContent || "").replace(/\s+/g, " ").trim();
              if (typeof window.isCompletedQuestText === "function") {
                if (window.isCompletedQuestText(t)) return true;
              } else if (typeof window.isCompletedText === "function" && window.isCompletedText(t)) {
                return true;
              }
            }
            return false;
          }

          function collectSectionCardsById(sectionId) {
            let section = null;
            if (sectionId !== "global") {
              section = document.querySelector(`#${sectionId}`);
              if (!section) return [];
              expandSectionIfCollapsed(section);
            }
            const rootNode = section || document;
            const cardRoots = window.findRewardCardRoots(rootNode);

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
                isSectionChrome: window.isRewardSectionChrome(card, rootNode),
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
                isSectionChrome: window.isRewardSectionChrome(anchor, rootNode),
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
            expandSectionIfCollapsed(document);
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
                isSectionChrome: window.isRewardSectionChrome(anchor, document),
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
            if (typeof window.buildRewardCardKey === "function") {
              return window.buildRewardCardKey({
                href,
                title: rawTitle,
                text: card?.innerText || card?.textContent || "",
              });
            }
            const normalized = (rawTitle || card?.innerText || card?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            return `${href || "btn"}|${normalized}`;
          }

          function getCardSignature(card) {
            if (!card) return "";
            const href = card?.getAttribute?.("href") || card?.href || "";
            const expanded =
              card.getAttribute("aria-expanded") ||
              card.querySelector("[aria-expanded]")?.getAttribute("aria-expanded") ||
              "";
            const disabled = isDisabled(card) ? "disabled" : "enabled";
            const status = (typeof window.normalizeRewardText === "function"
              ? window.normalizeRewardText(card?.innerText || card?.textContent || "")
              : (card?.innerText || card?.textContent || "").replace(/\s+/g, " ").trim()).toLowerCase();
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
            if (!target || (typeof target.isConnected === "boolean" && !target.isConnected) || !isVisible(target) || isDisabled(target)) return false;

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
              return "external"; // Caller verifies the child tab separately.
            }

            // For same-page navigation or in-page state changes
            try {
              dispatchPointerMouseSequence(target);
              await sleep(200);
              if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                return "changed";
              }
            } catch { }

            try {
              target.click();
              await sleep(250);
              if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                return "changed";
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
                  return "changed";
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
                  return "changed";
                }
              } catch { }

              try {
                topEl.click();
                await sleep(250);
                if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                  return "changed";
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
                (((sectionIds || []).includes("dailyset") || (sectionIds || []).includes("ext-restored-dailyset")) && /rewards\.bing\.com\/dashboard/i.test(location.href)) ||
                ((sectionIds || []).includes("moreactivities") && /rewards\.bing\.com\/earn/i.test(location.href));
              if (usePageFallback) {
                cardsList.push(...collectPageRewardFallbackCards());
              }
            }
            card = cardsList.find((a) => {
              const candKey = buildCardKey(a);
              const candHref = a.getAttribute("href") || a.querySelector("a[href]")?.getAttribute("href") || "";
              const fullText = typeof window.normalizeRewardText === "function"
                ? window.normalizeRewardText(a.innerText || a.textContent || "")
                : (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
              const fullTextKey = typeof window.buildRewardCardKey === "function"
                ? window.buildRewardCardKey({ href: candHref, text: fullText })
                : `${candHref || "btn"}|${fullText.toLowerCase()}`;
              const targetHrefPart = keyToClick.split("|")[0];
              return (
                candKey === keyToClick ||
                fullTextKey === keyToClick ||
                (candHref && targetHrefPart && candHref === targetHrefPart && candHref !== "#" && candHref !== "/earn")
              );
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
          let domChanged = false;
          for (const target of targets) {
            const activationResult = await tryActivateTarget(card, target);
            if (activationResult) {
              success = true;
              domChanged = activationResult === "changed";
              break;
            }
          }

          console.log("[Rewards-Debug] clickRewardCard: Final click outcome: success=" + success + ", targets=" + targets.length);

          const finalHref = card.href || card.getAttribute("href") || card.querySelector("a[href]")?.getAttribute("href") || "";
          return { clicked: success, attempted: targets.length > 0, domChanged, href: finalHref };
        },
      });

    return getFirstScriptResult(scriptResults, {
      clicked: false,
      attempted: false,
      domChanged: false,
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
            await sleep(2000);

            let clicks = 0;
            let lastClickedText = "";
            let sameClickCount = 0;
            let lastCandidateSnapshot = [];
            let emptyCandidateRounds = 0;

            const clickedElements = new Set();
            for (let attempt = 0; attempt < 12; attempt++) {
              if (clicks >= 8) break;
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
                emptyCandidateRounds++;
                if (emptyCandidateRounds >= 3) {
                  break;
                }
                await sleep(1200);
                continue;
              }
              emptyCandidateRounds = 0;

              // Prefer unclicked candidates to make steady progress through quiz questions
              const unclicked = candidates.filter((c) => !clickedElements.has(c.el));
              let target = unclicked.length > 0 ? unclicked[0] : candidates[0];
              clickedElements.add(target.el);

              lastClickedText = target.text;
              clickElement(target.el);
              clicks++;
              await sleep(1500);
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
    const startedAt = Date.now();
    const deadlineAt = startedAt + REWARD_URL_TIMEOUT_MS;
    const timedOut = () => Date.now() >= deadlineAt;
    const remainingMs = () => Math.max(0, deadlineAt - Date.now());
    const sleepWithinDeadline = async (waitMs) => {
      const boundedWaitMs = Math.min(Math.max(0, waitMs), remainingMs());
      if (boundedWaitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, boundedWaitMs));
      }
      return !timedOut();
    };
    const awaitWithinDeadline = async (promise, fallbackValue) => {
      const timeoutMs = remainingMs();
      if (timeoutMs <= 0) return fallbackValue;
      let timeoutId;
      try {
        return await Promise.race([
          promise,
          new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve(fallbackValue), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
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

    let clickCount = 0;
    let scanCount = 0;
    let hydrationRetryCount = 0;
    let consecutiveHydrationRetries = 0;
    let lastHydrationStatus = "partial";
    let lastScanSummary = null;

    const makeIncompleteOutcome = (reason) => ({
      status: "incomplete",
      reason,
      elapsedMs: Date.now() - startedAt,
      remainingMs: remainingMs(),
      clickCount,
      scanCount,
      hydrationRetryCount,
      hydrationStatus: lastHydrationStatus,
      scan: lastScanSummary,
    });

    async function processEdgeFlyoutDailySet() {
      await appendDebugLog("info", "rewards", "Starting Edge flyout Daily Set fallback", { url });
      let dailySetData = await fetchAndRestoreDailySet(null, { forceFresh: true });
      if (!dailySetData || !Array.isArray(dailySetData.cards) || dailySetData.cards.length === 0) {
        console.warn("[Rewards] Edge flyout Daily Set has no cards");
        await appendDebugLog("warn", "rewards", "Edge flyout Daily Set has no cards");
        return makeIncompleteOutcome("no_flyout_cards");
      }

      const incompleteCards = dailySetData.cards.filter((c) => !c.complete);
      console.log(`[Rewards] Edge flyout Daily Set: ${dailySetData.cards.length} cards, ${incompleteCards.length} incomplete`);
      await appendDebugLog("info", "rewards", "Edge flyout Daily Set status", {
        totalCards: dailySetData.cards.length,
        incompleteCards: incompleteCards.length,
        streakDays: dailySetData.streakDays,
      });

      if (incompleteCards.length === 0) {
        return {
          status: "completed",
          reason: "all_cards_completed",
          elapsedMs: Date.now() - startedAt,
          remainingMs: remainingMs(),
          clickCount: 0,
          scanCount: 1,
          hydrationRetryCount: 0,
          hydrationStatus: "hydrated",
        };
      }

      for (const card of incompleteCards) {
        if (timedOut()) break;
        let targetUrl = card.destinationUrl;
        if (!targetUrl) continue;
        if (targetUrl.startsWith("/")) {
          targetUrl = "https://www.bing.com" + targetUrl;
        }

        console.log(`[Rewards] Edge opening daily card: ${card.title || card.name} -> ${targetUrl}`);
        await appendDebugLog("info", "rewards", "Opening Edge daily card", {
          title: card.title || card.name,
          targetUrl,
          offerId: card.offerId,
        });

        let childTab = null;
        try {
          await enableRewardMobileEmulation();
          childTab = await chrome.tabs.create({
            url: targetUrl,
            active: true,
            windowId,
          });
          await waitForTabComplete(
            childTab.id,
            Math.max(1000, Math.min(TAB_LOAD_TIMEOUT_MS, remainingMs())),
          );
          await sleepWithinDeadline(2000);

          const reportPayload = {
            activityType: card.activityType || "bingredirect",
            offerId: card.offerId || card.name || "",
            authKey: card.hash || "",
            userId: dailySetData.userId || "",
          };

          if (reportPayload.offerId && reportPayload.authKey) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: childTab.id },
                world: "MAIN",
                args: [REWARD_MOBILE_USER_AGENT, reportPayload],
                func: async (ua, payload) => {
                  try {
                    Object.defineProperty(navigator, "userAgent", { get: () => ua, configurable: true });
                    if (navigator.userAgentData) {
                      Object.defineProperty(navigator.userAgentData, "mobile", { get: () => true, configurable: true });
                      Object.defineProperty(navigator.userAgentData, "platform", { get: () => "Android", configurable: true });
                    }
                  } catch {}

                  if (payload && payload.offerId && payload.authKey) {
                    try {
                      await fetch("https://www.bing.com/msrewards/api/v1/reportactivity", {
                        method: "POST",
                        headers: { "Content-Type": "text/plain;charset=UTF-8" },
                        credentials: "include",
                        body: JSON.stringify({
                          ActivityType: payload.activityType || "bingredirect",
                          ActivitySubType: "",
                          OfferId: payload.offerId,
                          Channel: "BingFlyout",
                          PartnerId: "BingRewards",
                          UserId: payload.userId || "",
                          AuthKey: payload.authKey,
                          ActivityCount: 1,
                        }),
                      });
                    } catch {}
                  }
                },
              });
            } catch (scriptErr) {
              console.warn("[Rewards] Edge card script error:", scriptErr);
            }
          }

          const quizResult = await awaitWithinDeadline(
            handleRewardChildTab(childTab.id),
            { handled: false, completed: false, reason: "deadline" },
          );
          if (quizResult?.handled) {
            await appendDebugLog("info", "rewards", "Handled Edge daily card quiz", {
              title: card.title,
              completed: quizResult.completed,
              clicks: quizResult.clicks,
            });
            await sleepWithinDeadline(2000);
          } else if (!timedOut()) {
            await awaitWithinDeadline(humanScrollOnTab(childTab.id), undefined);
            if (!timedOut()) {
              await waitForRewardSearchCredit(childTab.id, Math.min(8000, remainingMs()));
            }
          }

          clickCount++;
        } catch (err) {
          console.warn("[Rewards] Edge daily card processing error:", err);
        } finally {
          await disableRewardMobileEmulation();
          if (childTab?.id) {
            try {
              await chrome.tabs.remove(childTab.id);
            } catch {}
          }
        }

        await sleepWithinDeadline(2000);
      }

      try {
        dailySetData = await fetchAndRestoreDailySet(null, { forceFresh: true });
      } catch {}

      // Auto-perform Visual Search on Edge if pending or needs activation
      try {
        const flyoutRes = await fetch("https://www.bing.com/rewards/panelflyout", { credentials: "include" });
        if (flyoutRes.ok) {
          const flyoutHtml = await flyoutRes.text();
          const yourActivity = extractYourActivityFromFlyoutHtml(flyoutHtml);
          const vs = yourActivity?.activities?.find((a) => a.id === "visualsearch");
          if (vs && !vs.completed) {
            await appendDebugLog("info", "rewards", "Auto-executing Visual Search on Edge", { isEnabled: vs.isEnabled });
            await performVisualSearch(windowId);
          }
        }
      } catch (vsErr) {
        console.warn("[Rewards] Visual Search execution error:", vsErr);
      }

      const remainingIncomplete = dailySetData?.cards?.filter((c) => !c.complete)?.length ?? 0;
      const isCompleted = remainingIncomplete === 0;

      return {
        status: isCompleted ? "completed" : "incomplete",
        reason: isCompleted ? "edge_flyout_daily_set_completed" : "cards_still_pending",
        clickCount,
        scanCount: 1,
        elapsedMs: Date.now() - startedAt,
        remainingMs: remainingMs(),
        hydrationRetryCount: 0,
        hydrationStatus: "hydrated",
      };
    }

    try {
      await ensureTabLoaded(tab.id, url);
      await ensureTabFocused(tab.id);
      await new Promise((r) => setTimeout(r, /rewards\.bing\.com\/dashboard/i.test(url) ? 8000 : 2000));

      // Validate tab is on rewards page before injection
      const currentTab = await chrome.tabs.get(tab.id);
      if (!isRewardsPageUrl(currentTab.url || currentTab.pendingUrl)) {
        const message = "Rewards tab redirected to non-rewards URL; rewards automation skipped";
        console.warn(`[Rewards] ${message} (${currentTab.url})`);
        await appendDebugLog("warn", "rewards", message, {
          url,
          actualUrl: currentTab.url,
          reason: "unexpected_redirect",
        });
        return makeIncompleteOutcome("unexpected_redirect");
      }

      // Inject helper functions into the page MAIN world so injected scripts can use them
      try {
        await injectDomHelpers(tab.id);
      } catch (e) {
        const isBlocked = isProtectedPageScriptError(e) || e?.code === "PAGE_SCRIPTING_BLOCKED";
        const notScriptable = e?.code === "REWARDS_TAB_NOT_SCRIPTABLE";
        if (!isBlocked && !notScriptable) throw e;
        const reason = isBlocked ? "page_scripting_blocked" : "unexpected_redirect";
        const message = isBlocked
          ? "Browser protects this page from extension scripting; rewards automation skipped"
          : `Rewards tab is not scriptable; rewards automation skipped (${e?.message || e})`;
        console.warn(`[Rewards] ${message} (${url})`);
        await appendDebugLog("warn", "rewards", message, {
          url,
          browser: getBrowserName(),
          reason,
        });

        if (isBlocked && /rewards\.bing\.com\/dashboard/i.test(url)) {
          console.log("[Rewards] Edge blocked dashboard scripting. Processing Daily Set via Edge flyout fallback...");
          return await processEdgeFlyoutDailySet();
        }

        return makeIncompleteOutcome(reason);
      }

      if (/rewards\.bing\.com\/(?:dashboard|earn)/i.test(url)) {
        await appendDebugLog("info", "rewards", "Scanning for ready-to-claim card", { url });
        const claimResult = await claimReadyPoints(tab.id);
        if (claimResult.clicked) {
          console.log(
            `[Rewards] Claimed ${claimResult.claimedPoints} ready point(s) from ${url}`,
          );
          await appendDebugLog("success", "rewards", `Claimed ${claimResult.claimedPoints} ready point(s)`, {
            url,
            points: claimResult.claimedPoints,
          });
          await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));
          await chrome.tabs.reload(tab.id);
          await ensureTabLoaded(tab.id, url);
          await chrome.tabs.update(tab.id, { active: true });
          await ensureTabFocused(tab.id);

          const currentTabAfterReload = await chrome.tabs.get(tab.id);
          console.log("[Rewards] After reload:", currentTabAfterReload.url);
          if (!isRewardsPageUrl(currentTabAfterReload.url || currentTabAfterReload.pendingUrl)) {
            console.warn(
              "[Rewards] Skip injection because page redirected:",
              currentTabAfterReload.url
            );
            return makeIncompleteOutcome("unexpected_redirect");
          }

          await injectDomHelpers(tab.id); // Re-inject after reload
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          console.log(
            `[Rewards] No ready points claimed (${claimResult.reason || "not_available"})`,
          );
          const message =
            claimResult.reason === "not_ready"
              ? "No ready-to-claim card found"
              : `Ready-to-claim card not claimed (${claimResult.reason || "not_available"})`;
          await appendDebugLog("info", "rewards", message, {
            url,
            reason: claimResult.reason || "not_available",
          });
        }
      }

      if (/rewards\.bing\.com\/earn/i.test(url)) {
        const attemptedQuestKeys = new Set();
        const maxQuestCards = 3;

        for (let i = 0; i < maxQuestCards; i++) {
          if (timedOut() || remainingMs() < MIN_QUEST_REMAINING_BUDGET_MS) {
            console.warn("[Rewards] Low budget reached while processing quest cards for " + url);
            await appendDebugLog("warn", "rewards", "Budget low, finishing quest cards early to reserve time for main cards", { url, remainingMs: remainingMs() });
            break;
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

          await enableRewardMobileEmulation();
          const attemptedActivityKeys = new Set();
          const maxQuestActivities = 8;

          for (let j = 0; j < maxQuestActivities; j++) {
            if (timedOut() || remainingMs() < MIN_QUEST_REMAINING_BUDGET_MS) {
              console.warn("[Rewards] Low budget reached while processing quest activities for " + url);
              await appendDebugLog("warn", "rewards", "Budget low, finishing quest activities early", { url, remainingMs: remainingMs() });
              break;
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
            if (newTabIds.length === 0 && (wasClicked || targetHref || nextActivity.href)) {
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
                try {
                  await chrome.scripting.executeScript({
                    target: { tabId: childTabId },
                    world: "MAIN",
                    args: [REWARD_MOBILE_USER_AGENT],
                    func: (ua) => {
                      try {
                        Object.defineProperty(navigator, "userAgent", { get: () => ua, configurable: true });
                        if (navigator.userAgentData) {
                          Object.defineProperty(navigator.userAgentData, "mobile", { get: () => true, configurable: true });
                          Object.defineProperty(navigator.userAgentData, "platform", { get: () => "Android", configurable: true });
                        }
                      } catch {}
                    },
                  });
                } catch {}
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

          const currentTabAfterQuest = await chrome.tabs.get(tab.id);
          console.log("[Rewards] After quest navigation:", currentTabAfterQuest.url);
          if (!isRewardsPageUrl(currentTabAfterQuest.url || currentTabAfterQuest.pendingUrl)) {
            console.warn(
              "[Rewards] Skip injection because page redirected:",
              currentTabAfterQuest.url
            );
            return makeIncompleteOutcome("unexpected_redirect");
          }

          await injectDomHelpers(tab.id); // Re-inject after navigation
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // Determine which sections to click based on the current URL.
      // Do NOT include "global" — it scans the entire document and picks up
      // unrelated links (redeem, shop, etc.) that aren't reward cards.
      let targetSectionIds = rewardSectionIds;
      if (/rewards\.bing\.com\/earn/i.test(url)) {
        targetSectionIds = ["moreactivities", "exploreonbing"];
      } else if (/rewards\.bing\.com\/dashboard/i.test(url)) {
        targetSectionIds = ["dailyset", "ext-restored-dailyset", "moreactivities", "offers"];
        try {
          const hasDailySetCards = await executeRewardsScript(tab.id, {
            func: () => Boolean((document.getElementById("dailyset") || document.getElementById("ext-restored-dailyset"))?.querySelector("a[href]")),
          });
          if (!hasDailySetCards) {
            console.log("[Rewards] Missing daily set on dashboard, fetching from panelflyout fallback...");
            await fetchAndRestoreDailySet(tab.id);
          }
        } catch (dsErr) {
          console.warn("[Rewards] Daily set check/restore error:", dsErr);
        }
      }

      // Re-scan after every click. Hydration retries are independent from the
      // card click limit so section chrome can never consume a card attempt.
      const cardAttemptCounts = new Map();
      const maxRewardCardClicks = 8;
      const maxAttemptsPerCard = 2;
      let pendingVerification = null;
      let currentDocumentHydrated = false;

      const getCardAttemptKey = (card) => card.href || card.key;
      const isRelevantScanSection = (section) =>
        targetSectionIds.includes(section.sectionId) ||
        (section.sectionId === "earn_fallback" && targetSectionIds.includes("moreactivities")) ||
        (section.sectionId === "dashboard_fallback" && (targetSectionIds.includes("dailyset") || targetSectionIds.includes("ext-restored-dailyset")));
      const summarizeScanSections = (sections) => {
        const relevantSections = sections.filter(isRelevantScanSection);
        return {
          anchorCount: relevantSections.reduce(
            (sum, section) => sum + Number(section.directRoundedAnchors || 0),
            0,
          ),
          completedCount: relevantSections.reduce(
            (sum, section) => sum + Number(section.completed || 0),
            0,
          ),
          acceptedCount: relevantSections.reduce(
            (sum, section) => sum + Number(section.accepted || 0),
            0,
          ),
          sectionChromeCount: relevantSections.reduce(
            (sum, section) => sum + Number(section.sectionChrome || 0),
            0,
          ),
          cardShellCount: relevantSections.reduce(
            (sum, section) => sum + Number(section.cardShells || 0),
            0,
          ),
          hydratedSectionCount: relevantSections.filter(
            (section) => section.hydrated === true,
          ).length,
          sectionIds: relevantSections.map((section) => section.sectionId),
        };
      };

      while (true) {
        if (timedOut()) {
          const reason = ["partial", "header_only", "hydrating"].includes(lastHydrationStatus)
            ? "hydration_timeout"
            : "cards_still_pending";
          return makeIncompleteOutcome(reason);
        }

        scanCount++;
        const domWaitMs = Math.min(20000, remainingMs());
        if (domWaitMs < 1000) return makeIncompleteOutcome("hydration_timeout");
        const domReadyResult = await waitForRewardsDomReady(
          tab.id,
          targetSectionIds,
          domWaitMs,
          currentDocumentHydrated,
        );
        if (timedOut()) return makeIncompleteOutcome("hydration_timeout");

        if (scanCount === 1 && /rewards\.bing\.com\/(?:dashboard|earn)/i.test(url)) {
          try {
            const initialClaim = await claimReadyPoints(tab.id);
            if (initialClaim.clicked) {
              await appendDebugLog("success", "rewards", `Claimed ${initialClaim.claimedPoints} ready point(s) after hydration`, { url });
              await sleepWithinDeadline(1500);
            }
          } catch (e) {
            console.warn("[Rewards] initial claimReadyPoints failed:", e);
          }
        }

        const initialStableEmptySince = Number.isFinite(domReadyResult?.stableEmptySince)
          ? domReadyResult.stableEmptySince
          : null;
        if (remainingMs() < 1000) return makeIncompleteOutcome("hydration_timeout");
        const rewardCardsResult = await getRewardCards(
          tab.id,
          targetSectionIds,
          initialStableEmptySince,
          Math.min(5000, remainingMs()),
          currentDocumentHydrated,
        );
        const rewardCards = Array.isArray(rewardCardsResult?.cards)
          ? rewardCardsResult.cards
          : [];
        const scanSections = Array.isArray(rewardCardsResult?.sections)
          ? rewardCardsResult.sections
          : [];
        lastHydrationStatus = rewardCardsResult?.hydrationStatus || "partial";
        lastScanSummary = summarizeScanSections(scanSections);
        if (rewardCards.length > 0 || rewardCardsResult?.hydrated === true) {
          currentDocumentHydrated = true;
        }
        if (rewardCards.length > 0) {
          consecutiveHydrationRetries = 0;
        }

        await appendDebugLog("info", "rewards", `Found ${rewardCards.length} reward card(s) to click`, {
          url,
          cards: rewardCards.map((card) => card.key.substring(0, 60)).join(" | "),
          scan: scanCount,
          hydrationStatus: lastHydrationStatus,
          elapsedMs: Date.now() - startedAt,
          remainingMs: remainingMs(),
          ...lastScanSummary,
        });

        const scanCanVerifyCards =
          lastHydrationStatus === "ready_cards" ||
          lastHydrationStatus === "stable_empty";
        if (pendingVerification && scanCanVerifyCards) {
          const cardStillPending = rewardCards.some((candidate) =>
            getCardAttemptKey(candidate) === pendingVerification.attemptKey
          );
          await appendDebugLog(
            cardStillPending ? "warn" : "success",
            "rewards",
            cardStillPending
              ? "Reward card remains pending after click"
              : "Reward card completed or disappeared after click",
            {
              url,
              key: pendingVerification.key.substring(0, 100),
              href: pendingVerification.href.substring(0, 100),
              attempt: pendingVerification.attempt,
              evidence: pendingVerification.evidence,
              scan: scanCount,
              completedCount: lastScanSummary.completedCount,
            },
          );
          if (!cardStillPending) pendingVerification = null;
        }

        if (lastHydrationStatus === "stable_empty") {
          if (/rewards\.bing\.com\/(?:dashboard|earn)/i.test(url)) {
            try {
              const claimRes = await claimReadyPoints(tab.id);
              if (claimRes.clicked) {
                await appendDebugLog("success", "rewards", `Claimed ${claimRes.claimedPoints} ready point(s) on stable empty`, { url });
                await sleepWithinDeadline(1500);
              }
            } catch (e) {
              console.warn("[Rewards] claimReadyPoints on stable empty failed:", e);
            }
          }
          return {
            status: "completed",
            reason: "stable_empty",
            elapsedMs: Date.now() - startedAt,
            clickCount,
            scanCount,
            hydrationRetryCount,
            hydrationStatus: lastHydrationStatus,
            scan: lastScanSummary,
          };
        }

        if (rewardCards.length === 0) {
          const allRelevantHydrated =
            scanSections.length > 0 &&
            scanSections
              .filter(isRelevantScanSection)
              .every((s) => !s.exists || s.hydrated === true || (s.directRoundedAnchors === 0 && s.completed === 0 && s.accepted === 0));
          if (
            lastScanSummary &&
            allRelevantHydrated &&
            lastHydrationStatus !== "partial" &&
            lastHydrationStatus !== "header_only" &&
            lastScanSummary.hydratedSectionCount > 0 &&
            lastScanSummary.completedCount > 0 &&
            lastScanSummary.acceptedCount === 0
          ) {
            if (/rewards\.bing\.com\/(?:dashboard|earn)/i.test(url)) {
              try {
                const claimRes = await claimReadyPoints(tab.id);
                if (claimRes.clicked) {
                  await appendDebugLog("success", "rewards", `Claimed ${claimRes.claimedPoints} ready point(s) on all cards completed`, { url });
                  await sleepWithinDeadline(1500);
                }
              } catch (e) {
                console.warn("[Rewards] claimReadyPoints on all cards completed failed:", e);
              }
            }
            return {
              status: "completed",
              reason: "stable_empty",
              elapsedMs: Date.now() - startedAt,
              clickCount,
              scanCount,
              hydrationRetryCount,
              hydrationStatus: "stable_empty",
              scan: lastScanSummary,
            };
          }

          hydrationRetryCount++;
          consecutiveHydrationRetries++;
          const retryDelayMs = getRewardHydrationRetryDelay(consecutiveHydrationRetries);
          await appendDebugLog("warn", "rewards", "Reward section hydration recovery", {
            url,
            hydrationStatus: lastHydrationStatus,
            retryCount: hydrationRetryCount,
            consecutiveRetry: consecutiveHydrationRetries,
            retryDelayMs,
            scan: scanCount,
            elapsedMs: Date.now() - startedAt,
            remainingMs: remainingMs(),
            anchorCount: lastScanSummary.anchorCount,
            completedCount: lastScanSummary.completedCount,
            acceptedCount: lastScanSummary.acceptedCount,
            sectionChromeCount: lastScanSummary.sectionChromeCount,
            cardShellCount: lastScanSummary.cardShellCount,
            sectionIds: lastScanSummary.sectionIds,
          });

          if (consecutiveHydrationRetries > 3 || !(await sleepWithinDeadline(retryDelayMs))) {
            return makeIncompleteOutcome("hydration_timeout");
          }

          try {
            currentDocumentHydrated = false;
            await chrome.tabs.reload(tab.id);
            await ensureTabLoaded(tab.id, url, {
              attempts: 1,
              timeoutMs: Math.max(1000, Math.min(TAB_LOAD_TIMEOUT_MS, remainingMs())),
            });
            await ensureTabFocused(tab.id);

            const currentTabAfterHydration = await chrome.tabs.get(tab.id);
            console.log("[Rewards] After hydration reload:", currentTabAfterHydration.url);
            if (!isRewardsPageUrl(currentTabAfterHydration.url || currentTabAfterHydration.pendingUrl)) {
              console.warn(
                "[Rewards] Skip injection because page redirected:",
                currentTabAfterHydration.url
              );
              return makeIncompleteOutcome("unexpected_redirect");
            }

            await injectDomHelpers(tab.id);
          } catch (e) {
            await appendDebugLog("warn", "rewards", "Reward hydration reload failed", {
              url,
              retryCount: hydrationRetryCount,
              elapsedMs: Date.now() - startedAt,
              remainingMs: remainingMs(),
              error: String(e?.message || e),
            });
            if (timedOut()) return makeIncompleteOutcome("hydration_timeout");
          }
          continue;
        }

        consecutiveHydrationRetries = 0;
        if (clickCount >= maxRewardCardClicks) {
          return makeIncompleteOutcome("cards_still_pending");
        }

        let card = rewardCards.find(
          (candidate) => !cardAttemptCounts.has(getCardAttemptKey(candidate)),
        );
        if (!card) {
          card = rewardCards.find(
            (candidate) =>
              (cardAttemptCounts.get(getCardAttemptKey(candidate)) || 0) < maxAttemptsPerCard,
          );
        }
        if (!card) return makeIncompleteOutcome("cards_still_pending");

        const attemptKey = getCardAttemptKey(card);
        const cardAttempt = (cardAttemptCounts.get(attemptKey) || 0) + 1;
        cardAttemptCounts.set(attemptKey, cardAttempt);
        clickCount++;
        console.log(`[Rewards] Clicking reward card ${clickCount}: ${card.href || card.key}`);
        await appendDebugLog("info", "rewards", `Clicking card ${clickCount}`, {
          href: card.href.substring(0, 80),
          key: card.key.substring(0, 100),
          pendingCards: rewardCards.length,
          attempt: cardAttempt,
          scan: scanCount,
          elapsedMs: Date.now() - startedAt,
          remainingMs: remainingMs(),
        });

        const childBaselineIds = await getCurrentTabIdSet();
        const isRestoredDailySet = Boolean(
          card.isRestored ||
          (card.key && /Global_DailySet|ext-restored/i.test(card.key)) ||
          targetSectionIds.includes("ext-restored-dailyset")
        );

        if (isRestoredDailySet) {
          await enableRewardMobileEmulation();
        }

        let structuredClickResult;
        let wasClicked = false;
        let clickAttempted = false;
        let domChanged = false;
        let resultHref = "";
        let manualFallbackAttempted = false;
        let usedManualFallback = false;
        const newTabIds = [];

        try {
          const clickResult = await clickRewardCard(tab.id, card.key, targetSectionIds);
          structuredClickResult = clickResult && typeof clickResult === "object"
            ? clickResult
            : { clicked: !!clickResult, attempted: !!clickResult, domChanged: false, href: "" };
          wasClicked = structuredClickResult.clicked === true;
          clickAttempted = structuredClickResult.attempted === true;
          domChanged = structuredClickResult.domChanged === true;
          resultHref = structuredClickResult.href || "";

          await sleepWithinDeadline(REWARDS_SETTLE_MS);

          // Collect only child tabs spawned by this card click.
          const collectedIds = await collectNewChildTabIds(
            childBaselineIds,
            `reward card ${clickCount}`,
          );
          newTabIds.push(...collectedIds);

          if (
            !timedOut() &&
            newTabIds.length === 0 &&
            !domChanged &&
            (card.href || resultHref)
          ) {
            let fullHref = resultHref || card.href;
            if (fullHref.startsWith("/")) {
              fullHref = "https://rewards.bing.com" + fullHref;
            }
            if (fullHref.startsWith("http")) {
              manualFallbackAttempted = true;
              await appendDebugLog("warn", "rewards", "Reward card did not open a child tab, falling back to manual open", {
                url: fullHref,
                clicked: wasClicked,
                domChanged,
              });
              console.log("[Rewards] Reward card did not open a child tab, falling back to manual open: " + fullHref);
              try {
                const fallbackTab = await chrome.tabs.create({
                  url: fullHref,
                  active: true,
                  windowId,
                  openerTabId: tab.id,
                });
                await trackFallbackChildTab(fallbackTab, newTabIds);
                usedManualFallback = true;
                await waitForTabComplete(
                  fallbackTab.id,
                  Math.max(1000, Math.min(TAB_LOAD_TIMEOUT_MS, remainingMs())),
                );
              } catch (e) {
                console.warn("[Rewards] Fallback tab creation failed:", e);
              }
            }
          }

          // Scroll like a human on each child tab so Bing registers the visit.
          for (const childTabId of newTabIds) {
            if (timedOut()) break;
            try {
              await chrome.tabs.update(childTabId, { active: true });
              await waitForTabComplete(
                childTabId,
                Math.max(1000, Math.min(TAB_LOAD_TIMEOUT_MS, remainingMs())),
              );

              if (isRestoredDailySet) {
                try {
                  const cached = await chrome.storage.local.get(["cachedDailySetData"]);
                  const matching = cached?.cachedDailySetData?.cards?.find((c) =>
                    (card.offerId && c.offerId === card.offerId) ||
                    (card.key && c.name && card.key.includes(c.name)) ||
                    (card.href && c.destinationUrl && (card.href.includes(c.name) || c.destinationUrl.includes(card.href)))
                  );
                  const reportPayload = {
                    activityType: card.activityType || matching?.activityType || "bingredirect",
                    offerId: card.offerId || matching?.offerId || matching?.name || "",
                    authKey: card.authKey || matching?.hash || "",
                    userId: card.userId || cached?.cachedDailySetData?.userId || "",
                  };

                  await chrome.scripting.executeScript({
                    target: { tabId: childTabId },
                    world: "MAIN",
                    args: [REWARD_MOBILE_USER_AGENT, reportPayload],
                    func: async (ua, payload) => {
                      try {
                        Object.defineProperty(navigator, "userAgent", { get: () => ua, configurable: true });
                        if (navigator.userAgentData) {
                          Object.defineProperty(navigator.userAgentData, "mobile", { get: () => true, configurable: true });
                          Object.defineProperty(navigator.userAgentData, "platform", { get: () => "Android", configurable: true });
                        }
                      } catch {}

                      if (payload && payload.offerId && payload.authKey) {
                        try {
                          await fetch("https://www.bing.com/msrewards/api/v1/reportactivity", {
                            method: "POST",
                            headers: { "Content-Type": "text/plain;charset=UTF-8" },
                            credentials: "include",
                            body: JSON.stringify({
                              ActivityType: payload.activityType || "bingredirect",
                              ActivitySubType: "",
                              OfferId: payload.offerId,
                              Channel: "BingFlyout",
                              PartnerId: "BingRewards",
                              UserId: payload.userId || "",
                              AuthKey: payload.authKey,
                              ActivityCount: 1,
                            }),
                          });
                        } catch {}
                      }
                    },
                  });
                } catch {}
              }

              const quizResult = await awaitWithinDeadline(
                handleRewardChildTab(childTabId),
                { handled: false, completed: false, reason: "deadline" },
              );
              if (quizResult?.handled) {
                await appendDebugLog("info", "rewards", "Handled reward quiz child tab", {
                  completed: quizResult.completed,
                  clicks: quizResult.clicks,
                  reason: quizResult.reason,
                  diagnostics: quizResult.diagnostics,
                });
                await sleepWithinDeadline(2000);
              } else if (!timedOut()) {
                await awaitWithinDeadline(humanScrollOnTab(childTabId), undefined);
                if (!timedOut()) {
                  await waitForRewardSearchCredit(childTabId, Math.min(8000, remainingMs()));
                }
              }
            } catch { }
          }
        } finally {
          if (isRestoredDailySet) {
            await disableRewardMobileEmulation();
          }
        }

        const cardCleanupResult = newTabIds.length
          ? await closeExistingTabs(newTabIds, `child tab(s) from card ${clickCount}`)
          : { requestedIds: [], closedIds: [], missingIds: [], failedIds: [] };
        markChildTabsProcessed([
          ...cardCleanupResult.closedIds,
          ...cardCleanupResult.missingIds,
        ]);

        const effectiveHref = resultHref || card.href;

        // Optimistically mark restored card completed in DOM if tab was processed
        if (newTabIds.length > 0 || domChanged || wasClicked) {
          try {
            await executeRewardsScript(tab.id, {
              args: [card.key || effectiveHref || ""],
              func: (key) => {
                if (typeof window.markRestoredCardCompleted === "function") {
                  window.markRestoredCardCompleted(key);
                }
              },
            });
          } catch { }
        }

        // Revalidate server state if restored daily set was processed
        if (isRestoredDailySet && (newTabIds.length > 0 || domChanged || wasClicked)) {
          try {
            await fetchAndRestoreDailySet(tab.id, { forceFresh: true });
          } catch {}
        }

        const noEffect = !effectiveHref && newTabIds.length === 0 && !domChanged;
        const evidence = {
          childTab: newTabIds.length > 0,
          domChanged,
          manualFallback: usedManualFallback,
          noEffect,
        };
        if (noEffect) {
          await appendDebugLog("warn", "rewards", "Reward card click had no effect", {
            url,
            key: card.key.substring(0, 100),
            attempt: cardAttempt,
            result: "no_effect",
            clicked: wasClicked,
            attempted: clickAttempted,
            href: "",
            childTabs: 0,
          });
        }

        pendingVerification = {
          attemptKey,
          key: card.key,
          href: effectiveHref,
          attempt: cardAttempt,
          evidence,
        };
        console.log(`[Rewards] Card ${clickCount} done (clicked=${wasClicked}, childTabs=${newTabIds.length})`);
        await appendDebugLog("info", "rewards", `Card ${clickCount} done`, {
          href: card.href.substring(0, 80),
          clicked: wasClicked,
          attempted: clickAttempted,
          domChanged,
          noEffect,
          manualFallbackAttempted,
          manualFallback: usedManualFallback,
          childTabs: newTabIds.length,
          childTabIds: newTabIds,
          closedChildTabIds: cardCleanupResult.closedIds,
          missingChildTabIds: cardCleanupResult.missingIds,
          failedChildTabIds: cardCleanupResult.failedIds,
          verification: "pending_rescan",
        });

        if (timedOut()) return makeIncompleteOutcome("cards_still_pending");

        // Preserve the hydrated parent DOM unless the card navigated the parent.
        let parentStillOnRewardsPage = false;
        try {
          const parentTab = await chrome.tabs.get(tab.id);
          parentStillOnRewardsPage = isRewardsPageUrl(parentTab.url || parentTab.pendingUrl);
        } catch { }
        if (!parentStillOnRewardsPage) {
          currentDocumentHydrated = false;
          await chrome.tabs.update(tab.id, { url, active: true });
          await ensureTabLoaded(tab.id, url, {
            attempts: 1,
            timeoutMs: Math.max(1000, Math.min(TAB_LOAD_TIMEOUT_MS, remainingMs())),
          });
        } else {
          await chrome.tabs.update(tab.id, { active: true });
        }
        await ensureTabFocused(tab.id);

        const currentTabAfterLoop = await chrome.tabs.get(tab.id);
        if (!isRewardsPageUrl(currentTabAfterLoop.url || currentTabAfterLoop.pendingUrl)) {
          console.warn(
            "[Rewards] Skip injection because page redirected:",
            currentTabAfterLoop.url
          );
          return makeIncompleteOutcome("unexpected_redirect");
        }

        if (/rewards\.bing\.com\/dashboard/i.test(url)) {
          try {
            await fetchAndRestoreDailySet(tab.id, { forceFresh: true });
          } catch {}
        }
        await injectDomHelpers(tab.id);
        await sleepWithinDeadline(1500);
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
        const needsPolling = spawnedTabIds.size > 0 || clickCount > 0;
        if (needsPolling) {
          await closeChildTabs(tab.id, 4, 1200, windowId);
        } else {
          await closeChildTabs(tab.id, 1, 0, windowId);
        }
        if (/rewards\.bing\.com\/(?:dashboard|earn)/i.test(url)) {
          try {
            const claimRes = await claimReadyPoints(tab.id);
            if (claimRes.clicked) {
              await appendDebugLog("success", "rewards", `Claimed ${claimRes.claimedPoints} ready point(s) before closing tab`, { url });
              await sleepWithinDeadline(1500);
            }
          } catch {}
        }
        if (/rewards\.bing\.com\/dashboard/i.test(url)) {
          try {
            await fetchAndRestoreDailySet(tab.id, { forceFresh: true });
          } catch {}
        }
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

  const rewardOutcomes = [];
  for (const url of rewardUrls) {
    try {
      const outcome = await processRewardUrl(url);
      rewardOutcomes.push({ url, ...outcome });
      const rewardLabel = /dashboard/i.test(url)
        ? "Dashboard"
        : /earn/i.test(url)
          ? "Earn"
          : "Reward URL";
      if (outcome?.status === "completed") {
        console.log(`[Rewards] ${rewardLabel} completed for ${url}`);
        await appendDebugLog("success", "rewards", `${rewardLabel} completed`, {
          url,
          ...outcome,
        });
      } else {
        const reason = outcome?.reason || "unknown";
        console.warn(`[Rewards] ${rewardLabel} incomplete: ${reason}`);
        await appendDebugLog("warn", "rewards", `${rewardLabel} incomplete: ${reason}`, {
          url,
          ...outcome,
        });
      }
    } catch (e) {
      const pageScriptingBlocked = isProtectedPageScriptError(e);
      const tabNotScriptable = e?.code === "REWARDS_TAB_NOT_SCRIPTABLE";
      console.warn(`[Rewards] Processing failed for ${url}:`, e);
      await appendDebugLog(
        pageScriptingBlocked || tabNotScriptable ? "warn" : "error",
        "rewards",
        pageScriptingBlocked
          ? "Reward URL skipped: page protected from extension scripting"
          : tabNotScriptable
            ? "Reward URL skipped: tab redirected to non-rewards URL"
            : "Reward URL failed",
        { url, browser: getBrowserName(), error: String(e) },
      );
      rewardOutcomes.push({
        url,
        status: "incomplete",
        reason: pageScriptingBlocked
          ? "page_scripting_blocked"
          : tabNotScriptable
            ? "unexpected_redirect"
            : "error",
        error: String(e?.message || e),
      });
    }
  }

  // Check and perform Visual Search if not yet completed for today
  try {
    const flyoutRes = await fetch("https://www.bing.com/rewards/panelflyout", { credentials: "include" });
    if (flyoutRes.ok) {
      const flyoutHtml = await flyoutRes.text();
      const yourActivity = extractYourActivityFromFlyoutHtml(flyoutHtml);
      const vs = yourActivity?.activities?.find((a) => a.id === "visualsearch");
      if (vs && !vs.completed) {
        await appendDebugLog("info", "rewards", "Auto-executing Visual Search after rewards run", { isEnabled: vs.isEnabled });
        await performVisualSearch();
      }
    }
  } catch (vsErr) {
    console.warn("[Rewards] Visual Search execution check error:", vsErr);
  }

  return rewardOutcomes;
}
globalThis.autoClickRewards = autoClickRewards;
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

async function performVisualSearch(targetWindowId) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await appendDebugLog("info", "rewards", "Starting Visual Search automation");
  let tab = null;
  try {
    const createProps = {
      url: "https://www.bing.com/?features=vsstreak,vstooltip&form=ML2XES",
      active: true,
    };
    if (targetWindowId) createProps.windowId = targetWindowId;
    tab = await chrome.tabs.create(createProps);
    if (!tab?.id) throw new Error("Failed to create visual search tab");

    await waitForTabComplete(tab.id, 15000);
    await sleep(2000);

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: async () => {
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
        const btn = document.querySelector("#sb_sbi");
        if (btn) btn.click();
        await delay(1200);

        const input = document.querySelector("#sb_fileinput");
        if (!input) return { ok: false, error: "file_input_missing" };

        const canvas = document.createElement("canvas");
        canvas.width = 100;
        canvas.height = 100;
        const ctx = canvas.getContext("2d");
        const hue = Math.floor(Math.random() * 360);
        ctx.fillStyle = `hsl(${hue}, 75%, 50%)`;
        ctx.fillRect(0, 0, 100, 100);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(25, 25, 50, 50);

        const dataUrl = canvas.toDataURL("image/png");
        const b64 = dataUrl.split(",")[1];
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);

        const file = new File([u8], "vs_query.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      },
    });

    const execRes = result?.[0]?.result;
    if (!execRes?.ok) {
      await appendDebugLog("warn", "rewards", "Visual search injection outcome", execRes);
    }

    // Wait for search navigation and reward registration
    await sleep(8000);
    await appendDebugLog("info", "rewards", "Visual search completed successfully");
    return { ok: true };
  } catch (err) {
    console.error("[Rewards] Visual Search error:", err);
    await appendDebugLog("error", "rewards", "Visual Search failed", { error: String(err) });
    return { ok: false, error: String(err) };
  } finally {
    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {}
    }
  }
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
    const firstRewardOutcomes = await autoClickRewards();
    await ensureInternetOrThrow("rewards_first_pass");
    const firstIncompleteRewards = firstRewardOutcomes.filter(
      (outcome) => outcome.status !== "completed",
    );
    await appendDebugLog(
      firstIncompleteRewards.length ? "warn" : "success",
      "rewards",
      firstIncompleteRewards.length
        ? "Rewards phase completed with incomplete URL(s)"
        : "Rewards phase completed",
      { outcomes: firstRewardOutcomes },
    );

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
    const firstPassAllBlocked =
      firstRewardOutcomes.length > 0 &&
      firstRewardOutcomes.every((outcome) => outcome.reason === "page_scripting_blocked");

    if (firstPassAllBlocked) {
      console.log("[Rewards] Skipping second rewards phase: page scripting blocked by browser policy on all rewards URLs");
      await appendDebugLog(
        "info",
        "rewards",
        "Skipping second rewards phase: page scripting blocked on all rewards URLs by browser policy",
      );
    } else {
      console.log("⚡ Running second pass for Bing Rewards auto click...");
      await appendDebugLog("info", "rewards", "Second Rewards phase started");
      try {
        await ensureInternetOrThrow("rewards_second_pass_before");
        const secondRewardOutcomes = await autoClickRewards();
        await ensureInternetOrThrow("rewards_second_pass_after");
        const secondIncompleteRewards = secondRewardOutcomes.filter(
          (outcome) => outcome.status !== "completed",
        );
        await appendDebugLog(
          secondIncompleteRewards.length ? "warn" : "success",
          "rewards",
          secondIncompleteRewards.length
            ? "Second Rewards phase completed with incomplete URL(s)"
            : "Second Rewards phase completed",
          { outcomes: secondRewardOutcomes },
        );
      } catch (e) {
        if (isInternetUnavailableError(e)) throw e;
        console.warn("[Rewards] Second pass failed:", e);
        await appendDebugLog("error", "rewards", "Second Rewards phase failed: " + e.message);
      }
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

  if (!cfg.enabled) {
    await chrome.alarms.clear(ALARM_NAME);
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

  const existingAlarm = await chrome.alarms.get(ALARM_NAME);
  const isAlreadyScheduled =
    existingAlarm &&
    Math.abs(existingAlarm.scheduledTime - next.getTime()) < 1000;

  if (isAlreadyScheduled && !clearDelayed) {
    const data = await chrome.storage.sync.get("nextRunAt");
    if (data.nextRunAt !== existingAlarm.scheduledTime) {
      await chrome.storage.sync.set({ nextRunAt: existingAlarm.scheduledTime });
    }
    await updateBadge();
    return;
  }

  await chrome.alarms.clear(ALARM_NAME);
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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = tab?.url || changeInfo?.url;
  if (!url) return;

  if (/rewards\.bing\.com\/dashboard/i.test(url)) {
    try {
      await fetchAndRestoreDailySet(tabId);
    } catch (err) {
      console.warn("[Rewards] tabs.onUpdated daily set restore error:", err);
    }
  }

  // Also support manual clicks by user on restored Daily Set search tabs
  if (changeInfo.status === "complete" && /bing\.com\/search\?/i.test(url) && /(?:Global_DailySet|REWARDSQUIZ_DailySet|sid:)/i.test(url)) {
    try {
      const cached = await chrome.storage.local.get(["cachedDailySetData"]);
      const dailySet = cached?.cachedDailySetData;
      if (dailySet && Array.isArray(dailySet.cards)) {
        const matchingCard = dailySet.cards.find((c) => {
          if (!c.hash) return false;
          if (c.name && url.includes(c.name)) return true;
          if (c.offerId && url.includes(c.offerId)) return true;
          if (c.destinationUrl) {
            try {
              const destU = new URL(c.destinationUrl);
              const destQ = destU.searchParams.get("q");
              if (destQ && url.includes(destQ)) return true;
              const destSid = destU.searchParams.get("sid");
              if (destSid && url.includes(destSid)) return true;
            } catch {}
          }
          return false;
        });
        if (matchingCard && !matchingCard.complete) {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            args: [{
              activityType: matchingCard.activityType || "bingredirect",
              offerId: matchingCard.offerId || matchingCard.name,
              authKey: matchingCard.hash,
              userId: dailySet.userId || "",
            }],
            func: async (payload) => {
              if (!payload.offerId || !payload.authKey) return null;
              try {
                return await fetch("https://www.bing.com/msrewards/api/v1/reportactivity", {
                  method: "POST",
                  headers: { "Content-Type": "text/plain;charset=UTF-8" },
                  credentials: "include",
                  body: JSON.stringify({
                    ActivityType: payload.activityType || "bingredirect",
                    ActivitySubType: "",
                    OfferId: payload.offerId,
                    Channel: "BingFlyout",
                    PartnerId: "BingRewards",
                    UserId: payload.userId || "",
                    AuthKey: payload.authKey,
                    ActivityCount: 1,
                  }),
                }).then((r) => r.json());
              } catch {}
            },
          });
        }
      }
    } catch {}
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_RESTORED_DAILY_SET") {
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const cached = await chrome.storage.local.get(["cachedDailySetData", "cachedDailySetDate"]);
        let data = cached?.cachedDailySetData;
        const cachedDate = cached?.cachedDailySetDate;
        if (!data || cachedDate !== today || !Array.isArray(data.cards) || data.cards.length === 0) {
          const flyoutRes = await fetch("https://www.bing.com/rewards/panelflyout", {
            credentials: "include",
          });
          if (flyoutRes.ok) {
            const html = await flyoutRes.text();
            data = extractDailySetFromFlyoutHtml(html);
            if (data && data.cards.length > 0) {
              await chrome.storage.local.set({ cachedDailySetData: data, cachedDailySetDate: today });
            }
            const actData = extractYourActivityFromFlyoutHtml(html);
            if (actData && actData.activities?.length > 0) {
              await chrome.storage.local.set({ cachedYourActivityData: actData, cachedYourActivityDate: today });
            }
          }
        }
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (msg.type === "GET_YOUR_ACTIVITY") {
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const cached = await chrome.storage.local.get(["cachedYourActivityData", "cachedYourActivityDate"]);
        let data = cached?.cachedYourActivityData;
        const cachedDate = cached?.cachedYourActivityDate;
        if (!data || cachedDate !== today || !Array.isArray(data.activities) || data.activities.length === 0) {
          const flyoutRes = await fetch("https://www.bing.com/rewards/panelflyout", {
            credentials: "include",
          });
          if (flyoutRes.ok) {
            const html = await flyoutRes.text();
            data = extractYourActivityFromFlyoutHtml(html);
            if (data && data.activities?.length > 0) {
              await chrome.storage.local.set({ cachedYourActivityData: data, cachedYourActivityDate: today });
            }
            const dailySetData = extractDailySetFromFlyoutHtml(html);
            if (dailySetData && dailySetData.cards?.length > 0) {
              await chrome.storage.local.set({ cachedDailySetData: dailySetData, cachedDailySetDate: today });
            }
          }
        }
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (msg.type === "TRIGGER_VISUAL_SEARCH") {
    (async () => {
      try {
        const outcome = await performVisualSearch();
        const flyoutRes = await fetch("https://www.bing.com/rewards/panelflyout", {
          credentials: "include",
        });
        let data = null;
        if (flyoutRes.ok) {
          const html = await flyoutRes.text();
          data = extractYourActivityFromFlyoutHtml(html);
          const today = new Date().toISOString().slice(0, 10);
          if (data && data.activities?.length > 0) {
            await chrome.storage.local.set({ cachedYourActivityData: data, cachedYourActivityDate: today });
          }
        }
        sendResponse({ ok: outcome?.ok ?? true, outcome, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (msg.type === "RUN_REWARDS") {
    autoClickRewards()
      .then((outcomes) => sendResponse?.({ ok: true, outcomes }))
      .catch((e) => sendResponse?.({ ok: false, error: String(e) }));
    return true;
  }
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
  const current = await chrome.storage.sync.get(["enabled", "time", "searchesPerRun"]);
  const updates = {};

  if (current.enabled === undefined) {
    updates.enabled = DEFAULTS.enabled;
  }
  if (!current.time || current.time === "08:00") {
    updates.time = DEFAULT_RUN_TIME;
  }
  if (current.searchesPerRun === undefined || current.searchesPerRun === 50 || current.searchesPerRun === 10) {
    updates.searchesPerRun = DEFAULTS.searchesPerRun;
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
