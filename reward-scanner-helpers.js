(function installRewardScannerHelpers(global) {
  if (
    typeof global.findRewardCardRoots === "function" &&
    typeof global.expandRewardSection === "function"
  ) {
    return;
  }

  const ACTION_SELECTOR =
    "a[href], button, [role='button'], [role='link'], [data-react-aria-pressable='true']";
  const DIRECT_ACTION_SELECTOR =
    "a[href][data-react-aria-pressable='true'], a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']";
  const CARD_SELECTOR =
    "a[href].rounded-cornerCardDefault, button.rounded-cornerCardDefault, [role='button'].rounded-cornerCardDefault, [role='link'].rounded-cornerCardDefault, [data-react-aria-pressable='true'].rounded-cornerCardDefault, .rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']";
  const DISCLOSURE_SELECTOR =
    "[slot='trigger'], [aria-expanded][aria-controls]";

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  global.isRewardSectionChrome = function isRewardSectionChrome(element, rootNode) {
    if (!element) return false;
    if (element === rootNode) return true;
    if (element.matches?.(DISCLOSURE_SELECTOR)) return true;
    if (element.querySelector?.(DISCLOSURE_SELECTOR)) return true;

    const href =
      element.getAttribute?.("href") ||
      element.querySelector?.("a[href]")?.getAttribute?.("href") ||
      "";
    if (href) return false;

    const text = normalizeText(element.innerText || element.textContent || "");
    if (/^(?:keep earning|\+?\d+(?:\s*(?:pts?|points?|days?|ngày))?|\d+\s*\/\s*\d+(?:\s+tasks?)?)$/i.test(text)) return true;
    if (/^(?:(?:\+?\d[\d,.]*\s+)?bonus|.*streak|level up activities)$/i.test(text)) return true;
    if (/\b\d+\s+days\s+in\s+a\s+row\b/i.test(text)) return true;

    return false;
  };

  function isRewardCollectionContainer(element, rootNode) {
    if (!element) return false;
    if (element === rootNode) return true;
    if (element.id === "moreactivities" || element.id === "dailyset") return true;
    if (element.tagName === "SECTION") return true;
    if (element.querySelector?.(DISCLOSURE_SELECTOR)) return true;

    const className = (element.getAttribute?.("class") || element.className || "")
      .toString()
      .toLowerCase();
    const hasCollectionClass =
      className.includes("container") ||
      className.includes("grid") ||
      className.includes("section") ||
      className.includes("row") ||
      className.includes("list");
    if (hasCollectionClass && element.querySelectorAll?.(ACTION_SELECTOR).length > 1) {
      return true;
    }

    if (!element.matches?.("a[href], button, [role='button'], [role='link']")) {
      return element.querySelectorAll?.(ACTION_SELECTOR).length > 1;
    }
    return false;
  }

  global.findRewardCardRoots = function findRewardCardRoots(rootNode) {
    if (!rootNode?.querySelectorAll) return [];

    const roots = [];
    const seen = new Set();
    const nodes = rootNode.querySelectorAll(ACTION_SELECTOR);

    for (const node of nodes) {
      let card = node;
      if (!node.matches?.(DIRECT_ACTION_SELECTOR)) {
        const closestCard = node.closest?.(CARD_SELECTOR);
        if (closestCard && !isRewardCollectionContainer(closestCard, rootNode)) {
          card = closestCard;
        }
      }

      if (seen.has(card)) continue;
      seen.add(card);
      roots.push(card);
    }

    return roots;
  };

  function dispatchRewardPress(el) {
    if (!el) return;
    try {
      if (typeof el.getBoundingClientRect === "function") {
        const rect = el.getBoundingClientRect();
        const clientX = rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2)) || 0;
        const clientY = rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2)) || 0;
        const pointerOpts = { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", isPrimary: true, clientX, clientY };
        const mouseOpts = { bubbles: true, cancelable: true, composed: true, view: global, detail: 1, button: 0, buttons: 1, clientX, clientY };

        if (typeof PointerEvent === "function") {
          el.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
          el.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
        }
        if (typeof MouseEvent === "function") {
          el.dispatchEvent(new MouseEvent("mousedown", mouseOpts));
          el.dispatchEvent(new MouseEvent("mouseup", { ...mouseOpts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent("click", { ...mouseOpts, buttons: 0 }));
        }
        if (el.getAttribute?.("aria-expanded") === "false" || typeof MouseEvent !== "function") {
          try { el.click?.(); } catch {}
        }
        try { el.focus?.(); } catch {}
        return;
      }
    } catch {}
    try { el.focus?.(); } catch {}
    try { el.click?.(); } catch {}
  }

  global.dispatchRewardPress = dispatchRewardPress;

  global.expandRewardSection = function expandRewardSection(section) {
    if (!section || !section.querySelectorAll) return;
    const triggers = section.querySelectorAll(
      "button[slot='trigger'][aria-expanded='false'], button[aria-expanded='false'][aria-controls], [data-rac][aria-expanded='false'][slot='trigger'], [data-react-aria-pressable='true'][aria-expanded='false'], [aria-expanded='false'][aria-controls], [role='button'][aria-expanded='false'][aria-controls]"
    );
    for (const trigger of triggers) {
      dispatchRewardPress(trigger);
    }
  };

  global.injectRestoredDailySet = function injectRestoredDailySet(dailySetData) {
    if (!dailySetData || !Array.isArray(dailySetData.cards) || dailySetData.cards.length === 0) return false;
    
    // Find ideal insertion target: before "Your perks" (#offers), #moreactivities, or #snapshot ("Your progress")
    const target =
      document.getElementById("offers") ||
      document.getElementById("moreactivities") ||
      document.getElementById("snapshot") ||
      document.querySelector("main section") ||
      document.querySelector("section");

    let section = document.getElementById("dailyset");
    if (!section) {
      section = document.createElement("section");
      section.id = "dailyset";
      section.className = "scroll-mt-3 xl:scroll-mt-5 mb-8";

      if (target && target.parentNode) {
        target.parentNode.insertBefore(section, target);
      } else {
        const main = document.querySelector("main") || document.body;
        if (main && main.children && main.children.length > 1) {
          main.insertBefore(section, main.children[1]);
        } else if (main) {
          main.prepend(section);
        }
      }
    } else if (target && target.parentNode && section.nextElementSibling !== target && section !== target) {
      // Re-anchor if displaced
      target.parentNode.insertBefore(section, target);
    }

    const streakDays = dailySetData.streakDays || 0;
    const cardsHtml = dailySetData.cards
      .map((card) => {
        const isDone = Boolean(card.complete);
        const checkBadge = isDone
          ? `<div class="flex size-5 shrink-0 items-center justify-center rounded-full bg-statusSuccessRest text-fgOnStatusSuccess" style="background-color:#107c41;color:#fff;"><svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" /></svg></div>`
          : `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="size-4 shrink-0 text-fgCtrlNeutralSecondaryRest" style="width:16px;height:16px;"><path fill="currentColor" d="M6.25 4.5A1.75 1.75 0 0 0 4.5 6.25v11.5c0 .966.783 1.75 1.75 1.75h11.5a1.75 1.75 0 0 0 1.75-1.75v-4a.75.75 0 0 1 1.5 0v4A3.25 3.25 0 0 1 17.75 21H6.25A3.25 3.25 0 0 1 3 17.75V6.25A3.25 3.25 0 0 1 6.25 3h4a.75.75 0 0 1 0 1.5zM13 3.75a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-1.5 0V5.56l-5.22 5.22a.75.75 0 0 1-1.06-1.06l5.22-5.22h-4.69a.75.75 0 0 1-.75-.75"></path></svg>`;

        return `
        <a class="group/ctrl cursor-pointer data-disabled:cursor-default outline-0 outline-ctrlFocusOuterStroke focus-visible:outline-ctrlFocusOuterStrokeWidth rounded-cornerCardDefault" data-rac="" href="${card.destinationUrl}" target="_blank" rel="noopener noreferrer" tabindex="0" data-react-aria-pressable="true" data-reward-card-name="${card.name || ""}">
          <div class="flex size-full gap-gapBetweenContentSmall p-paddingCardDefault overflow-hidden rounded-cornerCardDefault bg-bgCardOnPrimaryDefaultRest border border-strokeCardOnPrimaryRest cursor-pointer hover:bg-bgCardOnPrimaryDefaultHover active:bg-bgCardOnPrimaryDefaultPressed hover:[&_img]:scale-110 hover:border-strokeCardOnPrimaryHover active:border-strokeCardOnPrimaryPressed shadow-shadowCardRest hover:shadow-shadowCardHover active:shadow-shadowCardPressed flex-row" style="min-height:92px;">
            <div class="relative shrink-0 overflow-hidden rounded-cornerCardNestedDefaultOutside bg-bgCtrlNeutralDisabled aspect-square h-24.5" style="width:96px;height:96px;">
              <img alt="${card.title || ""}" class="text-transparent absolute inset-0 h-full w-full object-cover transition-transform duration-200" src="${card.imageUrl || ""}">
            </div>
            <div class="flex grow flex-col p-paddingCardBodyDefaultOutside gap-2">
              <div class="flex grow flex-col gap-0.5">
                <p class="line-clamp-3 text-globalBody2Strong font-semibold">${card.title || ""}</p>
                <p class="line-clamp-3 text-fgCtrlNeutralSecondaryRest text-sm opacity-80">${card.description || ""}</p>
              </div>
              <div class="flex w-full items-center gap-2">
                <div class="flex h-5 w-fit min-w-5 shrink-0 items-center justify-center gap-0.5 rounded-cornerCircular px-1.5 border border-strokeDividerDefault bg-statusInformativeTintBg">
                  <p class="text-metadata leading-none text-statusInformativeTintFg font-bold">+${card.points || 10}</p>
                </div>
                <div class="flex grow items-center justify-end gap-0.5">
                  ${checkBadge}
                </div>
              </div>
            </div>
          </div>
        </a>
      `;
      })
      .join("");

    section.innerHTML = `
      <div class="react-aria-Disclosure" data-rac="" data-expanded="true">
        <div class="-mx-5 flex flex-wrap items-center gap-2 rounded-cornerCardDefault p-3 px-5 mb-2">
          <div class="flex max-w-full grow-9999 items-center gap-3">
            <h2 class="truncate text-sectionHeader font-bold text-xl">Daily set</h2>
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300 border border-orange-300 dark:border-orange-800 shadow-sm" style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:9999px;font-size:12px;font-weight:600;background-color:rgba(255,145,0,0.15);color:#ea580c;border:1px solid rgba(234,88,12,0.4);">
              <span>🔥</span>
              <span>${streakDays} day streak</span>
            </span>
          </div>
        </div>
        <div class="react-aria-DisclosurePanel" data-rac="" role="group" aria-hidden="false">
          <div class="flex flex-col">
            <div class="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
              ${cardsHtml}
            </div>
          </div>
        </div>
      </div>
    `;
    return true;
  };

  global.ensurePersistentDailySet = function ensurePersistentDailySet(dailySetData) {
    if (!dailySetData || !Array.isArray(dailySetData.cards) || dailySetData.cards.length === 0) return false;
    global.__restoredDailySetData = dailySetData;

    function apply() {
      if (typeof window !== "undefined" && window.location) {
        const path = window.location.pathname || "";
        if (/^\/(?:earn|redeem|about|status)\b/i.test(path)) return;
      }

      const current = document.getElementById("dailyset");
      if (current && current.isConnected && current.querySelector("a[href]")) {
        return;
      }

      global.injectRestoredDailySet(global.__restoredDailySetData);
    }

    apply();

    // 1. Observe DOM changes to survive React client-side hydration
    if (!global.__dailySetObserver && typeof MutationObserver !== "undefined") {
      const root = document.body || document.documentElement;
      if (root) {
        global.__dailySetObserver = new MutationObserver(() => {
          apply();
        });
        global.__dailySetObserver.observe(root, { childList: true, subtree: true });
      }
    }

    // 2. Poll during the initial 15 seconds after page load
    if (!global.__dailySetPollInterval) {
      let checks = 0;
      global.__dailySetPollInterval = setInterval(() => {
        apply();
        if (++checks > 30) {
          clearInterval(global.__dailySetPollInterval);
          global.__dailySetPollInterval = null;
        }
      }, 500);
    }

    return true;
  };

  // Auto-request data when dashboard page loads
  function checkAndRestoreDashboard() {
    if (typeof window === "undefined" || !window.location) return;
    if (!/rewards\.bing\.com\/dashboard/i.test(window.location.href)) return;

    if (global.__restoredDailySetData) {
      global.ensurePersistentDailySet(global.__restoredDailySetData);
    } else if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: "GET_RESTORED_DAILY_SET" }, (res) => {
          if (chrome.runtime.lastError) return;
          if (res && res.data) {
            global.ensurePersistentDailySet(res.data);
          }
        });
      } catch {}
    }
  }

  // Hook SPA navigation (Next.js router pushState/replaceState and popstate)
  if (typeof window !== "undefined" && window.history) {
    const origPush = window.history.pushState;
    if (origPush) {
      window.history.pushState = function (...args) {
        const res = origPush.apply(this, args);
        setTimeout(checkAndRestoreDashboard, 100);
        return res;
      };
    }
    const origReplace = window.history.replaceState;
    if (origReplace) {
      window.history.replaceState = function (...args) {
        const res = origReplace.apply(this, args);
        setTimeout(checkAndRestoreDashboard, 100);
        return res;
      };
    }
    window.addEventListener("popstate", () => setTimeout(checkAndRestoreDashboard, 100));
  }

  // Initial check on load
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", checkAndRestoreDashboard);
    } else {
      checkAndRestoreDashboard();
    }
  }
})(globalThis);
