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
    return /^(?:keep earning|\d+\s*\/\s*\d+(?:\s+tasks?)?)$/i.test(text);
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
})(globalThis);
