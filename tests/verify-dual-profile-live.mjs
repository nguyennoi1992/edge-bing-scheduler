import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIM_MATCH_RE, READY_TO_CLAIM_LABEL_RE } from "../reward-dom-helpers.js";

const repoDir = fileURLToPath(new URL("../", import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = text => createHash("sha256").update(text).digest("hex");
let commandId = 0;

async function waitFor(read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (result) return result;
    } catch { /* Navigation and extension reload replace execution contexts. */ }
    await delay(200);
  }
  throw new Error("Timed out waiting for browser state");
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("CDP connection timed out")); }, 10_000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
  });
  return ws;
}

async function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++commandId;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    const onClose = () => { cleanup(); reject(new Error(`CDP disconnected during ${method}`)); };
    const onMessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(`CDP command failed: ${method}`));
      else resolve(message.result);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP command timed out: ${method}`)); }, 25_000);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (error) { cleanup(); reject(error); }
  });
}

async function evaluate(ws, func, args = []) {
  const result = await cdp(ws, "Runtime.evaluate", {
    expression: `(${func})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(`Page evaluation failed (${result.exceptionDetails.exception?.className || "exception"})`);
  return result.result?.value;
}

function cloneProfile(profileDir, destination) {
  const source = path.join(os.homedir(), ".config/google-chrome");
  const preferences = JSON.parse(fs.readFileSync(path.join(source, profileDir, "Preferences"), "utf8"));
  const settings = preferences.extensions?.settings || {};
  const extensionId = Object.entries(settings).find(([, config]) => config.path && path.resolve(config.path) === path.resolve(repoDir))?.[0];
  if (!extensionId) throw new Error(`Project extension is not installed in ${profileDir}`);
  const profile = path.join(destination, profileDir);
  fs.mkdirSync(profile, { mode: 0o700 });
  fs.copyFileSync(path.join(source, "Local State"), path.join(destination, "Local State"));
  for (const name of ["Secure Preferences", "Network Persistent State"]) {
    const file = path.join(source, profileDir, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(profile, name));
  }
  preferences.session = { ...preferences.session, restore_on_startup: 5, startup_urls: [] };
  preferences.profile = { ...preferences.profile, exit_type: "Normal" };
  preferences.extensions.settings = { [extensionId]: settings[extensionId] };
  fs.writeFileSync(path.join(profile, "Preferences"), JSON.stringify(preferences));
  const cookies = ["Cookies", "Network/Cookies"].find(name => fs.existsSync(path.join(source, profileDir, name)));
  if (!cookies) throw new Error(`Cookie database is missing in ${profileDir}`);
  const output = path.join(profile, cookies);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync("python3", ["-c", "import pathlib,sqlite3,sys\nwith sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True) as src, sqlite3.connect(sys.argv[2]) as dst:\n src.backup(dst)", path.join(source, profileDir, cookies), output], { stdio: "pipe" });
  return extensionId;
}

export function readFlyout(today = new Date()) {
  // Fail-closed to requested local day: Bing Rewards day boundary differs by region; falling back to yesterday or future days causes false-positive completions across timezones.
  const model = window.flyoutViewModel;
  const result = model?.flyoutResult;
  const promotions = result?.dailySetPromotions || {};
  const todayKey = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
  const cards = promotions[todayKey];
  return {
    authenticated: Boolean(model?.userId || result?.userStatus?.memberId),
    todayKey,
    requestedDay: todayKey,
    availableDateKeys: Object.keys(promotions),
    todayPresent: Array.isArray(cards),
    availablePoints: result?.userStatus?.availablePoints ?? null,
    streakDays: result?.streakPromotion?.activityProgress ?? null,
    cards: (Array.isArray(cards) ? cards : []).map(card => ({
      name: card.name,
      complete: card.complete,
      points: card.pointProgress,
      max: card.pointProgressMax,
    })),
  };
}

