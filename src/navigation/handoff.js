const ANTI_AUTOMATION = /\b(?:captcha|verify you are human|prove you are human|are you (?:a )?robot|unusual traffic|automated requests? detected|security challenge|bot challenge)\b/i;
const LOGIN_REQUIRED = /\b(?:authentication required|login required|sign in to continue|log in to continue|please sign in|please log in|session (?:has )?expired)\b/i;
const LOGIN_CONTEXT = /\b(?:sign[ -]?in|log[ -]?in|login|authentication|authenticate|account access)\b/i;
const normalize = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

function visiblePageText(observation) {
  return [
    observation.page?.title,
    ...(observation.headings ?? []).map(item => item.text),
    ...(observation.candidates ?? []).filter(candidate => candidate.visible !== false).map(candidate => candidate.name)
  ].map(normalize).filter(Boolean);
}

export function classifyHumanHandoff(observation) {
  const labels = visiblePageText(observation);
  if (labels.some(label => ANTI_AUTOMATION.test(label))) {
    return { category: "anti_automation", reason: "An anti-automation challenge is visible. Complete it manually, then resume the task." };
  }
  if ((observation.networkSignals ?? []).some(signal => signal?.kind === "http_rate_limit" && signal.status === 429)) {
    return { category: "rate_limited", reason: "The site returned HTTP 429. Stop requests and wait for the site's limit window before resuming." };
  }

  let pathname = "";
  try { pathname = new URL(observation.page?.url).pathname; } catch { /* non-URL page */ }
  const loginRoute = /(?:^|\/)(?:login|log-in|signin|sign-in|auth)(?:\/|$)/i.test(pathname);
  const loginPrompt = labels.some(label => LOGIN_REQUIRED.test(label));
  const passwordField = (observation.candidates ?? []).some(candidate => candidate.visible !== false && String(candidate.type ?? "").toLowerCase() === "password");
  const loginContext = labels.some(label => LOGIN_CONTEXT.test(label));
  if (loginRoute || loginPrompt || passwordField && loginContext) {
    return { category: "authentication", reason: "A login or password step is required. Complete it in the browser, then resume the task." };
  }
  return undefined;
}
