export function normalizeRewardText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

const COMPLETED_RE =
  /\bcompleted\b|\bdone\b|hoàn thành|đã xong|已完成|完了|terminé|abgeschlossen|completado|завершено/i;

export const EMPTY_REWARD_STABLE_MS = 20_000;
export const REWARD_HYDRATION_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

export const QUIZ_COMPLETION_RE =
  /thanks for playing|come back tomorrow|you earned(?:\s+\d+)?(?:\s+points?)?|quiz complete|all done|nice work|thank you for participating|great job|well done|test complete|cảm ơn bạn(?: đã tham gia)?|hoàn thành bài|làm tốt lắm|答题完成|已完成测验|quiz terminé|quiz abgeschlossen|cuestionario completado|тест завершен/i;

const QUEST_HEADING_RE = /^(activities|hoạt động|tareas|activités|aufgaben)$/i;
const QUEST_META_RE = /^(status:|expires:|trạng thái:|hết hạn:)/i;
const QUEST_CHROME_RE = /^(feedback|privacy|terms|microsoft|bing|search)$/i;
const QUEST_CLOSE_RE = /^(back|close|quay lại|đóng|zurück|schließen|retour|fermer|volver|cerrar)$/i;
const QUEST_INFO_RE =
  /^(?:about(?:\s+(?:this\s+)?(?:quest|daily set|rewards|activities))?|về(?:\s+(?:nhiệm vụ|hoạt động))?|level up activities)$/i;
const QUEST_STREAK_RE = /\b(?:\d+\s+days\s+in\s+a\s+row|for\s+\d+\s+days|streak)\b/i;

export const READY_TO_CLAIM_LABEL_RE =
  /^\s*(?:ready to claim|sẵn sàng nhận|可领取|prêt à réclamer|bereit zum einlösen|listo para reclamar|готово к получению)(?:[\s!:]*(?:\+\s*)?\d[\d,.]*(?:\s*(?:points?|pts?))?[\s!:]*|[\s!:]*)?\s*$/i;

export const CLAIM_TEXT_RE =
  /^claim points$|^nhận điểm$|^领取积分$|^réclamer des points$|^punkte einlösen$|^reclamar puntos$|^получить баллы$/i;

export const CLAIM_MATCH_RE =
  /claim points|nhận điểm|领取积分|réclamer des points|punkte einlösen|reclamar puntos|получить баллы/i;

