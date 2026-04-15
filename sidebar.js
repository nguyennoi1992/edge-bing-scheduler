const DEBUG_LOGS_KEY = "debugLogs";

function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function formatMeta(meta) {
  if (!meta || typeof meta !== "object") return "";
  const parts = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.join(" | ");
}

function toLogLine(entry) {
  const phase = (entry.phase || "general").toUpperCase();
  const message = entry.message || "";
  const metaText = formatMeta(entry.meta);
  return `${formatDate(entry.ts)} | ${phase} | ${message}${metaText ? ` | ${metaText}` : ""}`;
}

function renderLogs(logs) {
  const logList = document.getElementById("logList");
  if (!Array.isArray(logs) || !logs.length) {
    logList.innerHTML = '<div class="empty">No logs yet</div>';
    return;
  }

  const items = [...logs].reverse().map((entry) => {
    const level = entry.level || "info";
    return `<div class="log-item ${level}"><div class="log-line">${toLogLine(entry)}</div></div>`;
  });

  logList.innerHTML = items.join("");
}

async function getLogs() {
  const data = await chrome.storage.local.get(DEBUG_LOGS_KEY);
  return data[DEBUG_LOGS_KEY] || [];
}

async function loadLogs() {
  const logs = await getLogs();
  renderLogs(logs);
}

async function exportLogs() {
  const logs = await getLogs();
  const lines = [
    `Bing Scheduler Debug Logs`,
    `Exported: ${new Date().toLocaleString()}`,
    `Retention: last 7 days`,
    `Count: ${logs.length}`,
    "",
    ...logs.map((entry) => toLogLine(entry)),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `bing-scheduler-logs-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function openSidebar() {
  if (!chrome.sidePanel) return;
  const currentWindow = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: currentWindow.id });
}

async function load() {
  const { enabled, time, nextRunAt } = await chrome.storage.sync.get(["enabled", "time", "nextRunAt"]);
  document.getElementById("enabled").checked = !!enabled;
  document.getElementById("time").textContent = time || "—";
  document.getElementById("next").textContent = nextRunAt ? new Date(nextRunAt).toLocaleString() : "—";
  await loadLogs();

  const openSidebarButton = document.getElementById("openSidebar");
  if (openSidebarButton) {
    if (!chrome.sidePanel) {
      openSidebarButton.style.display = "none";
    } else {
      openSidebarButton.addEventListener("click", () => {
        openSidebar().catch((e) => console.warn("[UI] Failed to open side panel:", e));
      });
    }
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
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
  }

  if (area === "local" && changes[DEBUG_LOGS_KEY]) {
    renderLogs(changes[DEBUG_LOGS_KEY].newValue || []);
  }
});

document.getElementById("enabled").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ enabled: e.target.checked });
  await chrome.runtime.sendMessage({ type: "RESCHEDULE" });
});

document.getElementById("runNow").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RUN_NOW" });
});

document.getElementById("refreshLogs").addEventListener("click", () => {
  loadLogs();
});

document.getElementById("exportLogs").addEventListener("click", () => {
  exportLogs().catch((e) => console.warn("[UI] Failed to export logs:", e));
});

document.getElementById("clearLogs").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_DEBUG_LOGS" });
  await loadLogs();
});

document.getElementById("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
