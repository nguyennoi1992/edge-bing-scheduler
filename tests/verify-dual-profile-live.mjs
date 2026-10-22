import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

async function cdp(ws, id, method, params = {}) {
  return new Promise((resolve) => {
    const handler = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === id) {
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function findExtensionId(preferencesPath, repoDir) {
  try {
    const data = JSON.parse(fs.readFileSync(preferencesPath, "utf-8"));
    const settings = data?.extensions?.settings || {};
    const resolvedRepo = path.resolve(repoDir);
    for (const [id, config] of Object.entries(settings)) {
      if (config?.path && path.resolve(config.path) === resolvedRepo) {
        return id;
      }
    }
  } catch {}
  return "nfhfoeifnelcgcalhnbidjdmgohcfbon";
}

async function verifyProfile({ name, userDir, profileDir, port }) {
  console.log(`\n=== Testing Profile: ${name} (port ${port}) ===`);
  const chromeProc = spawn("google-chrome", [
    `--user-data-dir=${userDir}`,
    `--profile-directory=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "about:blank"
  ], { stdio: "ignore" });

  try {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }

    const extId = findExtensionId(path.join(userDir, profileDir, "Preferences"), "/u01/tools/edge-bing-scheduler");
    console.log(`[${name}] Extension ID: ${extId}`);

    // Wake up extension if needed
    try {
      await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/popup.html`, { method: "PUT" });
      await new Promise(r => setTimeout(r, 1500));
    } catch {}

    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pageTarget = list.find(t => t.type === "page" && !t.url.includes("chrome-extension://")) || list.find(t => t.type === "page");
    if (!pageTarget) {
      throw new Error(`[${name}] No page target found`);
    }

    const ws = new globalThis.WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    await cdp(ws, 1, "Page.enable");
    await cdp(ws, 2, "Runtime.enable");

    // 1. Verify panelflyout server state
    console.log(`[${name}] Navigating to https://www.bing.com/rewards/panelflyout...`);
    await cdp(ws, 3, "Page.navigate", { url: "https://www.bing.com/rewards/panelflyout" });
    await new Promise(r => setTimeout(r, 5000));

    const flyoutCheck = await cdp(ws, 4, "Runtime.evaluate", {
      expression: `(() => {
        const vm = window.flyoutViewModel;
        const res = vm?.flyoutResult;
        const today = new Date();
        const todayKey = (today.getMonth() + 1) + "/" + today.getDate() + "/" + today.getFullYear();
        const dsp = res?.dailySetPromotions?.[todayKey] || Object.values(res?.dailySetPromotions || {})[0] || [];
        const streak = res?.streakPromotion?.activityProgress || Number(res?.streakPromotion?.attributes?.activity_progress || 0);
        return {
          userId: vm?.userId || res?.userStatus?.memberId || "",
          availablePoints: res?.userStatus?.availablePoints || 0,
          streakDays: streak,
          dailySetCards: dsp.map(c => ({
            name: c.name,
            complete: Boolean(c.complete),
            pointProgress: c.pointProgress,
            pointProgressMax: c.pointProgressMax
          }))
        };
      })()`,
      returnByValue: true
    });
    const flyoutData = flyoutCheck.result?.result?.value;
    console.log(`[${name}] Panelflyout Data:`, JSON.stringify(flyoutData, null, 2));

    // 2. Verify dashboard page
    console.log(`[${name}] Navigating to https://rewards.bing.com/dashboard...`);
    await cdp(ws, 5, "Page.navigate", { url: "https://rewards.bing.com/dashboard" });
    await new Promise(r => setTimeout(r, 6000));

    const dashboardCheck = await cdp(ws, 6, "Runtime.evaluate", {
      expression: `(() => {
        const nativeDailySet = document.getElementById("dailyset");
        const extDailySet = document.getElementById("ext-restored-dailyset");
        const activeDailySet = nativeDailySet || extDailySet;
        const cardEls = activeDailySet ? Array.from(activeDailySet.querySelectorAll("a[href], [data-reward-card-name]")) : [];
        return {
          hasNativeDailySet: Boolean(nativeDailySet),
          hasExtDailySet: Boolean(extDailySet),
          cardCount: cardEls.length,
          cards: cardEls.map(c => ({
            name: c.getAttribute("data-reward-card-name") || c.getAttribute("data-offer-id") || "",
            isCompleted: c.getAttribute("data-ext-completed") === "true" || Boolean(c.querySelector("svg.mee-icon-CheckMark, [class*='CheckMark'], svg.size-2")),
            text: (c.innerText || "").replace(/\\s+/g, " ").trim()
          }))
        };
      })()`,
      returnByValue: true
    });
    const dashData = dashboardCheck.result?.result?.value;
    console.log(`[${name}] Dashboard Daily Set:`, JSON.stringify(dashData, null, 2));

    ws.close();
    return { name, flyoutData, dashData };
  } finally {
    chromeProc.kill("SIGKILL");
  }
}

async function main() {
  console.log("Starting Dual Profile Live Verification on Virtual Display...");
  const p1 = await verifyProfile({
    name: "Profile 1",
    userDir: "/tmp/chrome-test-p1",
    profileDir: "Profile 1",
    port: 9444,
  });

  const pDef = await verifyProfile({
    name: "Default Profile",
    userDir: "/tmp/chrome-test-default",
    profileDir: "Default",
    port: 9445,
  });

  console.log("\n=================== VERIFICATION SUMMARY ===================");
  console.log(`Profile 1 (vsstreak flight):`);
  console.log(`  - Panelflyout Cards Complete: ${p1.flyoutData?.dailySetCards?.every(c => c.complete) ? "ALL COMPLETE (3/3)" : "SOME INCOMPLETE"}`);
  console.log(`  - Points: ${p1.flyoutData?.availablePoints}, Streak: ${p1.flyoutData?.streakDays} days`);
  console.log(`  - Dashboard Daily Set: ${p1.dashData?.hasExtDailySet ? "Rendered via #ext-restored-dailyset" : "Not Rendered"}`);

  console.log(`Default Profile (Native React):`);
  console.log(`  - Panelflyout Cards Complete: ${pDef.flyoutData?.dailySetCards?.every(c => c.complete) ? "ALL COMPLETE (3/3)" : "SOME INCOMPLETE"}`);
  console.log(`  - Points: ${pDef.flyoutData?.availablePoints}, Streak: ${pDef.flyoutData?.streakDays} days`);
  console.log(`  - Dashboard Daily Set: ${pDef.dashData?.hasNativeDailySet ? "Rendered natively via #dailyset" : "Not Rendered"}`);
  console.log("============================================================\n");
}

main().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