export function parsePointsFromText(text) {
  const input = typeof text === "string" ? text : String(text ?? "");
  // 1. Explicit points with keyword or plus (e.g. "+6", "6 points", "+1,000 pts")
  const pointMatch =
    input.match(/(?:\+\s*|\b)(\d[\d,.]*)\s*(?:points?|pts?)\b/i) ||
    input.match(/\+\s*(\d[\d,.]*)\b(?!\s*(?:days?|hours?|hrs?|mins?|minutes?|ngày|giờ|phút|streak|friends?|bạn)(?:[\s,.]|$))/i);
  if (pointMatch) {
    const parsed = Number(pointMatch[1].replace(/[,.]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  // 2. Ready to claim / Claim card context: number near claim / pending (e.g. "Ready to claim 6 Claim", "6 Pending", "Ready to claim: +50")
  const contextualMatch =
    input.match(
      /(?:ready to claim|sẵn sàng nhận|可领取|prêt à réclamer|bereit zum einlösen|listo para reclamar|готово к получению|\bclaim\b|\bnhận\b|\breclamar\b|\beinlösen\b|\bpending\b)(?:\s+(?:points?|pts?|điểm|puntos))?[\s!:+\-]*\b(\d[\d,.]*)\b(?!\s*(?:days?|hours?|hrs?|mins?|minutes?|ngày|giờ|phút|of\b|\/\s*\d+)(?:[\s,.]|$))/i,
    ) ||
    input.match(/\b(\d[\d,.]*)\b[\s!:+\-]*(?:\bpending\b|\bclaim\b|\bnhận\b|\breclamar\b|\beinlösen\b)(?!\w)/i);
  if (contextualMatch) {
    const parsed = Number(contextualMatch[1].replace(/[,.]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  // 3. Standalone short number
  const standaloneMatch = input.trim().match(/^(\d[\d,.]*)$/);
  if (standaloneMatch) {
    const parsed = Number(standaloneMatch[1].replace(/[,.]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function isCompletedText(value) {
  return COMPLETED_RE.test(normalizeRewardText(value).toLowerCase());
}

export function collectProgressRatioMatches(text) {
  if (!text) return [];
  return [
    ...text.matchAll(/(?<![\/\d])\b(\d+)\s*\/\s*([1-9]\d*)\b(?:\s+(?:tasks?|points?|pts?|quests?|activities|hoạt động|nhiệm vụ|tareas?|activités?|aufgaben))(?!\s*[\/\d])/gi),
    ...text.matchAll(/\b(?:quests?|nhiệm vụ|hoạt động|tareas?|activités?|aufgaben)\s+(\d+)\s*\/\s*([1-9]\d*)\b(?!\s*[\/\d])/gi),
    ...text.matchAll(/(?:\bcompleted\b|\bdone\b|ho\u00e0n th\u00e0nh|\u0111\u00e3 xong|\u5df2\u5b8c\u6210|\u5b8c\u4e86|termin\u00e9|abgeschlossen|completado|\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e)[\s!:()\-–—[\]]*(\d+)\s*\/\s*([1-9]\d*)\b(?!\s*[\/\d])/gi),
    ...text.matchAll(/(?<![\/\d])\b(\d+)\s*\/\s*([1-9]\d*)[\s!:()\-–—[\]]*(?:\bcompleted\b|\bdone\b|ho\u00e0n th\u00e0nh|\u0111\u00e3 xong|\u5df2\u5b8c\u6210|\u5b8c\u4e86|termin\u00e9|abgeschlossen|completado|\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e)/gi),
  ];
}

export function isCompletedQuestText(value) {
  const text = normalizeRewardText(value);
  if (!text) return false;

  // 1. Collect all explicit progress ratio matches (tasks, points, quests, activities, completed prefix/suffix)
  const allRatioMatches = collectProgressRatioMatches(text);
  if (allRatioMatches.length > 0) {
    return allRatioMatches.every((m) => Number(m[1]) >= Number(m[2]));
  }

  // 2. If no explicit ratios found, inspect completion keywords
  if (isCompletedText(text)) return true;

  // 3. Standalone ratio badge (e.g. "1/1", "5/5")
  const exactRatioMatch = text.match(/^(\d+)\s*\/\s*([1-9]\d*)$/);
  if (exactRatioMatch) {
    return Number(exactRatioMatch[1]) >= Number(exactRatioMatch[2]);
  }

  return false;
}

export function isCardCompleted(cardEl) {
  if (!cardEl) return false;
  const BADGE_SELECTOR =
    "[class*='statusSuccess'], [class*='Success'], [class*='CheckMark'], [class*='checkMark']";
  const DIRECT_BADGE_SELECTOR =
    "svg[class*='statusSuccess'], mee-icon[class*='statusSuccess'], svg[class*='Success'], mee-icon[class*='Success'], mee-icon[class*='CheckMark'], svg[class*='CheckMark'], mee-icon[class*='checkMark'], svg[class*='checkMark']";

  const matchedList = cardEl.querySelectorAll?.(BADGE_SELECTOR);
  let matchedElements = [];
  if (matchedList) {
    matchedElements = Array.from(matchedList);
  } else {
    const single = cardEl.querySelector?.(BADGE_SELECTOR);
    if (single) matchedElements = [single];
  }

  const badgeElements = [
    ...(typeof cardEl.matches === "function" && cardEl.matches(DIRECT_BADGE_SELECTOR) ? [cardEl] : []),
    ...matchedElements,
  ];

  for (const successBadge of badgeElements) {
    const isDirectIcon =
      successBadge.tagName?.toLowerCase() === "svg" ||
      successBadge.tagName?.toLowerCase() === "mee-icon";
    const classStr =
      typeof successBadge.className === "string"
        ? successBadge.className
        : successBadge.getAttribute?.("class") || "";
    const hasCheckmarkClass = /mee-icon-CheckMark|\bcheck-?mark\b/i.test(classStr);
    const hasSuccessClass = /Success/i.test(classStr);

    if (isDirectIcon && (hasCheckmarkClass || hasSuccessClass)) {
      return true;
    }
    if (
      successBadge !== cardEl &&
      (hasCheckmarkClass || hasSuccessClass) &&
      Boolean(successBadge.querySelector?.(DIRECT_BADGE_SELECTOR))
    ) {
      return true;
    }
  }

  const statusEls =
    cardEl.querySelectorAll?.(
      "[class*='metadata'], [class*='fgCtrlNeutralSecondary']",
    ) || [];
  for (const el of statusEls) {
    const t = normalizeRewardText(el.textContent || "");
    if (isCompletedQuestText(t)) return true;
  }

  return false;
}

export function findQuizCompletionPhrase(value) {
  return normalizeRewardText(value).match(QUIZ_COMPLETION_RE)?.[0] || "";
}

export function isDashboardRewardHref(href) {
  const value = href || "";
  return (
    /^(?:https?:\/\/(?:[a-z0-9-]+\.)?bing\.com)?\/(?:search|spotlight\/imagepuzzle)\b/i.test(value) ||
    /^https?:\/\/(?!rewards\b)(?:[a-z0-9-]+\.)?bing\.com\//i.test(value) ||
    /(?:[?&]rnoreward=1\b|rewardsquiz_dailyset|global_dailyset|form=dsetqu|publ=RewardsDO|wqoskey=)/i.test(value)
  );
}

export function shouldFinishEmptyRewardScan({
  readyState,
  hasTargetSection,
  count,
  stableEmptyMs,
  requiredStableMs = EMPTY_REWARD_STABLE_MS,
} = {}) {
  return (
    readyState === "complete" &&
    hasTargetSection === true &&
    count === 0 &&
    stableEmptyMs >= requiredStableMs
  );
}

export function isActionableRewardCard(meta) {
  const href = meta.href || "";
  const text = normalizeRewardText(meta.text).toLowerCase();
  const hasValidHref = Boolean(href && !/^(?:#|javascript:)/i.test(href.trim()));

  if (meta.isVisible === false) return false;
  if (meta.isDisabled) return false;
  if (meta.isCompleted) return false;
  if (meta.isInNav) return false;
  if (meta.isQuestCard) return false;
  if (meta.isSectionChrome) return false;
  if (meta.isHeader) return false;
  if (!meta.hasVisual) return false;
  if (!text) return false;
  if (!hasValidHref && !meta.isPressable) return false;
  if (/^(?:https?:\/\/rewards\.bing\.com)?\/(?:earn|about|redeem|refer|status|optout)\/?(?:[?#].*)?$/i.test(href)) return false;
  // Only skip short navigation buttons like "Earn more" or "See more tasks",
  // NOT cards whose longer description happens to contain these phrases.
  if (/^(see more tasks|earn more)$/i.test(text.replace(/\s+/g, " ").trim())) return false;
  if (!hasValidHref) {
    const compactText = text.replace(/\s+/g, " ").trim();
    if (/^\+?\d+(?:\s*(?:pts?|points?|days?|ngày))?$/i.test(compactText)) return false;
    if (/^(?:(?:\+?\d[\d,.]*\s+)?bonus|.*streak|level up activities)$/i.test(compactText)) return false;
    if (/\b\d+\s+days\s+in\s+a\s+row\b/i.test(compactText)) return false;
  }

  return true;
}

export function classifyRewardScanState({
  cardsCount = 0,
  sections = [],
  targetSectionIds = [],
  stableEmpty = false,
  previouslyHydrated = false,
} = {}) {
  const targetIds = new Set(targetSectionIds || []);
  const targetSections = (sections || []).filter(
    (section) =>
      targetIds.size === 0 ||
      targetIds.has(section.sectionId) ||
      (section.sectionId === "earn_fallback" && targetIds.has("moreactivities")) ||
      (section.sectionId === "dashboard_fallback" && (targetIds.has("dailyset") || targetIds.has("ext-restored-dailyset"))),
  );
  const existingSections = targetSections.filter((section) => section.exists === true);
  const hydrated =
    previouslyHydrated === true ||
    existingSections.some((section) => section.hydrated === true);
  const fallbackHydrated = existingSections.some(
    (section) => /_fallback$/.test(section.sectionId || "") && section.hydrated === true,
  );
  const headerOnly = previouslyHydrated !== true && !fallbackHydrated &&
    existingSections.some(
      (section) =>
        section.hydrated !== true &&
        section.directRoundedAnchors === 0 &&
        (section.completed || 0) === 0 &&
        (section.sectionChrome || 0) > 0,
    );

  if (cardsCount > 0 && hydrated) return "ready_cards";
  if (headerOnly) return "header_only";
  if (cardsCount === 0 && stableEmpty && hydrated) return "stable_empty";
  if (hydrated) return "hydrating";
  return "partial";
}

export function getRewardHydrationRetryDelay(attempt) {
  const index = Math.max(0, Math.min(
    REWARD_HYDRATION_RETRY_DELAYS_MS.length - 1,
    Number(attempt || 1) - 1,
  ));
  return REWARD_HYDRATION_RETRY_DELAYS_MS[index];
}

export function buildRewardCardKey({ href = "", title = "", text = "" }) {
  const normalizedTitle = normalizeRewardText(title || text).toLowerCase();
  return `${href}|${normalizedTitle}`;
}

export function buildQuestCardKey({ href = "", text = "" }) {
  return `${href || "btn"}|${normalizeRewardText(text).toLowerCase()}`;
}

export function isActionableQuestActivity(meta = {}) {
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
  if (QUEST_INFO_RE.test(innerLabel) || QUEST_INFO_RE.test(ariaLabel) || QUEST_INFO_RE.test(label)) return false;
  const hasValidHref = Boolean(meta.href && !/^(?:#|javascript:)/i.test(meta.href.trim()));
  if (!hasValidHref && !meta.isPressable) return false;
  if (!hasValidHref && QUEST_STREAK_RE.test(label)) return false;

  if (meta.hasSuccessBadge) return false;

  const standaloneRatioMatches = [innerLabel, ariaLabel, label]
    .map((str) => (str || "").match(/^(\d+)\s*\/\s*([1-9]\d*)$/))
    .filter(Boolean);

  const hasIncompleteRatio = [
    ...collectProgressRatioMatches(label),
    ...standaloneRatioMatches,
  ].some((m) => Number(m[1]) < Number(m[2]));

  if (hasIncompleteRatio) {
    return true;
  }

  if (
    meta.isCompleted ||
    isCompletedQuestText(label) ||
    isCompletedQuestText(innerLabel) ||
    isCompletedQuestText(ariaLabel)
  ) {
    return false;
  }

  return true;
}

export function buildQuestActivityKey({ href = "", innerLabel = "", ariaLabel = "" }) {
  const label = normalizeRewardText(ariaLabel) || normalizeRewardText(innerLabel);
  return `${href}|${label.toLowerCase()}`;
}

export function isRewardsPageUrl(url) {
  try {
    const u = new URL(url || "");
    return (
      u.protocol === "https:" &&
      u.hostname === "rewards.bing.com" &&
      (u.pathname === "/earn" ||
        u.pathname === "/dashboard" ||
        u.pathname === "/" ||
        u.pathname.startsWith("/"))
    );
  } catch {
    return false;
  }
}

export function extractDailySetFromFlyoutHtml(html) {
  if (!html || typeof html !== "string") return null;
  const prefix = "window.flyoutViewModel";
  const startIdx = html.indexOf(prefix);
  if (startIdx === -1) return null;
  const eqIdx = html.indexOf("=", startIdx);
  if (eqIdx === -1) return null;
  const jsonStart = html.indexOf("{", eqIdx);
  if (jsonStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let vm = null;

  for (let i = jsonStart; i < html.length; i++) {
    const ch = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const jsonStr = html.substring(jsonStart, i + 1);
          try {
            vm = JSON.parse(jsonStr);
          } catch {
            return null;
          }
          break;
        }
      }
    }
  }

  if (!vm) return null;

  const dsp = vm.flyoutResult?.dailySetPromotions || {};
  const streakPromo = vm.flyoutResult?.streakPromotion || {};
  const streakDays =
    streakPromo.activityProgress ||
    Number(streakPromo.attributes?.activity_progress || 0);

  const today = new Date();
  const m = today.getMonth() + 1;
  const d = today.getDate();
  const y = today.getFullYear();
  const todayKey = `${m}/${d}/${y}`;

  let cards = dsp[todayKey];
  if (!Array.isArray(cards) || cards.length === 0) {
    const dateKeys = Object.keys(dsp);
    for (const key of dateKeys) {
      if (Array.isArray(dsp[key]) && dsp[key].length > 0) {
        cards = dsp[key];
        break;
      }
    }
  }

  if (!cards || cards.length === 0) return null;

  return {
    streakDays,
    cards: cards.map((c) => ({
      name: c.name || "",
      title: c.title || "",
      description: c.description || "",
      points: c.pointProgressMax || 10,
      destinationUrl: c.destinationUrl || "",
      imageUrl: c.imageUrl || c.smallImageUrl || "",
      complete: Boolean(c.complete),
    })),
  };
}
