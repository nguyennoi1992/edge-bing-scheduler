async function load() {
  const { enabled, time, nextRunAt } = await chrome.storage.sync.get(["enabled", "time", "nextRunAt"]);
  document.getElementById("enabled").checked = !!enabled;
  document.getElementById("time").textContent = time || "—";
  document.getElementById("next").textContent = nextRunAt ? new Date(nextRunAt).toLocaleString() : "—";
}

// Keep UI in sync if settings change elsewhere
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.time) {
    document.getElementById("time").textContent = changes.time.newValue || "—";
  }
  if (changes.nextRunAt) {
    const v = changes.nextRunAt.newValue;
    document.getElementById("next").textContent = v ? new Date(v).toLocaleString() : "—";
  }
  if (changes.enabled) {
    document.getElementById("enabled").checked = !!changes.enabled.newValue;
  }
});

document.getElementById("enabled").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ enabled: e.target.checked });
  // Ensure alarms reflect the new state
  await chrome.runtime.sendMessage({ type: "RESCHEDULE" });
});

document.getElementById("runNow").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RUN_NOW" });
});

document.getElementById("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
