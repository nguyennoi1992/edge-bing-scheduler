(function installRewardScannerHelpers(global) {
  if (typeof global.findRewardCardRoots === "function") return;

  const ACTION_SELECTOR =
    "a[href], button, [role='button'], [role='link'], [data-react-aria-pressable='true']";
  const DIRECT_ACTION_SELECTOR =
    "a[href][data-react-aria-pressable='true'], a[href].rounded-cornerCardDefault, a[href][class*='rounded-cornerCardDefault']";
  const CARD_SELECTOR =
    "a[href].rounded-cornerCardDefault, button.rounded-cornerCardDefault, [role='button'].rounded-cornerCardDefault, [role='link'].rounded-cornerCardDefault, [data-react-aria-pressable='true'].rounded-cornerCardDefault, .rounded-cornerCardDefault, [class*='rounded-cornerCardDefault']";

  function isRewardCollectionContainer(element, rootNode) {
    if (!element) return false;
    if (element === rootNode) return true;
    if (element.id === "moreactivities" || element.id === "dailyset") return true;
    if (element.tagName === "SECTION") return true;

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
})(globalThis);
