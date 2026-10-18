import test from "node:test";
import assert from "node:assert/strict";
import { verifyCloudAgentRunIdentifierEvidence } from "../src/integrations/freeinference/browserRunIdentifier.js";

function makeSession({ url = "https://staging.freeinference.org/agents/runs/job-123", name = "Run job-123", capturedAt = "2026-10-17T12:00:00.000Z", beforeContainsRun = false } = {}) {
  return {
    attached: true,
    target: { id: "target-1" },
    latestEvidenceId: "evidence-1",
    observer: {
      getEvidence(evidenceId, options) {
        assert.deepEqual(options.facets, ["page", "accessibilityTree"]);
        if (evidenceId === "evidence-0") {
          return {
            status: "available",
            evidenceId,
            capturedAt: "2026-10-17T11:59:30.000Z",
            page: { url: "https://staging.freeinference.org/agents/tasks/new" },
            accessibilityTree: [{ role: { value: "StaticText" }, name: { value: beforeContainsRun ? "Previous job-123" : "New task" } }]
          };
        }
        assert.equal(evidenceId, "evidence-1");
        return {
          status: "available",
          evidenceId,
          capturedAt,
          page: { url },
          accessibilityTree: [{ role: { value: "StaticText" }, name: { value: name } }]
        };
      }
    }
  };
}

const input = {
  evidenceId: "evidence-1",
  beforeEvidenceId: "evidence-0",
  cloudAgentRunId: "job-123",
  agentOrigin: "https://staging.freeinference.org",
  startedAt: "2026-10-17T11:59:00.000Z"
};

test("exact run identifier is accepted from current same-origin URL evidence", () => {
  const result = verifyCloudAgentRunIdentifierEvidence({ session: makeSession(), ...input });
  assert.equal(result.verified, true);
  assert.equal(result.location, "url_path_segment");
});

test("exact run identifier may be confirmed by an accessible name without returning page text", () => {
  const result = verifyCloudAgentRunIdentifierEvidence({
    session: makeSession({ url: "https://staging.freeinference.org/agents", name: "Run ID: job-123" }),
    ...input
  });
  assert.equal(result.verified, true);
  assert.equal(result.location, "accessible_name");
  assert.equal(Object.hasOwn(result, "text"), false);
});

test("identifier matching rejects stale evidence, wrong origin, partial tokens and malformed time", () => {
  const wrongOrigin = verifyCloudAgentRunIdentifierEvidence({
    session: makeSession({ url: "https://example.invalid/agents/runs/job-123" }), ...input
  });
  assert.equal(wrongOrigin.verified, false);

  const partial = verifyCloudAgentRunIdentifierEvidence({
    session: makeSession({ url: "https://staging.freeinference.org/agents", name: "job-1234" }), ...input
  });
  assert.equal(partial.verified, false);

  const stale = verifyCloudAgentRunIdentifierEvidence({ session: makeSession({ capturedAt: "2026-10-17T11:58:00.000Z" }), ...input });
  assert.equal(stale.verified, false);

  const invalidTime = verifyCloudAgentRunIdentifierEvidence({ session: makeSession(), ...input, startedAt: "invalid" });
  assert.equal(invalidTime.verified, false);
});

test("run ID must be absent before submit and present in later evidence", () => {
  const result = verifyCloudAgentRunIdentifierEvidence({
    session: makeSession({ beforeContainsRun: true }),
    ...input
  });
  assert.equal(result.verified, false);
  assert.match(result.reason, /already present before/);

  const withoutBaseline = verifyCloudAgentRunIdentifierEvidence({
    session: makeSession(),
    ...input,
    beforeEvidenceId: undefined
  });
  assert.equal(withoutBaseline.verified, false);
});
