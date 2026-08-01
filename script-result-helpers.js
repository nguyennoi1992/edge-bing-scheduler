export function getFirstScriptResult(scriptResults, fallback) {
  return scriptResults?.[0]?.result ?? fallback;
}