export function readDashboard(readySource, claimSource) {
  const native = document.getElementById("dailyset");
  const restored = document.getElementById("ext-restored-dailyset");
  const section = native || restored;
  let cardCount = 0;
  if (section) {
    const isActivityCard = (card) => {
      if (!card || card === section) return false;
      if (typeof window.isRewardSectionChrome === "function" && window.isRewardSectionChrome(card, section)) return false;
      if (card.matches?.("h1, h2, h3, h4, header, [role='heading'], [slot='trigger'], [aria-expanded][aria-controls]") ||
          card.closest?.("h1, h2, h3, h4, header, [role='heading']")) return false;
      const ariaLabel = (card.getAttribute?.("aria-label") || "").toLowerCase();
      if (/about|info|help|how it works|daily set$/i.test(ariaLabel)) return false;
      const text = (card.innerText || card.textContent || "").trim();
      if (!text || /^(?:info|help|\?|i)$/i.test(text)) return false;
      const href = card.getAttribute?.("href") || card.querySelector?.("a[href]")?.getAttribute?.("href") || "";
      const isPressable = card.matches?.("button, [role='button'], [role='link'], [data-react-aria-pressable='true']") ||
        Boolean(card.querySelector?.("[data-react-aria-pressable='true'], button, [role='button'], [role='link']"));
      if (!href && !isPressable) return false;
      return true;
    };
    if (typeof window.findRewardCardRoots === "function") {
      cardCount = window.findRewardCardRoots(section).filter(isActivityCard).length;
    } else {
      cardCount = Array.from(section.querySelectorAll("a[href], button, [role='button'], [data-react-aria-pressable='true']"))
        .filter(isActivityCard).length;
    }
  }
  const readyPattern = readySource ? new RegExp(readySource, "i") : null;
  return {
    native: Boolean(native), restored: Boolean(restored), cardCount,
    helpersCurrent: window.__rewardDomHelpersInjected === true && window.READY_TO_CLAIM_LABEL_RE?.source === readySource && window.CLAIM_MATCH_RE?.source === claimSource,
    readyCards: readyPattern
      ? Array.from(document.querySelectorAll("button, [role='button']"))
          .map(button => (button.innerText || "").replace(/\s+/g, " ").trim())
          .filter(text => readyPattern.test(text))
      : [],
  };
}

export function assessProfile({ reload, flyout, dashboard }) {
  if (!reload?.verified || !reload.sourceVerified) return { status: "unavailable", reason: "extension_reload_unverified" };
  if (flyout?.authenticated !== true) return { status: "unavailable", reason: "not_authenticated" };
  const cards = flyout.cards;
  if (!flyout.todayPresent || !Array.isArray(cards) || cards.length === 0) return { status: "unavailable", reason: "today_cards_missing" };
  if (cards.some(card => !card.name || typeof card.complete !== "boolean") || new Set(cards.map(card => card.name)).size !== cards.length) return { status: "unavailable", reason: "invalid_card_data" };
  if (!dashboard?.helpersCurrent || !(dashboard.native || dashboard.restored) || dashboard.cardCount !== cards.length) return { status: "unavailable", reason: "dashboard_unverified" };
  const completed = cards.filter(card => card.complete === true).length;
  return { status: completed === cards.length ? "complete" : "incomplete", completed, total: cards.length };
}

