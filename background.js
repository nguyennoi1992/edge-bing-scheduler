// Use as an ES module for MV3 service worker
import { buildQueries } from "./words.js";

const ALARM_NAME = "bingScheduler";
const BADGE_ALARM = "badgeTick";

const DEFAULTS = {
    enabled: true,
    time: "06:30",            // 24h HH:MM
    searchesPerRun: 50,       // how many queries to open per run
    intervalMin: 10,          // min seconds between tabs
    intervalMax: 120,         // max seconds between tabs
    customQueriesRaw: "",     // newline or comma separated list
    nextRunAt: null
};

async function getConfig() {
    const data = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...data };
}

let runTicker = null;
let singletonTabId = null;

// ---------------- Badge helpers ----------------
async function updateBadge() {
    const { enabled, nextRunAt, running, runEndsAt, nextOpenAt } = await chrome.storage.sync.get([
        "enabled", "nextRunAt", "running", "runEndsAt", "nextOpenAt"
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
        .map(s => s.trim())
        .filter(Boolean);
    return buildQueries({ count: cfg.searchesPerRun, customList });
}

// ---------------- Bing Rewards auto click ----------------
async function autoClickRewards() {
    console.log("⚡ Auto-clicking Bing Rewards cards...");
    const tab = await chrome.tabs.create({ url: "https://rewards.bing.com/earn", active: false });

    await waitForTabComplete(tab.id);

    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
            return new Promise((resolve) => {
                const isVisible = (el) => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
                };

                function dedupeAndFilter(elements) {
                    const unique = [];
                    const seen = new Set();
                    for (const el of elements) {
                        if (!el || !isVisible(el)) continue;
                        const href = el.getAttribute("href") || "";
                        const labelText = [
                            el.getAttribute("aria-label"),
                            el.getAttribute("title"),
                            el.textContent
                        ].filter(Boolean).join(" ").toLowerCase();

                        // Avoid non-task controls.
                        if (href.includes("/earn")) continue;
                        if (labelText.includes("see more tasks")) continue;
                        if (labelText.includes("streak protection")) continue;

                        const role = (el.getAttribute("role") || "").toLowerCase();
                        if (role === "switch") continue;
                        if (el.matches("input[type='checkbox'], input[type='radio']")) continue;

                        const key = el.tagName + "|" + href + "|" + (el.textContent || "").trim();
                        if (!seen.has(key)) {
                            seen.add(key);
                            unique.push(el);
                        }
                    }
                    return unique;
                }

                function collectSectionCardsById(sectionId) {
                    const section = document.querySelector(`#${sectionId}`);
                    if (!section) return [];

                    const cards = Array.from(section.querySelectorAll("a[href]")).filter((a) => {
                        const href = a.getAttribute("href") || "";
                        const looksLikeTask =
                            href.includes("bing.com/search") ||
                            href.includes("bing.com/spotlight") ||
                            href.includes("rnoreward=1") ||
                            href.includes("quizform=dsetqu") ||
                            href.includes("PROGRAMNAME=");

                        // Keep earning / Daily set cards are image tile anchors.
                        const hasCardImage = !!a.querySelector("img");
                        return looksLikeTask && hasCardImage;
                    });

                    return dedupeAndFilter(cards);
                }

                function collectCardsUnderHeading(headingText) {
                    const norm = (s) => (s || "").trim().toLowerCase();
                    const target = norm(headingText);
                    const heading = Array.from(document.querySelectorAll("h1, h2, h3, h4"))
                        .find((h) => norm(h.textContent) === target);
                    if (!heading) return [];

                    let section = heading.closest("section, mee-card-group, mee-daily-set, div, main, body");
                    let scopeRoot = section || heading.parentElement || document;

                    let scopedCards = Array.from(scopeRoot.querySelectorAll(
                        "a[href], card-content a, card-content button, mee-card a, mee-card button, a.c-card, div[role='button'], a[role='button']"
                    ));

                    if (scopedCards.length > 50 || scopeRoot === document || scopeRoot === document.body) {
                        const groupNodes = [];
                        let n = heading.nextElementSibling;
                        while (n && !/^h[1-4]$/i.test(n.tagName || "")) {
                            groupNodes.push(n);
                            n = n.nextElementSibling;
                        }
                        scopedCards = groupNodes.flatMap((node) =>
                            Array.from(node.querySelectorAll(
                                "a[href], card-content a, card-content button, mee-card a, mee-card button, a.c-card, div[role='button'], a[role='button']"
                            ))
                        );
                    }

                    return dedupeAndFilter(scopedCards);
                }

                function clickGroupsSequentially(groups, delayMs = 3000) {
                    const flat = [];
                    const moreCards = collectSectionCardsById("moreactivities");
                    if (moreCards.length) {
                        console.log(`[Rewards] Collected ${moreCards.length} cards under "Keep earning"`);
                        flat.push(...moreCards);
                    }
                    const dailyCards = collectSectionCardsById("dailyset");
                    if (dailyCards.length) {
                        console.log(`[Rewards] Collected ${dailyCards.length} cards under "Daily set"`);
                        flat.push(...dailyCards);
                    }
                    for (const g of groups) {
                        if ((g || "").toLowerCase() === "daily set") continue;
                        if ((g || "").toLowerCase() === "more activities") continue;
                        if ((g || "").toLowerCase() === "keep earning") continue;
                        const cards = collectCardsUnderHeading(g);
                        console.log(`[Rewards] Collected ${cards.length} cards under "${g}"`);
                        flat.push(...cards);
                    }
                    let idx = 0;
                    function clickNext() {
                        if (idx >= flat.length) {
                            console.log("✅ Rewards groups processed.");
                            resolve("done");
                            return;
                        }
                        const card = flat[idx];
                        try { card.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
                        console.log("👉 Clicking card", idx + 1, "from grouped list");
                        card.click();
                        idx++;
                        setTimeout(clickNext, delayMs);
                    }
                    clickNext();
                }

                setTimeout(() => {
                    clickGroupsSequentially(["Keep earning", "Daily set", "More activities"], 3000);
                }, 2000);
            });
        }
    });

    console.log("Rewards auto-click result:", result);
}

