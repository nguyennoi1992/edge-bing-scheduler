const els = {
  enabled: document.getElementById("enabled"),
  time: document.getElementById("time"),
  count: document.getElementById("count"),
  intervalMin: document.getElementById("intervalMin"),
  intervalMax: document.getElementById("intervalMax"),
  custom: document.getElementById("custom"),
  save: document.getElementById("save"),
  status: document.getElementById("status"),
};

const DEFAULTS = {
  enabled: true,
  time: "06:30",            
  searchesPerRun: 50,        
  intervalMin: 10,           
  intervalMax: 120,          
  customQueriesRaw: "",      
  nextRunAt: null
};

// Load saved config
async function restore() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  els.enabled.checked = cfg.enabled;
  els.time.value = cfg.time;
  els.count.value = cfg.searchesPerRun;
  els.intervalMin.value = cfg.intervalMin;
  els.intervalMax.value = cfg.intervalMax;
  els.custom.value = cfg.customQueriesRaw;
}
restore();

// Save config
els.save.addEventListener("click", async (e) => {
  e.preventDefault();
  const enabled = els.enabled.checked;
  const time = els.time.value;
  const searchesPerRun = Math.max(1, Math.min(100, parseInt(els.count.value || "50", 10)));
  const intervalMin = Math.max(0, parseInt(els.intervalMin.value || "10", 10));
  const intervalMax = Math.max(intervalMin + 1, parseInt(els.intervalMax.value || "120", 10));
  const customQueriesRaw = els.custom.value || "";

  await chrome.storage.sync.set({
    enabled, time, searchesPerRun, intervalMin, intervalMax, customQueriesRaw
  });

  await chrome.runtime.sendMessage({ type: "RESCHEDULE" });

  els.status.textContent = "Settings saved!";
  setTimeout(() => (els.status.textContent = ""), 2000);
});
