import test from "node:test";
import assert from "node:assert/strict";
import { discoverObservedApiRequests, inspectObservedApiCandidate, qualifyObservedApiCandidate } from "../src/capabilities/network/apiDiscovery.js";

function observation() {
  return {
    evidenceId: "observation_api_fixture",
    targetId: "target_api_fixture",
    documentGeneration: 7,
    page: { url: "https://app.example.test/orders" }
  };
}

function request(overrides = {}) {
  return {
    requestId: "request_api_1",
    url: "https://app.example.test/api/orders",
    method: "GET",
    status: 200,
    mimeType: "application/json; charset=utf-8",
    resourceType: "Fetch",
    finishedAt: 1.4,
    ...overrides
  };
}

const scope = {
  environment: {
    environmentId: "fixture_env",
    authorizedOrigins: ["https://app.example.test"],
    applications: [{ applicationId: "fixture_app", origin: "https://app.example.test" }]
  },
  principalId: "fixture_principal"
};

test("observed API discovery selects only completed same-origin GET JSON responses without query or redirect", () => {
  const result = discoverObservedApiRequests({
    observation: observation(),
    networkActivity: [
      request({ requestId: "old", status: 200 }),
      request({ requestId: "latest", status: 200 }),
      request({ requestId: "post", method: "POST" }),
      request({ requestId: "cross", url: "https://other.example.test/api/orders" }),
      request({ requestId: "query", url: "https://app.example.test/api/orders?token=private" }),
      request({ requestId: "redirect", redirectedTo: "https://app.example.test/login" }),
      request({ requestId: "failed", failure: { errorText: "failed" } }),
      request({ requestId: "xml", mimeType: "application/xml" }),
      request({ requestId: "pending", finishedAt: null })
    ],
    ...scope
  });

  assert.equal(result.status, "candidate");
  assert.equal(result.candidates.length, 1, "repeated identical endpoint observations collapse to the most recent request");
  assert.equal(result.candidates[0].requestId, "latest");
  assert.equal(result.candidates[0].endpointPath, "/api/orders");
  assert.equal(result.candidates[0].pagePath, "/orders");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("selected API body contributes schema metadata only and requires independent qualification", async () => {
  const page = observation();
  const discovery = discoverObservedApiRequests({
    observation: page,
    networkActivity: [request()],
    ...scope
  });
  const requestCandidate = discovery.candidates[0];
  let bodyReads = 0;
  const inspected = await inspectObservedApiCandidate({
    candidate: requestCandidate,
    observation: page,
    observer: {
      async inspectNetworkResponse(evidenceId, options) {
        bodyReads++;
        assert.equal(evidenceId, page.evidenceId);
        assert.equal(options.requestId, "request_api_1");
        assert.equal(options.includeSensitive, true, "explicit candidate selection opts into local body inspection");
        assert.equal(options.includeCredentialValues, undefined, "API shape discovery never opts into credential values");
        assert.equal(options.view, "normalized");
        return {
          status: "available",
          request: request(),
          responseBody: {
            status: "included",
            format: "json",
            hasMore: false,
            data: JSON.stringify({ items: [
              { id: 1, total: 12.5, status: "open", access_token: "[REDACTED]" },
              { id: 2, total: 20, status: "closed", access_token: "[REDACTED]" }
            ] }),
            credentialRedactions: 2,
            credentialDetails: { items: [{ path: "$.items[].access_token", kind: "access_token", characterLength: 52 }], omitted: 0 }
          }
        };
      }
    }
  });

  assert.equal(bodyReads, 1);
  assert.equal(inspected.status, "candidate");
  const candidate = inspected.candidates[0];
  assert.deepEqual(candidate.collectionPath, ["items"]);
  assert.equal(candidate.recordCount, 2);
  assert.deepEqual(candidate.fields.map(field => [field.name, field.type, field.readEligible]), [
    ["id", "integer", true], ["total", "number", true], ["status", "string", true], ["access_token", "string", false]
  ]);
  assert.equal(JSON.stringify(candidate).includes("access_token\":\"[REDACTED]"), false, "candidate includes field name and redaction metadata, never values");

  const qualified = await qualifyObservedApiCandidate(candidate, {
    variants: 3,
    async runQualification({ variants: count }) {
      return {
        oracleIndependent: true,
        variants: Array.from({ length: count }, (_, index) => ({
          scenarioId: `api_shape_${index}`,
          status: "complete",
          schemaMatch: true,
          completenessVerified: true,
          privacyBoundaryPassed: true,
          evidenceRef: `fixture_evidence_${index}`
        }))
      };
    }
  });
  assert.equal(qualified.status, "qualified");
  assert.equal(qualified.candidate.qualification.evidenceRefs.length, 3);
  assert.equal(qualified.candidate.qualification.level, "resolver");
  assert.equal(qualified.candidate.qualification.independentApplicationOutcome, false);

  const rejected = await qualifyObservedApiCandidate(candidate, {
    variants: 3,
    async runQualification() {
      return { oracleIndependent: false, variants: [{ status: "complete", schemaMatch: true, completenessVerified: true, privacyBoundaryPassed: true }] };
    }
  });
  assert.equal(rejected.status, "not_qualified");
});

test("API candidate inspection rejects stale scope and mismatched selected responses", async () => {
  const page = observation();
  const requestCandidate = discoverObservedApiRequests({ observation: page, networkActivity: [request()], ...scope }).candidates[0];
  const stale = await inspectObservedApiCandidate({ candidate: requestCandidate, observation: { ...page, documentGeneration: 8 }, observer: {} });
  assert.deepEqual(stale, { status: "blocked", reasonCode: "api_candidate_scope_mismatch" });

  const mismatched = await inspectObservedApiCandidate({
    candidate: requestCandidate,
    observation: page,
    observer: { async inspectNetworkResponse() {
      return { status: "available", request: request({ url: "https://app.example.test/api/other" }), responseBody: { status: "included", format: "json", hasMore: false, data: "[]" } };
    } }
  });
  assert.deepEqual(mismatched, { status: "blocked", reasonCode: "selected_response_identity_mismatch" });
});
