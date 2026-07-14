const els = {
  enabled: document.getElementById("enabled"),
  time: document.getElementById("time"),
  profileSlot: document.getElementById("profileSlot"),
  schedulePreview: document.getElementById("schedulePreview"),
  count: document.getElementById("count"),
  intervalMin: document.getElementById("intervalMin"),
  intervalMax: document.getElementById("intervalMax"),
  custom: document.getElementById("custom"),
  save: document.getElementById("save"),
  status: document.getElementById("status"),
};

const DEFAULTS = {
  enabled: true,
  time: "01:00",
  searchesPerRun: 50,        
  intervalMin: 10,           
  intervalMax: 120,          
  customQueriesRaw: "",      
  nextRunAt: null
};

const PROFILE_SLOT_MAX = 100;
const SLOT_SPACING_MINUTES = 10;

function normalizeProfileSlot(value) {
  const slot = Number.parseInt(value, 10);
  if (!Number.isFinite(slot) || slot < 1 || slot > PROFILE_SLOT_MAX) return 0;
  return slot;
}

function updateSchedulePreview() {
  const time = els.time.value || DEFAULTS.time;
  const [hour, minute] = time.split(":").map(Number);
  const slot = normalizeProfileSlot(els.profileSlot.value);
  const offsetMinutes = slot > 0 ? (slot - 1) * SLOT_SPACING_MINUTES : 0;
  const totalMinutes = (hour || 0) * 60 + (minute || 0) + offsetMinutes;
  const previewHour = String(Math.floor(totalMinutes / 60) % 24).padStart(2, "0");
  const previewMinute = String(totalMinutes % 60).padStart(2, "0");
  const daySuffix = totalMinutes >= 24 * 60 ? " next day" : "";
  els.schedulePreview.textContent = slot > 0
    ? `Runs at ${previewHour}:${previewMinute}${daySuffix} (slot ${slot})`
    : `Runs at ${previewHour}:${previewMinute}`;
}

// Load saved config
async function restore() {
  const [cfg, localCfg] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get({ profileSlot: 0 }),
  ]);
  els.enabled.checked = cfg.enabled;
  els.time.value = cfg.time;
  els.profileSlot.value = normalizeProfileSlot(localCfg.profileSlot) || "";
  els.count.value = cfg.searchesPerRun;
  els.intervalMin.value = cfg.intervalMin;
  els.intervalMax.value = cfg.intervalMax;
  els.custom.value = cfg.customQueriesRaw;
  updateSchedulePreview();
}
restore();

els.time.addEventListener("input", updateSchedulePreview);
els.profileSlot.addEventListener("input", updateSchedulePreview);

// Save config
els.save.addEventListener("click", async (e) => {
  e.preventDefault();
  const enabled = els.enabled.checked;
  const time = els.time.value;
  const profileSlot = normalizeProfileSlot(els.profileSlot.value);
  const searchesPerRun = Math.max(1, Math.min(100, parseInt(els.count.value || "50", 10)));
  const intervalMin = Math.max(0, parseInt(els.intervalMin.value || "10", 10));
  const intervalMax = Math.max(intervalMin + 1, parseInt(els.intervalMax.value || "120", 10));
  const customQueriesRaw = els.custom.value || "";

  await chrome.storage.sync.set({
    enabled, time, searchesPerRun, intervalMin, intervalMax, customQueriesRaw
  });
  await chrome.storage.local.set({ profileSlot });

  await chrome.runtime.sendMessage({ type: "RESCHEDULE" });

  els.status.textContent = "Settings saved!";
  setTimeout(() => (els.status.textContent = ""), 2000);
});
