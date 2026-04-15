const DEBUG_LOGS_KEY = "debugLogs";

function formatDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const HH = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${dd}/${MM}/${yyyy} ${HH}:${mm}:${ss}`;
}

function formatDayKey(ts) {
  if (!ts) return "Unknown date";
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${MM}/${yyyy}`;
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

function groupLogsByDay(logs) {
  const groups = new Map();
  for (const entry of [...logs].reverse()) {
    const key = formatDayKey(entry.ts);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()];
}

function renderLogs(logs) {
  const logList = document.getElementById("logList");
  logList.innerHTML = "";
  if (!Array.isArray(logs) || !logs.length) {
    logList.innerHTML = '<div class="empty">No logs yet</div>';
    return;
  }

  const groups = groupLogsByDay(logs);
  groups.forEach(([day, entries]) => {
    const groupEl = document.createElement("div");
    groupEl.className = "log-group";

    const header = document.createElement("div");
    header.className = "log-group-date";
    header.innerHTML = `<span class="log-group-arrow">▼</span> ${day} <span class="log-group-count">(${entries.length})</span>`;

    const body = document.createElement("div");
    body.className = "log-group-body";

    entries.forEach((entry) => {
      const level = entry.level || "info";
      const item = document.createElement("div");
      item.className = `log-item ${level}`;
      item.innerHTML = `<div class="log-line">${toLogLine(entry)}</div>`;
      body.appendChild(item);
    });

    header.addEventListener("click", () => {
      const collapsed = body.classList.toggle("collapsed");
      header.querySelector(".log-group-arrow").textContent = collapsed ? "▶" : "▼";
    });

    groupEl.appendChild(header);
    groupEl.appendChild(body);
    logList.appendChild(groupEl);
  });
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
    `Exported: ${formatDate(Date.now())}`,
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
  document.getElementById("next").textContent = nextRunAt ? formatDate(nextRunAt) : "—";
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
      document.getElementById("next").textContent = v ? formatDate(v) : "—";
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