// ---------------- Bing search logic ----------------
async function typeInBing(query, perCharDelayMs = 80) {
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
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
    const evOpts = (type) => ({ key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true });
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
            await chrome.tabs.update(tabId, { url: "https://www.bing.com/", active: false });
        } catch {
            const created = await chrome.tabs.create({ url: "https://www.bing.com/", active: false });
            tabId = created.id;
            singletonTabId = tabId;
        }
    } else {
        const created = await chrome.tabs.create({ url: "https://www.bing.com/", active: false });
        tabId = created.id;
        singletonTabId = tabId;
    }

    try {
        await waitForTabComplete(tabId);
        await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: typeInBing,
            args: [query, 80]
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
    const perOpenDelays = queries.map(() => randomDelay(cfg.intervalMin, cfg.intervalMax));

    const start = Date.now();
    let accumulatedSecs = 0;
    accumulatedSecs += perOpenDelays[0] || 0;
    const firstNextOpenAt = start + accumulatedSecs * 1000;
    await chrome.storage.sync.set({ running: true, runEndsAt: null, nextOpenAt: firstNextOpenAt });
    await updateBadge();

    if (runTicker) {
        clearInterval(runTicker);
        runTicker = null;
    }
    runTicker = setInterval(updateBadge, 1000);

    queries.forEach((q, idx) => {
        setTimeout(async () => {
            openBingAndType(q);

            if (idx + 1 < perOpenDelays.length) {
                accumulatedSecs += perOpenDelays[idx + 1];
                const nextOpenAt = start + accumulatedSecs * 1000;
                await chrome.storage.sync.set({ nextOpenAt });
            } else {
                await chrome.storage.sync.set({ nextOpenAt: null });
            }

            await updateBadge();
        }, (perOpenDelays.slice(0, idx + 1).reduce((a, b) => a + b, 0)) * 1000);
    });

    const totalDelaySecs = perOpenDelays.reduce((a, b) => a + b, 0);
    setTimeout(async () => {
        if (runTicker) {
            clearInterval(runTicker);
            runTicker = null;
        }
        await chrome.storage.sync.set({ running: false, runEndsAt: null, nextOpenAt: null });
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
    const relevant = ["enabled", "time", "searchesPerRun", "intervalMin", "intervalMax", "customQueriesRaw"];
    if (relevant.some((k) => k in changes)) {
        scheduleAlarm();
    }
    if ("nextRunAt" in changes || "running" in changes || "nextOpenAt" in changes) {
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