async function verifyProfile(profileDir) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-bing-live-"));
  let browserProcess, browserClosed, browserWs, popupWs, pageWs;
  try {
    const extensionId = cloneProfile(profileDir, userDir);
    const log = fs.openSync(path.join(userDir, "chrome.log"), "w", 0o600);
    browserProcess = spawn("google-chrome", [
      `--user-data-dir=${userDir}`, `--profile-directory=${profileDir}`, "--remote-debugging-port=0",
      "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-sync",
      "--disable-background-networking", "--disable-session-crashed-bubble", "about:blank",
    ], { stdio: ["ignore", log, log], detached: true });
    let launchError;
    browserProcess.once("error", error => { launchError = error; });
    browserClosed = new Promise(resolve => browserProcess.once("close", resolve));
    try { fs.closeSync(log); } catch {}
    const port = await waitFor(() => {
      if (launchError) throw launchError;
      const portFile = path.join(userDir, "DevToolsActivePort");
      return fs.existsSync(portFile) && Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
    });
    const base = `http://127.0.0.1:${port}`;
    const get = async (route, options = {}) => {
      const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("CDP HTTP request failed");
      return response.json();
    };
    const targets = () => get("/json/list");
    const open = url => get(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    browserWs = await connect((await get("/json/version")).webSocketDebuggerUrl);
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const workerUrl = `chrome-extension://${extensionId}/background.js`;
    const openPopup = async () => {
      const ws = await connect((await open(popupUrl)).webSocketDebuggerUrl);
      await cdp(ws, "Runtime.enable");
      await waitFor(() => evaluate(ws, () => typeof chrome === "object" && Boolean(chrome.storage?.sync)));
      return ws;
    };
    popupWs = await openPopup();
    const before = await waitFor(async () => (await targets()).find(target => target.type === "service_worker" && target.url === workerUrl));
    // Sync is disabled and the original profile is never opened or edited.
    await evaluate(popupWs, () => chrome.storage.sync.set({ enabled: false }));
    await evaluate(popupWs, () => { setTimeout(() => chrome.runtime.reload(), 100); return true; });
    popupWs.close();
    popupWs = null;
    await waitFor(async () => !(await targets()).some(target => target.id === before.id));
    popupWs = await openPopup();
    const after = await waitFor(async () => (await targets()).find(target => target.type === "service_worker" && target.url === workerUrl && target.id !== before.id));
    const sourceHashes = {};
    for (const name of ["background.js", "reward-dom-helpers.js"]) {
      const text = await evaluate(popupWs, async file => {
        const response = await fetch(chrome.runtime.getURL(file));
        if (!response.ok) throw new Error("Extension source unavailable");
        return response.text();
      }, [name]);
      sourceHashes[name] = sha256(text);
      const expected = sha256(fs.readFileSync(path.join(repoDir, name)));
      if (sourceHashes[name] !== expected) throw new Error(`Extension source differs from project: ${name}`);
    }
    const reload = { verified: before.id !== after.id, before: before.id, after: after.id, sourceVerified: true, sourceHashes };
    const tab = await open("https://www.bing.com/rewards/panelflyout");
    pageWs = await connect(tab.webSocketDebuggerUrl);
    await waitFor(() => evaluate(pageWs, () => Boolean(window.flyoutViewModel?.flyoutResult))).catch(() => {});
    const flyout = await evaluate(pageWs, readFlyout);
    await cdp(pageWs, "Page.navigate", { url: "https://rewards.bing.com/dashboard" });
    const args = [READY_TO_CLAIM_LABEL_RE.source, CLAIM_MATCH_RE.source];
    await waitFor(async () => {
      const d = await evaluate(pageWs, readDashboard, args);
      return d.helpersCurrent && (d.native || d.restored);
    }, 25_000).catch(() => {});
    const dashboard = await evaluate(pageWs, readDashboard, args);
    const observation = { profile: profileDir, observedAt: new Date().toISOString(), extensionPath: path.resolve(repoDir), reload, flyout, dashboard };
    return { ...observation, assessment: assessProfile(observation) };
  } finally {
    popupWs?.close();
    pageWs?.close();
    if (browserWs) {
      await cdp(browserWs, "Browser.close").catch(() => {});
      browserWs.close();
    }
    if (browserProcess?.pid && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      await Promise.race([browserClosed, delay(5000)]);
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) break;
        try { process.kill(-browserProcess.pid, signal); } catch {}
        await Promise.race([browserClosed, delay(1000)]);
      }
      if (browserProcess.exitCode === null && browserProcess.signalCode === null) throw new Error(`Test browser still alive; private clone retained: ${userDir}`);
    }
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

async function main() {
  const display = process.env.DISPLAY?.match(/^:(\d+)(?:\.\d+)?$/)?.[1];
  let pid, comm;
  try {
    pid = display && fs.readFileSync(`/tmp/.X${display}-lock`, "utf8").trim();
    comm = pid && fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {}
  if (!comm || comm !== "Xvfb") throw new Error("Run this test through the documented virtual-display wrapper");
  for (const profile of ["Default", "Profile 1"]) {
    try {
      const result = await verifyProfile(profile);
      console.log(JSON.stringify(result));
      if (result.assessment.status !== "complete") process.exitCode = 1;
    } catch (error) {
      console.error(JSON.stringify({ profile, assessment: { status: "unavailable", reason: error.message } }));
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
