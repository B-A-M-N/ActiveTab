import test from "node:test";
import assert from "node:assert/strict";
import { createEvidenceReleaseTools } from "../src/mcp/evidenceReleaseTools.js";

function fixture({ grantValid = true, hasScreenshot = false, responseBody = { data: "redacted body", status: "included" } } = {}) {
  const calls = { requests: [], verifications: [], charges: [], inspections: [], evidenceReads: [], runtimeReads: [] };
  const imageContentKey = Symbol("mcp-image-content");
  const selected = {
    status: "available",
    coverage: { screenshot: hasScreenshot },
    page: { url: "https://app.example/account" }
  };
  const session = {
    target: { id: "target-a" },
    observer: {
      getEvidence(evidenceId, options) {
        calls.evidenceReads.push({ evidenceId, options });
        if (options.includeScreenshot === true) return { status: "available", screenshotBase64: "jpeg-base64" };
        if (options.includeSensitiveFormValues === true) return { status: "available", formValues: [{ value: "private-form-value" }] };
        return selected;
      },
      async inspectNetworkResponse(evidenceId, options) {
        calls.inspections.push({ evidenceId, options });
        return { status: "available", responseBody: { available: true, ...responseBody } };
      },
      async inspectRuntimeState(evidenceId, options) {
        calls.runtimeReads.push({ evidenceId, options });
        return { status: "available" };
      }
    }
  };
  const store = {
    request(request) {
      calls.requests.push(request);
      return { requestId: "grant-request", state: "pending" };
    },
    verifyMany(entries) {
      calls.verifications.push(entries);
      return grantValid ? { ok: true } : { ok: false, reason: "grant scope mismatch" };
    },
    chargeMany(entries, bytes) {
      calls.charges.push({ entries, bytes });
      return { ok: true };
    }
  };
  const tools = createEvidenceReleaseTools({
    store,
    principalId: "principal-a",
    callerInstanceId: "mcp-instance-a",
    loadEnvironmentProfile: async profileId => ({
      profile: { profile_id: profileId },
      environment: { profileId, environmentId: "staging" }
    }),
    imageContentKey,
    serializeResult(value) {
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
        ...(value?.[imageContentKey] ? { images: value[imageContentKey] } : {})
      };
    },
    resolveApplication: () => ({ status: "matched", applicationId: "app-a", authenticationRealm: "realm-a" })
  });
  return { calls, tools, session };
}

test("evidence release requests bind selected response scope and never issue a grant", async () => {
  const { calls, tools, session } = fixture();
  const result = await tools.requestEvidenceRelease(session, {
    profileId: "profile-a",
    evidenceId: "evidence-a",
    facet: "response_body",
    requestId: "request-a",
    view: "markdown",
    sectionId: "section-a",
    byteBudget: 500
  });

  assert.equal(result.operatorApprovalRequired, true);
  assert.equal(result.tokenReturned, false);
  assert.deepEqual(calls.inspections[0].options, {
    requestId: "request-a", includeSensitive: false, includeSensitiveUrlData: false
  });
  assert.deepEqual(calls.requests[0], {
    targetId: "target-a",
    evidenceId: "evidence-a",
    facet: "response_body",
    principalId: "principal-a",
    callerInstanceId: "mcp-instance-a",
    selectors: {
      profileId: "profile-a", environmentId: "staging", applicationId: "app-a",
      authenticationRealm: "realm-a", requestId: "request-a", view: "markdown", sectionId: "section-a"
    },
    maxBytes: 500,
    expiresInMs: 5 * 60 * 1000
  });
});

test("raw response credentials are not read unless both exact grants verify", async () => {
  const denied = fixture({ grantValid: false });
  await assert.rejects(() => denied.tools.releaseEvidence(denied.session, {
    profileId: "profile-a", evidenceId: "evidence-a", facet: "response_credential_values",
    requestId: "request-a", grantToken: "body-token", credentialGrantToken: "credential-token"
  }), /grant scope mismatch/);
  assert.equal(denied.calls.inspections.length, 0, "no response body read occurs after grant refusal");
  assert.equal(denied.calls.verifications[0].length, 2);
  assert.deepEqual(denied.calls.verifications[0].map(entry => entry.scope.facet), [
    "response_body", "response_credential_values"
  ]);

  const missing = fixture();
  await assert.rejects(() => missing.tools.releaseEvidence(missing.session, {
    profileId: "profile-a", evidenceId: "evidence-a", facet: "response_credential_values",
    requestId: "request-a", grantToken: "body-token"
  }), /Raw response credentials require a separately approved credential grant/);
  assert.equal(missing.calls.verifications.length, 0);
  assert.equal(missing.calls.inspections.length, 0);
});

test("approved dual grants release selected raw credentials and charge the returned MCP representation", async () => {
  const { calls, tools, session } = fixture({ responseBody: { data: "token=clear-value", status: "included" } });
  const result = await tools.releaseEvidence(session, {
    profileId: "profile-a", evidenceId: "evidence-a", facet: "response_credential_values",
    requestId: "request-a", view: "source", grantToken: "body-token", credentialGrantToken: "credential-token",
    offset: 4, maxBytes: 128
  });

  assert.equal(result.responseBody.data, "token=clear-value");
  assert.equal(result.responseBody.credentialValuesIncluded, true);
  assert.deepEqual(calls.inspections[0].options, {
    requestId: "request-a", includeSensitive: true, includeCredentialValues: true,
    includeSensitiveUrlData: false, view: "source", offset: 4, maxBytes: 128
  });
  assert.deepEqual(calls.charges[0].entries.map(entry => entry.scope.facet), [
    "response_body", "response_credential_values"
  ]);
  assert.ok(calls.charges[0].bytes > Buffer.byteLength(JSON.stringify(result)));
});

test("approved screenshot, form, and runtime releases preserve their exact facet options", async () => {
  const { calls, tools, session } = fixture({ hasScreenshot: true });
  const screenshot = await tools.releaseEvidence(session, {
    profileId: "profile-a", evidenceId: "evidence-a", facet: "screenshot", grantToken: "screenshot-token"
  });
  assert.equal(screenshot.screenshotReleased, true);
  assert.equal(Object.hasOwn(screenshot, "screenshotBase64"), false);
  assert.deepEqual(screenshot[Object.getOwnPropertySymbols(screenshot)[0]], [{ data: "jpeg-base64", mimeType: "image/jpeg" }]);
  assert.ok(calls.charges[0].bytes > Buffer.byteLength(JSON.stringify(screenshot)));

  const form = await tools.releaseEvidence(session, {
    profileId: "profile-a", evidenceId: "evidence-a", facet: "form_values", grantToken: "form-token",
    facets: ["domSnapshot"]
  });
  assert.equal(form.formValues[0].value, "private-form-value");
  assert.deepEqual(calls.evidenceReads.at(-1).options, { facets: ["domSnapshot"], includeSensitiveFormValues: true });

  await tools.releaseEvidence(session, {
    profileId: "profile-a", evidenceId: "evidence-a", facet: "runtime_values", grantToken: "runtime-token",
    path: ["account", "name"], frameTargetId: "frame-a", offset: 12, maxChars: 64
  });
  assert.deepEqual(calls.runtimeReads.at(-1).options, {
    path: ["account", "name"], frameTargetId: "frame-a", includeSensitiveValues: true, offset: 12, maxChars: 64
  });
  assert.deepEqual(calls.verifications.map(entries => entries[0].scope.facet), ["screenshot", "form_values", "runtime_values"]);
});
