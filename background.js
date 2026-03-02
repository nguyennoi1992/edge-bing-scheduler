// Use as an ES module for MV3 service worker
import { buildQueries } from "./words.js";

const ALARM_NAME = "bingScheduler";
const BADGE_ALARM = "badgeTick";
const REWARDS_SETTLE_MS = 8000;

const DEFAULTS = {
  enabled: true,
  time: "06:30", // 24h HH:MM
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
  const [hour, minute] = (timeHHMM || "06:30").split(":").map(Number);
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

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
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

            function collectSectionCardsById(
              sectionId,
              { skipCompleted = true } = {},
            ) {
              const section = document.querySelector(`#${sectionId}`);
              if (!section) return [];
              expandSectionIfCollapsed(section);

              const anchors = Array.from(section.querySelectorAll("a[href]"));
              const unique = [];
              const seen = new Set();

              for (const a of anchors) {
                if (!a || !isVisible(a)) continue;
                if (!a.querySelector("img")) continue;

                const href = a.getAttribute("href") || "";
                if (!href || href === "/earn") continue;

                const text = (a.innerText || a.textContent || "").toLowerCase();
                if (text.includes("see more tasks")) continue;
                if (skipCompleted && /\bcompleted\b/.test(text)) continue;

                const key = `${href}|${text.replace(/\s+/g, " ").trim()}`;
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(a);
              }

              return unique;
            }

            function clickCardsSequentially(cards, delayMs = 3000) {
              let idx = 0;
              function clickNext() {
                if (idx >= cards.length) {
                  console.log("✅ Rewards section processed.");
                  resolve("done");
                  return;
                }
                const card = cards[idx];
                try {
                  card.scrollIntoView({ behavior: "smooth", block: "center" });
                } catch {}
                console.log("👉 Clicking card", idx + 1, "from target section");
                card.click();
                idx++;
                setTimeout(clickNext, delayMs);
              }
              clickNext();
            }

            function collectCardsForCurrentPage() {
              const path = (location.pathname || "").toLowerCase();
              if (path.startsWith("/earn")) {
                const cards = collectSectionCardsById("moreactivities", {
                  skipCompleted: true,
                });
                console.log(
                  `[Rewards] /earn => Keep earning cards: ${cards.length}`,
                );
                return cards;
              }
              if (path.startsWith("/dashboard")) {
                const cards = collectSectionCardsById("dailyset", {
                  skipCompleted: true,
                });
                console.log(
                  `[Rewards] /dashboard => Daily set cards: ${cards.length}`,
                );
                return cards;
              }
              return [];
            }

            let attempts = 0;
            const maxAttempts = 8;
            const pollMs = 1000;

            const timer = setInterval(() => {
              attempts++;
              const cards = collectCardsForCurrentPage();
              if (cards.length || attempts >= maxAttempts) {
                clearInterval(timer);
                clickCardsSequentially(cards, 3000);
              }
            }, pollMs);
          });
        },
      });

      console.log(`[Rewards] Auto-click result for ${url}:`, result);
      await new Promise((r) => setTimeout(r, REWARDS_SETTLE_MS));
      console.log(
        `[Rewards] Waited ${REWARDS_SETTLE_MS}ms before closing tabs for ${url}`,
      );
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

  queries.forEach((q, idx) => {
    setTimeout(
      async () => {
        openBingAndType(q);

        if (idx + 1 < perOpenDelays.length) {
          accumulatedSecs += perOpenDelays[idx + 1];
          const nextOpenAt = start + accumulatedSecs * 1000;
          await chrome.storage.sync.set({ nextOpenAt });
        } else {
          await chrome.storage.sync.set({ nextOpenAt: null });
        }

        await updateBadge();
      },
      perOpenDelays.slice(0, idx + 1).reduce((a, b) => a + b, 0) * 1000,
    );
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runTask();
    scheduleAlarm();
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "RESCHEDULE") {
    scheduleAlarm();
  }
  if (msg.type === "RUN_NOW") {
    runTask();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm();
  updateBadge();
});

scheduleAlarm();
updateBadge();
