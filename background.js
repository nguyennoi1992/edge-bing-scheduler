// Use as an ES module for MV3 service worker
import { buildQueries } from "./words.js";

const ALARM_NAME = "bingScheduler";
const BADGE_ALARM = "badgeTick";
const REWARDS_SETTLE_MS = 8000;
const REWARD_CHILD_SYNC_MS = 5000;
const REWARD_URL_TIMEOUT_MS = 150000;
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
  const rewardSectionIds = ["moreactivities", "dailyset", "exploreonbing"];
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

  async function closeChildTabs(parentTabId, rounds = 4, delayMs = 1200) {
    for (let i = 0; i < rounds; i++) {
      const allTabs = await chrome.tabs.query({});
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
  ) {
    const rewardLikeUrl =
      /(rewards\.bing\.com|bing\.com|msn\.com|microsoft\.com\/rewards)/i;
    const exclude = new Set(
      (excludeTabIds || []).filter((id) => Number.isInteger(id)),
    );

    for (let i = 0; i < rounds; i++) {
      const allTabs = await chrome.tabs.query({});
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

          const questSection = document.querySelector("#quests");
          if (!questSection) return [];

          const links = Array.from(questSection.querySelectorAll("a[href]"));
          const seen = new Set();
          const items = [];

          for (const link of links) {
            if (!isVisible(link)) continue;
            const href = link.getAttribute("href") || "";
            if (!href || !/\/earn\/quest\//i.test(href)) continue;
            if (seen.has(href)) continue;
            seen.add(href);

            const linkText = normalizeText(link.innerText || link.textContent || "");
            items.push({
              href,
              key: href + "|" + linkText.toLowerCase(),
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
        func: (hrefToClick) => {
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

          const questSection = document.querySelector("#quests");
          if (!questSection) return false;

          const card = Array.from(questSection.querySelectorAll("a[href]")).find(
            (el) => isVisible(el) && (el.getAttribute("href") || "") === hrefToClick,
          );

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

          const activitiesHeading = Array.from(document.querySelectorAll("h2")).find(
            (el) => normalizeText(el.textContent).toLowerCase() === "activities",
          );
          const activitiesRoot =
            activitiesHeading?.closest("div.overflow-hidden") ||
            activitiesHeading?.parentElement?.parentElement?.parentElement;
          if (!activitiesRoot) return [];

          const actionables = Array.from(
            activitiesRoot.querySelectorAll(
              "a[href], button, [role='button'], [role='link'][href]",
            ),
          )
            .filter((el) => isVisible(el))
            .filter((el) => {
              const label = normalizeText(
                el.innerText || el.textContent || el.getAttribute("aria-label") || "",
              );
              if (!label) return false;
              if (/^activities$/i.test(label)) return false;
              if (/^status:/i.test(label) || /^expires:/i.test(label)) return false;
              if (el.getAttribute("aria-disabled") === "true") return false;
              if (el.closest("[aria-disabled='true'], [data-disabled='true']")) {
                return false;
              }
              return /click to complete|see |view |plan /i.test(label);
            });

          const seen = new Set();
          const items = [];
          for (const el of actionables) {
            const href = el.getAttribute("href") || "";
            const label = normalizeText(
              el.innerText || el.textContent || el.getAttribute("aria-label") || "",
            );
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
        func: (keyToClick) => {
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

          const activitiesHeading = Array.from(document.querySelectorAll("h2")).find(
            (el) => normalizeText(el.textContent).toLowerCase() === "activities",
          );
          const activitiesRoot =
            activitiesHeading?.closest("div.overflow-hidden") ||
            activitiesHeading?.parentElement?.parentElement?.parentElement;
          if (!activitiesRoot) return false;

          const el = Array.from(
            activitiesRoot.querySelectorAll(
              "a[href], button, [role='button'], [role='link'][href]",
            ),
          ).find((candidate) => {
            if (!isVisible(candidate)) return false;
            if (candidate.getAttribute("aria-disabled") === "true") return false;
            if (candidate.closest("[aria-disabled='true'], [data-disabled='true']")) {
              return false;
            }
            const href = candidate.getAttribute("href") || "";
            const label = normalizeText(
              candidate.innerText ||
                candidate.textContent ||
                candidate.getAttribute("aria-label") ||
                "",
            );
            return href + "|" + label.toLowerCase() === keyToClick;
          });

          if (!el) return false;

          try {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
          } catch {}

          for (const type of ["mouseover", "mousedown", "mouseup"]) {
            try {
              el.dispatchEvent(
                new MouseEvent(type, {
                  view: window,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            } catch {}
          }

          try {
            el.click();
          } catch {}

          return true;
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
              const section = document.querySelector(`#${sectionId}`);
              if (!section) return [];
              expandSectionIfCollapsed(section);

              // Broad search: find all <a> inside grids first, then fallback to all <a>
              const gridSelectors = [
                "div.grid.gap-3.lg\\:grid-cols-2.xl\\:grid-cols-3",
                "div.grid.gap-3.lg\\:grid-cols-2.\\32 xl\\:grid-cols-3",
                "div[class*='grid'][class*='gap']",
                "div.grid.gap-3",
              ];
              let gridAnchors = [];
              for (const selector of gridSelectors) {
                gridAnchors = Array.from(
                  section.querySelectorAll(`${selector} > a[href]`)
                );
                if (gridAnchors.length) break;
              }
              // Fallback: all anchor children within the disclosure panel
              if (!gridAnchors.length) {
                const panel = section.querySelector(
                  ".react-aria-DisclosurePanel, [role='group']"
                );
                gridAnchors = Array.from(
                  (panel || section).querySelectorAll("a[href]")
                );
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

                // Check completed status using robust badge/status checks
                if (isCardCompleted(a)) continue;

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
            const section = document.querySelector(`#${sectionId}`);
            if (!section) return [];
            expandSectionIfCollapsed(section);

            const gridSelectors = [
              "div.grid.gap-3.lg\\:grid-cols-2.xl\\:grid-cols-3",
              "div.grid.gap-3.lg\\:grid-cols-2.\\32 xl\\:grid-cols-3",
              "div[class*='grid'][class*='gap']",
              "div.grid.gap-3",
            ];
            let gridAnchors = [];
            for (const selector of gridSelectors) {
              gridAnchors = Array.from(
                section.querySelectorAll(`${selector} > a[href]`)
              );
              if (gridAnchors.length) break;
            }
            if (!gridAnchors.length) {
              const panel = section.querySelector(
                ".react-aria-DisclosurePanel, [role='group']"
              );
              gridAnchors = Array.from(
                (panel || section).querySelectorAll("a[href]")
              );
            }

            return gridAnchors
              .filter((a) => a && isVisible(a) && (a.querySelector("img") || a.querySelector("mee-icon") || a.querySelector("svg") || a.querySelector(".mee-icon")))
              .filter((a) => !isDisabled(a))
              .filter((a) => {
                const href = a.getAttribute("href") || "";
                if (!href || href === "/earn") return false;
                const text = normalizeText(a.innerText || a.textContent || "").toLowerCase();
                if (text.includes("see more tasks") || text.includes("earn more")) return false;
                return !isCardCompleted(a);
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

          const cards = (sectionIds || [])
            .map((sectionId) => collectSectionCardsById(sectionId))
            .flat();
          const card = cards.find((a) => buildCardKey(a) === keyToClick);

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
    const tabsBefore = await chrome.tabs.query({});
    const baselineTabIds = new Set(
      tabsBefore.map((t) => t.id).filter((id) => Number.isInteger(id)),
    );
    const tab = await chrome.tabs.create({ url, active: true });
    await ensureTabFocused(tab.id);
    const spawnedTabIds = new Set();
    const onCreated = (createdTab) => {
      if (Number.isInteger(createdTab.id)) {
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

            await clickQuestActivity(tab.id, nextActivity.key);
            await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));

            const currentTabs = await chrome.tabs.query({});
            const newTabIds = currentTabs
              .map((t) => t.id)
              .filter((id) => Number.isInteger(id))
              .filter((id) => !baselineTabIds.has(id))
              .filter((id) => id !== tab.id);

            for (const childTabId of newTabIds) {
              try {
                await waitForTabComplete(childTabId, 10000);
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

      const successfulCardKeys = new Set();
      const cardAttemptCounts = new Map();
      const processedRewardChildTabIds = new Set();
      const maxCardClicks = 12;
      const maxAttemptsPerCard = 2;

      for (let i = 0; i < maxCardClicks; i++) {
        if (timedOut()) {
          console.warn("[Rewards] Timeout budget reached while processing reward cards for " + url);
          await appendDebugLog("warn", "rewards", "Timeout budget reached for reward cards", { url });
          break;
        }
        const rewardCards = await getRewardCards(tab.id);
        await appendDebugLog("info", "rewards", `Found ${rewardCards.length} actionable card(s)`, {
          url,
          iteration: i + 1,
          cards: rewardCards.map((c) => c.key.substring(0, 60)).join(" | "),
        });
        const nextCard = rewardCards.find(
          (card) =>
            !successfulCardKeys.has(card.key) &&
            (cardAttemptCounts.get(card.key) || 0) < maxAttemptsPerCard,
        );

        if (!nextCard) {
          console.log(`[Rewards] No more actionable cards found for ${url}`);
          break;
        }

        const attemptNumber = (cardAttemptCounts.get(nextCard.key) || 0) + 1;
        cardAttemptCounts.set(nextCard.key, attemptNumber);
        console.log(
          `[Rewards] Clicking reward card ${i + 1}: ${nextCard.href} (${nextCard.key}) attempt ${attemptNumber}`,
        );
        await appendDebugLog("info", "rewards", `Clicking card ${i + 1}`, {
          href: nextCard.href.substring(0, 80),
          attempt: attemptNumber,
        });

        const clicked = await clickRewardCard(tab.id, nextCard.key);
        await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));

        const currentTabs = await chrome.tabs.query({});
        const newTabIds = currentTabs
          .map((t) => t.id)
          .filter((id) => Number.isInteger(id))
          .filter((id) => !baselineTabIds.has(id))
          .filter((id) => id !== tab.id)
          .filter((id) => !processedRewardChildTabIds.has(id));

        for (const childTabId of newTabIds) {
          try {
            await waitForTabComplete(childTabId, 10000);
            await ensureTabFocused(childTabId);
          } catch {}

          const childResult = await handleRewardChildTab(childTabId);
          processedRewardChildTabIds.add(childTabId);
          if (childResult.handled) {
            console.log(
              `[Rewards] Child tab ${childTabId} handled=${childResult.handled} completed=${childResult.completed} clicks=${childResult.clicks} reason=${childResult.reason}`,
            );
          }
        }

        if (newTabIds.length) {
          console.log(
            `[Rewards] Keeping ${newTabIds.length} reward child tab(s) open for sync before final cleanup`,
          );
          await new Promise((r) => setTimeout(r, REWARD_CHILD_SYNC_MS));
        }

        await chrome.tabs.reload(tab.id);
        await waitForTabComplete(tab.id);
        await ensureTabFocused(tab.id);
        await new Promise((r) => setTimeout(r, 2000));

        const refreshedCards = await getRewardCards(tab.id);
        const stillActionable = refreshedCards.some((card) => card.key === nextCard.key);
        const completed = !stillActionable;

        if (completed) {
          successfulCardKeys.add(nextCard.key);
        }

        console.log(
          `[Rewards] Reward card result ${completed ? "completed" : "not_completed"}: ` +
            `${nextCard.key} (clicked=${clicked}, childTabs=${newTabIds.length}, attempts=${attemptNumber})`,
        );
        await appendDebugLog(completed ? "success" : "warn", "rewards", `Card ${completed ? "completed" : "not_completed"}`, {
          href: nextCard.href.substring(0, 80),
          clicked,
          childTabs: newTabIds.length,
          attempt: attemptNumber,
        });
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
        await closeChildTabs(tab.id);
        await closeNewRewardTabs(baselineTabIds, [tab.id]);
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
      });
      tabId = created.id;
      singletonTabId = tabId;
    }
  } else {
    const created = await chrome.tabs.create({
      url: "https://www.bing.com/",
      active: true,
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

  // 2. Then continue with Bing searches
  const queries = getQueryList(cfg);
  const perOpenDelays = queries.map(() =>
    randomDelay(cfg.intervalMin, cfg.intervalMax),
  );

  const start = Date.now();
  let accumulatedSecs = 0;
  accumulatedSecs += perOpenDelays[0] || 0;
  const firstNextOpenAt = start + accumulatedSecs * 1000;
  await chrome.storage.sync.set({
    running: true,
    runEndsAt: null,
    nextOpenAt: firstNextOpenAt,
  });
  await updateBadge();

  await ensureRunTicker();

  let cumulativeDelaySecs = 0;
  queries.forEach((q, idx) => {
    cumulativeDelaySecs += perOpenDelays[idx];
    setTimeout(async () => {
      await appendDebugLog("info", "search", "Search opened", { query: q, index: idx + 1, total: queries.length });
      await openBingAndType(q);

      if (idx + 1 < perOpenDelays.length) {
        accumulatedSecs += perOpenDelays[idx + 1];
        const nextOpenAt = start + accumulatedSecs * 1000;
        await chrome.storage.sync.set({ nextOpenAt });
      } else {
        await chrome.storage.sync.set({ nextOpenAt: null });
      }

      await updateBadge();
    }, cumulativeDelaySecs * 1000);
  });

  const totalDelaySecs = perOpenDelays.reduce((a, b) => a + b, 0);
  // Add an extra 2 seconds buffer after the last search before the final sweep
  setTimeout(async () => {
    await appendDebugLog("success", "search", "Search phase completed", { totalQueries: queries.length });

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
    await updateBadge();
    await ensureRunTicker();
  }, (totalDelaySecs + 2) * 1000);
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













