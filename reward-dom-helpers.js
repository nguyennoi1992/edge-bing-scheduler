export function normalizeRewardText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

const COMPLETED_RE =
  /\bcompleted\b|\bdone\b|hoàn thành|đã xong|已完成|完了|terminé|abgeschlossen|completado|завершено/i;

const QUEST_HEADING_RE = /^(activities|hoạt động|tareas|activités|aufgaben)$/i;
const QUEST_META_RE = /^(status:|expires:|trạng thái:|hết hạn:)/i;
const QUEST_CHROME_RE = /^(feedback|privacy|terms|microsoft|bing|search)$/i;
const QUEST_CLOSE_RE = /^(back|close|quay lại|đóng|zurück|schließen|retour|fermer|volver|cerrar)$/i;

export function isCompletedText(value) {
  return COMPLETED_RE.test(normalizeRewardText(value).toLowerCase());
}

export function isActionableRewardCard(meta) {
  const href = meta.href || "";
  const text = normalizeRewardText(meta.text).toLowerCase();

  if (meta.isVisible === false) return false;
  if (meta.isDisabled) return false;
  if (meta.isCompleted) return false;
  if (meta.isInNav) return false;
  if (meta.isQuestCard) return false;
  if (!meta.hasVisual) return false;
  if (!text) return false;
  if (!href && !meta.isPressable) return false;
  if (href === "/earn") return false;
  // Only skip short navigation buttons like "Earn more" or "See more tasks",
  // NOT cards whose longer description happens to contain these phrases.
  if (/^(see more tasks|earn more)$/i.test(text.replace(/\s+/g, " ").trim())) return false;

  return true;
}

export function buildRewardCardKey({ href = "", title = "", text = "" }) {
  const normalizedTitle = normalizeRewardText(title || text).toLowerCase();
  return `${href}|${normalizedTitle}`;
}

export function buildQuestCardKey({ href = "", text = "" }) {
  return `${href || "btn"}|${normalizeRewardText(text).toLowerCase()}`;
}

export function isActionableQuestActivity(meta) {
  const innerLabel = normalizeRewardText(meta.innerLabel);
  const ariaLabel = normalizeRewardText(meta.ariaLabel);
  const label = normalizeRewardText(`${ariaLabel} ${innerLabel}`).toLowerCase();

  if (meta.isVisible === false) return false;
  if (meta.isDisabled) return false;
  if (meta.isInNav) return false;
  if (meta.isQuestCard) return false;
  if (!label) return false;
  if (QUEST_HEADING_RE.test(label)) return false;
  if (QUEST_META_RE.test(label)) return false;
  if (QUEST_CHROME_RE.test(label)) return false;
  if (QUEST_CLOSE_RE.test(innerLabel)) return false;
  if (meta.isCompleted) return false;

  return true;
}

export function buildQuestActivityKey({ href = "", innerLabel = "", ariaLabel = "" }) {
  const label = normalizeRewardText(ariaLabel) || normalizeRewardText(innerLabel);
  return `${href}|${label.toLowerCase()}`;
}
