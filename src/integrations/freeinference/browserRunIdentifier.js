function isRunIdCharacter(character) {
  if (typeof character !== "string" || character.length !== 1) return false;
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || character === "-" || character === "_" || character === "." || character === ":";
}

function hasExactVisibleIdentifier(text, identifier) {
  if (typeof text !== "string" || !text.length) return false;
  let index = text.indexOf(identifier);
  while (index >= 0) {
    const before = index > 0 ? text[index - 1] : "";
    const afterIndex = index + identifier.length;
    const after = afterIndex < text.length ? text[afterIndex] : "";
    if (!isRunIdCharacter(before) && !isRunIdCharacter(after)) return true;
    index = text.indexOf(identifier, index + 1);
  }
  return false;
}

function exactOrigin(value) {
  try { return new URL(value).origin; } catch { return null; }
}

function runIdentifierLocation(evidence, cloudAgentRunId) {
  let pathSegments = [];
  try { pathSegments = new URL(evidence.page?.url).pathname.split("/").filter(Boolean); } catch {}
  if (pathSegments.includes(cloudAgentRunId)) return "url_path_segment";
  for (const node of evidence.accessibilityTree ?? []) {
    for (const field of [node?.name?.value, node?.description?.value]) {
      if (hasExactVisibleIdentifier(field, cloudAgentRunId)) return "accessible_name";
    }
  }
  return null;
}

/**
 * Confirms that a caller-provided Cloud Agent run identifier is visible in
 * the latest retained evidence from the same attached Agents tab. It returns
 * only the match location; page text stays inside the local observer.
 */
export function verifyCloudAgentRunIdentifierEvidence({ session, evidenceId, beforeEvidenceId, cloudAgentRunId, agentOrigin, startedAt } = {}) {
  if (!session?.observer?.getEvidence || !session.target?.id || !session.attached) {
    return { verified: false, reason: "The task's attached browser observer is unavailable." };
  }
  if (typeof cloudAgentRunId !== "string" || !cloudAgentRunId || cloudAgentRunId.length > 128) {
    return { verified: false, reason: "A bounded Cloud Agent run identifier is required." };
  }
  for (const character of cloudAgentRunId) {
    const code = character.codePointAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || character === "-" || character === "_" || character === "." || character === ":")) {
      return { verified: false, reason: "The Cloud Agent run identifier contains unsupported characters." };
    }
  }
  if (evidenceId !== session.latestEvidenceId) {
    return { verified: false, reason: "Use the latest observation from the task's attached Agents tab." };
  }
  const evidence = session.observer.getEvidence(evidenceId, { facets: ["page", "accessibilityTree"] });
  if (evidence?.status !== "available") return { verified: false, reason: "The supplied browser evidence is expired or unavailable." };
  const evidenceTime = Date.parse(evidence.capturedAt);
  const taskTime = Date.parse(startedAt);
  if (!Number.isFinite(evidenceTime) || !Number.isFinite(taskTime) || evidenceTime < taskTime) {
    return { verified: false, reason: "Browser evidence predates the Cloud Agent task or has no valid capture time." };
  }
  if (exactOrigin(evidence.page?.url) !== agentOrigin) return { verified: false, reason: "Browser evidence is not from the task's observed Cloud Agent application origin." };
  const location = runIdentifierLocation(evidence, cloudAgentRunId);
  if (!location) return { verified: false, reason: "The exact run identifier was not visible in the current page URL or accessible names." };

  if (typeof beforeEvidenceId !== "string" || !beforeEvidenceId || beforeEvidenceId === evidenceId) {
    return { verified: false, reason: "The submit step's pre-dispatch browser evidence is required to prove this run ID is new." };
  }
  const before = session.observer.getEvidence(beforeEvidenceId, { facets: ["page", "accessibilityTree"] });
  if (before?.status !== "available" || exactOrigin(before.page?.url) !== agentOrigin) {
    return { verified: false, reason: "The submit step's pre-dispatch evidence is unavailable or belongs to another application origin." };
  }
  const beforeTime = Date.parse(before.capturedAt);
  if (!Number.isFinite(beforeTime) || beforeTime >= evidenceTime) {
    return { verified: false, reason: "The browser evidence does not prove an ordered pre-submit and post-submit observation." };
  }
  if (runIdentifierLocation(before, cloudAgentRunId)) {
    return { verified: false, reason: "The Cloud Agent run identifier was already present before this task was submitted." };
  }
  return { verified: true, evidenceId, beforeEvidenceId, location };
}
