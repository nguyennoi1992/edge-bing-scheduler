// Use as an ES module for MV3 service worker
import { buildQueries } from "./words.js";

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
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            } catch {}

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
              } catch {}
            }

            try {
              el.click();
            } catch {}
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

          const readyCard = findReadyToClaimCard();
          if (!readyCard) {
            return { clicked: false, claimedPoints: 0, reason: "not_ready" };
          }

          clickElement(readyCard.cardButton);

          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await sleep(pollMs);
            const claimPointsButton = findDialogClaimButton();
            if (!claimPointsButton) continue;

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
            } catch {}
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
    const [{ result: questCards = [] }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const normalizeText = (value) =>
            (value || "").replace(/\s+/g, " ").trim();

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
            document.querySelectorAll("#quests a[href], button.rounded-cornerCardDefault, a.rounded-cornerCardDefault")
          );
          const seen = new Set();
          const items = [];

          for (const node of questNodes) {
            if (!isVisible(node)) continue;
            
            const href = node.getAttribute("href") || "";
            if (node.tagName.toLowerCase() === "a" && (!href || !/\/earn\/quest\//i.test(href))) {
              if (node.closest("#quests")) continue;
            }

            const linkText = normalizeText(node.innerText || node.textContent || "");
            if (!linkText) continue;

            const key = (href || "btn") + "|" + linkText.toLowerCase();

            if (seen.has(key)) continue;
            seen.add(key);

            items.push({
              href: key,
              key: key,
            });
          }

          return items;
        },
      });

    return questCards;
  }

  async function clickQuestCard(tabId, targetHref) {
    const [{ result: clicked = false }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [targetHref],
        func: async (hrefToClick) => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const normalizeText = (value) =>
            (value || "").replace(/\s+/g, " ").trim();

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
              document.querySelectorAll("#quests a[href], button.rounded-cornerCardDefault, a.rounded-cornerCardDefault")
            );

            card = questNodes.find((el) => {
              if (!isVisible(el)) return false;
              const href = el.getAttribute("href") || "";
              const linkText = normalizeText(el.innerText || el.textContent || "");
              const key = (href || "btn") + "|" + linkText.toLowerCase();
              return key === hrefToClick;
            });

            if (card) break;
            await sleep(800);
          }

          if (!card) return false;

          try {
            card.scrollIntoView({ behavior: "smooth", block: "center" });
          } catch {}

          for (const type of ["mouseover", "mousedown", "mouseup"]) {
            try {
              card.dispatchEvent(
                new MouseEvent(type, {
                  view: window,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            } catch {}
          }

          try {
            card.click();
          } catch {}

          return true;
        },
      });

    return clicked;
  }

  async function getQuestActivities(tabId) {
    const [{ result: activities = [] }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const normalizeText = (value) =>
            (value || "").replace(/\s+/g, " ").trim();

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

          let activitiesRoot = null;
          const activitiesHeading = Array.from(document.querySelectorAll("h2, h3, h4")).find(
            (el) => isVisible(el) && /activities|hoạt động|tareas|activités|aufgaben/i.test(normalizeText(el.textContent)),
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

          const actionables = Array.from(
            activitiesRoot.querySelectorAll(
              "a[href], button, [role='button'], [role='link']",
            ),
          )
            .filter((el) => isVisible(el))
            .filter((el) => {
              if (el.closest("nav, header, [role='banner']")) return false;
              if (el.classList.contains("rounded-cornerCardDefault")) return false;
              
              const innerLabel = normalizeText(el.innerText || el.textContent || "");
              const ariaLabel = normalizeText(el.getAttribute("aria-label") || "");
              const label = (ariaLabel + " " + innerLabel).trim().toLowerCase();
              
              if (!label) return false;
              if (/^(activities|hoạt động|tareas|activités|aufgaben)$/i.test(label)) return false;
              if (/^(status:|expires:|trạng thái:|hết hạn:)/i.test(label)) return false;
              if (/^(feedback|privacy|terms|microsoft|bing|search)$/i.test(label)) return false;
              if (el.getAttribute("aria-disabled") === "true") return false;
              if (el.closest("[aria-disabled='true'], [data-disabled='true']")) return false;
              
              if (/^(back|close|quay lại|đóng|zurück|schließen|retour|fermer|volver|cerrar)$/i.test(innerLabel)) return false;
              
              // Skip if it's a completed quest activity (checked green circle)
              // Completed items usually have a specific status icon or aria-label
              const isCompleted = el.closest("[class*='completed'], [class*='Success']") || 
                                  el.querySelector("svg[class*='Success'], mee-icon[class*='Success']") ||
                                  /completed|done|hoàn thành|đã xong/i.test(label);
              if (isCompleted) return false;

              return true;
            });

          const seen = new Set();
          const items = [];
          for (const el of actionables) {
            const href = el.getAttribute("href") || "";
            const innerLabel = normalizeText(
              el.innerText || el.textContent || "",
            );
            const ariaLabel = normalizeText(el.getAttribute("aria-label") || "");
            // Prefer aria-label for key since it contains the full action description
            const label = ariaLabel || innerLabel;
            const key = href + "|" + label.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ href, label, key });
          }

          return items;
        },
      });

    return activities;
  }

  async function clickQuestActivity(tabId, targetKey) {
    const [{ result: clicked = false }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [targetKey],
        func: async (keyToClick) => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const normalizeText = (value) =>
            (value || "").replace(/\s+/g, " ").trim();

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
          for (let attempt = 0; attempt < 20; attempt++) {
            let activitiesRoot = null;
            const activitiesHeading = Array.from(document.querySelectorAll("h2, h3, h4")).find(
              (heading) => isVisible(heading) && /activities|hoạt động|tareas|activités|aufgaben/i.test(normalizeText(heading.textContent)),
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
              el = Array.from(
                activitiesRoot.querySelectorAll(
                  "a[href], button, [role='button'], [role='link']",
                ),
              ).find((candidate) => {
                if (!isVisible(candidate)) return false;
                if (candidate.closest("nav, header, [role='banner']")) return false;
                if (candidate.classList.contains("rounded-cornerCardDefault")) return false;

                const innerLabel = normalizeText(candidate.innerText || candidate.textContent || "");
                const ariaLabel = normalizeText(candidate.getAttribute("aria-label") || "");
                const label = (ariaLabel + " " + innerLabel).trim().toLowerCase();

                if (!label) return false;
                if (/^(activities|hoạt động|tareas|activités|aufgaben)$/i.test(label)) return false;
                if (/^(status:|expires:|trạng thái:|hết hạn:)/i.test(label)) return false;
                if (/^(feedback|privacy|terms|microsoft|bing|search)$/i.test(label)) return false;
                if (candidate.getAttribute("aria-disabled") === "true") return false;
                if (candidate.closest("[aria-disabled='true'], [data-disabled='true']")) return false;
                if (/^(back|close|quay lại|đóng|zurück|schließen|retour|fermer|volver|cerrar)$/i.test(innerLabel)) return false;

                const isCompleted = candidate.closest("[class*='completed'], [class*='Success']") || 
                                    candidate.querySelector("svg[class*='Success'], mee-icon[class*='Success']") ||
                                    /completed|done|hoàn thành|đã xong/i.test(label);
                if (isCompleted) return false;

                const href = candidate.getAttribute("href") || "";
                const candLabel = ariaLabel || innerLabel;
                const candKey = href + "|" + candLabel.toLowerCase();
                
                // Robust matching: if the key has a valid href, and the candidate matches it exactly, return true
                const targetHrefPart = keyToClick.split("|")[0];
                if (targetHrefPart && href && href === targetHrefPart) {
                  return true;
                }
                
                return candKey === keyToClick;
              });
            }

            if (el) break;
            await sleep(800);
          }

          if (!el) return { clicked: false, href: "" };

          function centerPoint(element) {
            const rect = element.getBoundingClientRect();
            return {
              clientX: rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2)),
              clientY: rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2)),
            };
          }

          function dispatchPointerMouseSequence(target) {
            if (!target) return false;
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
              } catch {}
            }
            return true;
          }

          function getClickableTargets(container) {
            if (!container) return [];
            const candidates = [
              container.matches?.("a[href], [role=\"link\"], [role=\"button\"], button") ? container : null,
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

          const targets = getClickableTargets(el);
          let success = false;

          for (const target of targets) {
            try {
              target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
            } catch {}
            
            try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch {} }

            try {
              dispatchPointerMouseSequence(target);
              await sleep(300);
            } catch {}

            try {
              target.click();
              // Brute-force click all inner elements in case React is attached to a child span/svg
              const children = target.querySelectorAll("*");
              for (const child of children) {
                try { child.click(); } catch {}
              }
              await sleep(300);
            } catch {}

            for (const key of ["Enter", " "]) {
               try {
                 const code = key === " " ? "Space" : key;
                 try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch {} }
                 for (const type of ["keydown", "keypress", "keyup"]) {
                   target.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true }));
                 }
                 await sleep(200);
               } catch {}
            }
            
            success = true;
          }

          return { clicked: success, href: el.getAttribute("href") };
        },
      });

    return clicked;
  }

  async function getRewardCards(tabId) {
    const [{ result: rewardCards = [] }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [rewardSectionIds],
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

            const normalizeText = (value) =>
              (value || "").replace(/\s+/g, " ").trim();

            function expandSectionIfCollapsed(section) {
              if (!section) return;
              // React Aria Disclosure pattern: button[slot='trigger']
              const trigger = section.querySelector(
                "button[slot='trigger'][aria-expanded='false']",
              );
              if (trigger) {
                try {
                  trigger.click();
                } catch {}
              }
              // Also handle aria-expanded on buttons with aria-controls
              const collapsedBtns = section.querySelectorAll(
                "button[aria-expanded='false'][aria-controls]",
              );
              for (const btn of collapsedBtns) {
                try { btn.click(); } catch {}
              }
            }

            function isCardCompleted(cardEl) {
              if (!cardEl) return false;
              // i18n pattern for "completed"/"done" across languages
              const completedRe = /\bcompleted\b|\bdone\b|hoàn thành|đã xong|已完成|完了|terminé|abgeschlossen|completado|завершено/i;

              // Method 1: CSS-class based (locale-independent) – success badge with checkmark SVG
              const successBadge = cardEl.querySelector(
                "[class*='statusSuccess']"
              );
              if (successBadge && successBadge.querySelector("svg")) {
                return true;
              }

              // Method 2: Check for completed text in the status/metadata area
              const statusEls = cardEl.querySelectorAll(
                "[class*='metadata'], [class*='fgCtrlNeutralSecondary']"
              );
              for (const el of statusEls) {
                const t = normalizeText(el.textContent || "").toLowerCase();
                if (completedRe.test(t)) return true;
              }

              // Method 3: Legacy full-text fallback
              const fullText = normalizeText(cardEl.innerText || cardEl.textContent || "").toLowerCase();
              if (completedRe.test(fullText)) return true;

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

              // Accumulate all <a> inside all possible grids
              const gridSelectors = [
                "div.grid.gap-3.lg\\:grid-cols-2.xl\\:grid-cols-3 > a[href]",
                "div.grid.gap-3.lg\\:grid-cols-2.\\32 xl\\:grid-cols-3 > a[href]",
                "div[class*='grid'][class*='gap'] > a[href]",
                "div.grid.gap-3 > a[href]",
                ".react-aria-DisclosurePanel a[href]",
                "[role='group'] a[href]"
              ];
              let gridAnchors = [];
              const seenAnchors = new Set();
              for (const selector of gridSelectors) {
                const anchors = Array.from(rootNode.querySelectorAll(selector));
                for (const a of anchors) {
                  if (!seenAnchors.has(a)) {
                    seenAnchors.add(a);
                    gridAnchors.push(a);
                  }
                }
              }

              const unique = [];
              const seen = new Set();

              for (const a of gridAnchors) {
                if (!a || !isVisible(a)) continue;
                // Card must have visual content (img, svg, icon)
                if (
                  !a.querySelector("img") &&
                  !a.querySelector("mee-icon") &&
                  !a.querySelector("svg") &&
                  !a.querySelector(".mee-icon")
                ) continue;
                if (
                  a.getAttribute("aria-disabled") === "true" ||
                  a.closest("[aria-disabled='true'], [data-disabled='true']")
                ) {
                  continue;
                }

                const href = a.getAttribute("href") || "";
                if (!href || href === "/earn") continue;

                const text = normalizeText(a.innerText || a.textContent || "").toLowerCase();
                if (text.includes("see more tasks") || text.includes("earn more")) continue;

                const key = `${href}|${text}`;
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(a);
              }

              console.log(
                `[Rewards] Section #${sectionId}: found ${unique.length} actionable card(s)`,
              );
              return unique;
            }

            function buildCardKey(card) {
              const href = card?.href || card?.getAttribute?.("href") || "";
              const titleEl =
                card.querySelector("p.text-globalBody2Strong") ||
                card.querySelector("p.text-body1Strong") ||
                card.querySelector("p[class*=\"globalBody2Strong\"]") ||
                card.querySelector("p[class*=\"body1Strong\"]") ||
                card.querySelector("p") ||
                card.querySelector("img[alt]");
              const rawTitle =
                titleEl?.textContent || titleEl?.getAttribute?.("alt") || "";
              const title = rawTitle.replace(/\s+/g, " ").trim().toLowerCase();
              return `${href}|${title}`;
            }

            function collectCards(cards) {
              const items = [];
              const seen = new Set();

              for (const card of cards) {
                const href = card?.href || card?.getAttribute?.("href") || "";
                if (!href) continue;
                const key = buildCardKey(card);
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

    return rewardCards;
  }

  async function clickRewardCard(tabId, targetKey) {
    const [{ result: clicked = false }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [targetKey, rewardSectionIds],
        func: async (keyToClick, sectionIds) => {
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
              } catch {}
            }
            // Also handle aria-expanded on buttons with aria-controls
            const collapsedBtns = section.querySelectorAll(
              "button[aria-expanded='false'][aria-controls]",
            );
            for (const btn of collapsedBtns) {
              try { btn.click(); } catch {}
            }
          }

          function isCardCompleted(cardEl) {
            if (!cardEl) return false;
            // i18n pattern for "completed"/"done" across languages
            const completedRe = /\bcompleted\b|\bdone\b|hoàn thành|đã xong|已完成|完了|terminé|abgeschlossen|completado|завершено/i;

            // Method 1: CSS-class based (locale-independent) – success badge with checkmark SVG
            const successBadge = cardEl.querySelector(
              "[class*='statusSuccess']"
            );
            if (successBadge && successBadge.querySelector("svg")) {
              return true;
            }

            // Method 2: Check for completed text in the status/metadata area
            const statusEls = cardEl.querySelectorAll(
              "[class*='metadata'], [class*='fgCtrlNeutralSecondary']"
            );
            for (const el of statusEls) {
              const t = normalizeText(el.textContent || "").toLowerCase();
              if (completedRe.test(t)) return true;
            }

            // Full-text fallback
            const fullText = normalizeText(cardEl.innerText || cardEl.textContent || "").toLowerCase();
            if (completedRe.test(fullText)) return true;
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

            const gridSelectors = [
              "div.grid.gap-3.lg\\:grid-cols-2.xl\\:grid-cols-3 > a[href]",
              "div.grid.gap-3.lg\\:grid-cols-2.\\32 xl\\:grid-cols-3 > a[href]",
              "div[class*='grid'][class*='gap'] > a[href]",
              "div.grid.gap-3 > a[href]",
              ".react-aria-DisclosurePanel a[href]",
              "[role='group'] a[href]"
            ];
            let gridAnchors = [];
            const seenAnchors = new Set();
            for (const selector of gridSelectors) {
              const anchors = Array.from(rootNode.querySelectorAll(selector));
              for (const a of anchors) {
                if (!seenAnchors.has(a)) {
                  seenAnchors.add(a);
                  gridAnchors.push(a);
                }
              }
            }

            return gridAnchors
              .filter((a) => a && isVisible(a) && (a.querySelector("img") || a.querySelector("mee-icon") || a.querySelector("svg") || a.querySelector(".mee-icon")))
              .filter((a) => !isDisabled(a))
              .filter((a) => {
                const href = a.getAttribute("href") || "";
                if (!href || href === "/earn") return false;
                const text = normalizeText(a.innerText || a.textContent || "").toLowerCase();
                if (text.includes("see more tasks") || text.includes("earn more")) return false;
                return true;
              });
          }

          function buildCardKey(card) {
            const href = card?.href || card?.getAttribute?.("href") || "";
            const titleEl =
              card.querySelector("p.text-globalBody2Strong") ||
              card.querySelector("p.text-body1Strong") ||
              card.querySelector("p[class*=\"globalBody2Strong\"]") ||
              card.querySelector("p[class*=\"body1Strong\"]") ||
              card.querySelector("p") ||
              card.querySelector("img[alt]");
            const rawTitle =
              titleEl?.textContent || titleEl?.getAttribute?.("alt") || "";
            const title = rawTitle.replace(/\s+/g, " ").trim().toLowerCase();
            return `${href}|${title}`;
          }

          function getCardSignature(card) {
            if (!card) return "";
            const href = card?.getAttribute?.("href") || card?.href || "";
            const expanded =
              card.getAttribute("aria-expanded") ||
              card.querySelector("[aria-expanded]")?.getAttribute("aria-expanded") ||
              "";
            const disabled = isDisabled(card) ? "disabled" : "enabled";
            const status = normalizeText(card?.innerText || card?.textContent || "").toLowerCase();
            return `${href}|${expanded}|${disabled}|${status}`;
          }

          function getClickableTargets(card) {
            if (!card) return [];

            const candidates = [
              card.matches?.("[data-react-aria-pressable=\"true\"], a[href], [role=\"link\"], [role=\"button\"], button") ? card : null,
              card.querySelector("[data-react-aria-pressable=\"true\"]"),
              card.querySelector("a[href]"),
              card.querySelector("[role=\"link\"]"),
              card.querySelector("[role=\"button\"]"),
              card.querySelector("button"),
              card.querySelector("img"),
              card.querySelector("mee-icon"),
              card.querySelector("svg"),
              card,
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
              } catch {}
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
              target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
            } catch {}

            try {
              target.focus({ preventScroll: true });
            } catch {
              try {
                target.focus();
              } catch {}
            }

            // For external links (target="_blank"), clicking opens a new tab
            // but doesn't change the current page's URL or DOM.
            // We must click the actual card element (not window.open) for Bing to register it.
            if (isExternalLink) {
              // Full pointer+mouse event sequence on the target
              try {
                dispatchPointerMouseSequence(target);
                await sleep(300);
              } catch {}

              // Native .click()
              try {
                target.click();
                await sleep(300);
              } catch {}

              // Keyboard Enter as fallback
              try {
                try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch {} }
                for (const type of ["keydown", "keypress", "keyup"]) {
                  target.dispatchEvent(
                    new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true }),
                  );
                }
                await sleep(300);
              } catch {}

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
            } catch {}

            try {
              target.click();
              await sleep(250);
              if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                return true;
              }
            } catch {}

            // Keyboard fallback (Enter / Space)
            for (const key of ["Enter", " "]) {
              try {
                const code = key === " " ? "Space" : key;
                try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch {} }
                for (const type of ["keydown", "keypress", "keyup"]) {
                  target.dispatchEvent(
                    new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true }),
                  );
                }
                await sleep(250);
                if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                  return true;
                }
              } catch {}
            }

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
              } catch {}

              try {
                topEl.click();
                await sleep(250);
                if (getCardSignature(card) !== beforeSignature || location.href !== beforeUrl) {
                  return true;
                }
              } catch {}
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
            return false;
          }

          console.log(`[Rewards] Found card to click, trying ${getClickableTargets(card).length} targets`);
          const targets = getClickableTargets(card);
          for (const target of targets) {
            if (await tryActivateTarget(card, target)) {
              return true;
            }
          }

          return false;
        },
      });

    return clicked;
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
                el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
              } catch {}
              try {
                el.focus({ preventScroll: true });
              } catch {
                try {
                  el.focus();
                } catch {}
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
                } catch {}
              }

              try {
                el.click();
              } catch {}
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
    const deadlineAt = Date.now() + REWARD_URL_TIMEOUT_MS;
    const timedOut = () => Date.now() >= deadlineAt;

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

      if (/rewards\.bing\.com\/dashboard/i.test(url)) {
        const claimResult = await claimReadyPoints(tab.id);
        if (claimResult.clicked) {
          console.log(
            `[Rewards] Claimed ${claimResult.claimedPoints} ready point(s) from dashboard`,
          );
          await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));
          await chrome.tabs.reload(tab.id);
          await waitForTabComplete(tab.id);
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          console.log(
            `[Rewards] No ready points claimed on dashboard (${claimResult.reason || "not_available"})`,
          );
        }
      }

      if (/rewards\.bing\.com\/earn/i.test(url)) {
        const attemptedQuestKeys = new Set();
        const maxQuestCards = 8;

        for (let i = 0; i < maxQuestCards; i++) {
          if (timedOut()) {
            console.warn("[Rewards] Timeout budget reached while processing quest cards for " + url);
            break;
          }
          const questCards = await getQuestCards(tab.id);
          const nextQuest = questCards.find((card) => !attemptedQuestKeys.has(card.key));

          if (!nextQuest) {
            console.log("[Rewards] No more quest cards found for " + url);
            break;
          }

          attemptedQuestKeys.add(nextQuest.key);
          console.log("[Rewards] Opening quest " + (i + 1) + ": " + nextQuest.href);

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
              break;
            }
            const questActivities = await getQuestActivities(tab.id);
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
            if (newTabIds.length === 0 && wasClicked && targetHref && targetHref.startsWith("http")) {
              console.log("[Rewards] DOM click failed to open new tab, falling back to manual open: " + targetHref);
              try {
                // MUST be active: true so Bing's tracking script on the search page fires!
                const fallbackTab = await chrome.tabs.create({ url: targetHref, active: true, windowId });
                newTabIds.push(fallbackTab.id);
                await waitForTabComplete(fallbackTab.id);
              } catch (e) {
                console.warn("[Rewards] Fallback tab creation failed:", e);
              }
            }

            // Scroll like a human on each child tab before closing
            for (const childTabId of newTabIds) {
              try {
                // Ensure the tab is active so that tracking pixels fire properly
                await chrome.tabs.update(childTabId, { active: true });
                await waitForTabComplete(childTabId);
                await humanScrollOnTab(childTabId);
              } catch {}
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
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // Collect all reward cards once, click through each one, then move on.
      // The second rewards pass after searches will handle any remaining cards.
      const rewardCards = await getRewardCards(tab.id);
      await appendDebugLog("info", "rewards", `Found ${rewardCards.length} reward card(s) to click`, {
        url,
        cards: rewardCards.map((c) => c.key.substring(0, 60)).join(" | "),
      });

      for (let i = 0; i < rewardCards.length; i++) {
        if (timedOut()) {
          console.warn("[Rewards] Timeout budget reached while clicking reward cards for " + url);
          await appendDebugLog("warn", "rewards", "Timeout budget reached for reward cards", { url, processed: i, total: rewardCards.length });
          break;
        }

        const card = rewardCards[i];
        console.log(`[Rewards] Clicking reward card ${i + 1}/${rewardCards.length}: ${card.href}`);
        await appendDebugLog("info", "rewards", `Clicking card ${i + 1}/${rewardCards.length}`, {
          href: card.href.substring(0, 80),
        });

        const clicked = await clickRewardCard(tab.id, card.key);
        await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));

        // Collect and scroll child tabs that were spawned before closing
        const currentTabs = await chrome.tabs.query({ windowId });
        const newTabIds = currentTabs
          .map((t) => t.id)
          .filter((id) => Number.isInteger(id))
          .filter((id) => !baselineTabIds.has(id))
          .filter((id) => id !== tab.id);

        // Scroll like a human on each child tab so Bing registers the visit
        for (const childTabId of newTabIds) {
          try {
            await humanScrollOnTab(childTabId);
          } catch {}
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

        console.log(`[Rewards] Card ${i + 1}/${rewardCards.length} done (clicked=${clicked}, childTabs=${newTabIds.length})`);
        await appendDebugLog("info", "rewards", `Card ${i + 1} done`, {
          href: card.href.substring(0, 80),
          clicked,
          childTabs: newTabIds.length,
        });

        // Navigate back to rewards page for the next card
        if (i < rewardCards.length - 1) {
          await chrome.tabs.update(tab.id, { url, active: true });
          await waitForTabComplete(tab.id);
          await ensureTabFocused(tab.id);
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
        const tInfo = await chrome.tabs.get(tabId);
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













