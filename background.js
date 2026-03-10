// Use as an ES module for MV3 service worker
import { buildQueries } from "./words.js";

const ALARM_NAME = "bingScheduler";
const BADGE_ALARM = "badgeTick";
const REWARDS_SETTLE_MS = 8000;

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
  const rewardSectionIds = ["moreactivities", "dailyset", "exploreonbing"];
  const rewardUrls = [
    "https://rewards.bing.com/earn",
    "https://rewards.bing.com/dashboard",
  ];

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
        let opener = openerMap.get(id);
        while (Number.isInteger(opener)) {
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

  async function getRewardCards(tabId) {
    const [{ result: rewardCards = [] }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [rewardSectionIds],
        func: (sectionIds) => {
          return new Promise((resolve) => {
            const isVisible = (el) => {
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
              const trigger = section.querySelector(
                "button[slot='trigger'][aria-expanded='false']",
              );
              if (trigger) {
                try {
                  trigger.click();
                } catch {}
              }
            }

            function collectSectionCardsById(sectionId) {
              const section = document.querySelector(`#${sectionId}`);
              if (!section) return [];
              expandSectionIfCollapsed(section);

              const anchors = Array.from(section.querySelectorAll("a[href]"));
              const unique = [];
              const seen = new Set();

              for (const a of anchors) {
                if (!a || !isVisible(a)) continue;
                if (!a.querySelector("img")) continue;
                if (
                  a.getAttribute("aria-disabled") === "true" ||
                  a.closest("[aria-disabled='true'], [data-disabled='true']")
                ) {
                  continue;
                }

                const href = a.getAttribute("href") || "";
                if (!href || href === "/earn") continue;

                const text = (a.innerText || a.textContent || "").toLowerCase();
                if (text.includes("see more tasks")) continue;

                const key = `${href}|${text.replace(/\s+/g, " ").trim()}`;
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(a);
              }

              return unique;
            }

            function buildCardKey(card) {
              const href = card?.href || card?.getAttribute?.("href") || "";
              const titleEl =
                card.querySelector("p.text-body1Strong") ||
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
            const maxAttempts = 8;
            const pollMs = 1000;

            const timer = setInterval(() => {
              attempts++;
              const sectionCards = (sectionIds || [])
                .map((sectionId) => collectSectionCardsById(sectionId))
                .flat();
              const cards = collectCards(sectionCards);

              if (cards.length || attempts >= maxAttempts) {
                clearInterval(timer);
                console.log(
                  `[Rewards] Actionable cards found across sections: ${sectionCards.length}`,
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
        func: (keyToClick, sectionIds) => {
          const isVisible = (el) => {
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
            const trigger = section.querySelector(
              "button[slot='trigger'][aria-expanded='false']",
            );
            if (trigger) {
              try {
                trigger.click();
              } catch {}
            }
          }

          function collectSectionCardsById(sectionId) {
            const section = document.querySelector(`#${sectionId}`);
            if (!section) return [];
            expandSectionIfCollapsed(section);

            return Array.from(section.querySelectorAll("a[href]"))
              .filter((a) => a && isVisible(a) && a.querySelector("img"))
              .filter((a) => {
                return !(
                  a.getAttribute("aria-disabled") === "true" ||
                  a.closest("[aria-disabled='true'], [data-disabled='true']")
                );
              });
          }

          function buildCardKey(card) {
            const href = card?.href || card?.getAttribute?.("href") || "";
            const titleEl =
              card.querySelector("p.text-body1Strong") ||
              card.querySelector("img[alt]");
            const rawTitle =
              titleEl?.textContent || titleEl?.getAttribute?.("alt") || "";
            const title = rawTitle.replace(/\s+/g, " ").trim().toLowerCase();
            return `${href}|${title}`;
          }

          const cards = (sectionIds || [])
            .map((sectionId) => collectSectionCardsById(sectionId))
            .flat();
          const card = cards.find((a) => buildCardKey(a) === keyToClick);

          if (!card) return false;

          try {
            card.scrollIntoView({ behavior: "smooth", block: "center" });
          } catch {}

          const clickTarget = card.querySelector("img") || card;
          for (const type of ["mouseover", "mousedown", "mouseup"]) {
            try {
              clickTarget.dispatchEvent(
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

  for (const url of rewardUrls) {
    console.log(`[Rewards] Processing ${url}`);
    const tabsBefore = await chrome.tabs.query({});
    const baselineTabIds = new Set(
      tabsBefore.map((t) => t.id).filter((id) => Number.isInteger(id)),
    );
    const tab = await chrome.tabs.create({ url, active: false });
    const spawnedTabIds = new Set();
    const onCreated = (createdTab) => {
      if (Number.isInteger(createdTab.id)) {
        spawnedTabIds.add(createdTab.id);
      }
    };
    chrome.tabs.onCreated.addListener(onCreated);

    try {
      await waitForTabComplete(tab.id);
      await new Promise((r) => setTimeout(r, 2000));

      const attemptedUrls = new Set();
      const maxCardClicks = 12;

      for (let i = 0; i < maxCardClicks; i++) {
        const rewardCards = await getRewardCards(tab.id);
        const nextCard = rewardCards.find(
          (card) => !attemptedUrls.has(card.key),
        );

        if (!nextCard) {
          console.log(`[Rewards] No more actionable cards found for ${url}`);
          break;
        }

        attemptedUrls.add(nextCard.key);
        console.log(
          `[Rewards] Clicking reward card ${i + 1}: ${nextCard.href} (${nextCard.key})`,
        );

        await clickRewardCard(tab.id, nextCard.key);

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

        await chrome.tabs.reload(tab.id);
        await waitForTabComplete(tab.id);
        await new Promise((r) => setTimeout(r, 2000));
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
        active: false,
      });
    } catch {
      const created = await chrome.tabs.create({
        url: "https://www.bing.com/",
        active: false,
      });
      tabId = created.id;
      singletonTabId = tabId;
    }
  } else {
    const created = await chrome.tabs.create({
      url: "https://www.bing.com/",
      active: false,
    });
    tabId = created.id;
    singletonTabId = tabId;
  }

  try {
    await waitForTabComplete(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: typeInBing,
      args: [query, 80],
    });
  } catch (e) {
    const url = "https://www.bing.com/search?q=" + encodeURIComponent(query);
    await chrome.tabs.update(tabId, { url, active: false });
  }
}

// ---------------- Run task ----------------
async function runTask() {
  const cfg = await getConfig();
  if (!cfg.enabled) return;

  // 1. First run rewards auto-click
  await autoClickRewards();

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

  if (runTicker) {
    clearInterval(runTicker);
    runTicker = null;
  }
  runTicker = setInterval(updateBadge, 1000);

  let cumulativeDelaySecs = 0;
  queries.forEach((q, idx) => {
    cumulativeDelaySecs += perOpenDelays[idx];
    setTimeout(async () => {
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
  setTimeout(async () => {
    if (runTicker) {
      clearInterval(runTicker);
      runTicker = null;
    }
    await chrome.storage.sync.set({
      running: false,
      runEndsAt: null,
      nextOpenAt: null,
    });
    await updateBadge();
  }, totalDelaySecs * 1000);
}

async function startRun(source = "unknown") {
  if (runPromise) {
    console.log(`[Run] Skip ${source}; a run is already in progress.`);
    return runPromise;
  }
  runPromise = (async () => {
    try {
      console.log(`[Run] Started from ${source}`);
      await runTask();
    } catch (e) {
      console.error(`[Run] Failed from ${source}:`, e);
    } finally {
      runPromise = null;
      console.log(`[Run] Finished from ${source}`);
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
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm();
  updateBadge();
});

scheduleAlarm();
updateBadge();













