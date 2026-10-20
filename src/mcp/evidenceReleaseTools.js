import { resolveObservedApplication } from "../environments/model.js";

export function createEvidenceReleaseTools({
  store,
  principalId,
  callerInstanceId,
  loadEnvironmentProfile,
  imageContentKey,
  serializeResult,
  resolveApplication = resolveObservedApplication
}) {
  function selectorsFor(facet, args, environmentScope) {
    const selectors = { ...environmentScope };
    if (facet === "form_values") selectors.facets = args.facets;
    if (facet === "runtime_values") {
      selectors.path = args.path;
      if (args.frameTargetId !== undefined) selectors.frameTargetId = args.frameTargetId;
    }
    if (facet === "response_body" || facet === "response_credential_values") {
      selectors.requestId = args.requestId;
      selectors.view = args.view ?? "markdown";
      if (args.sectionId !== undefined) selectors.sectionId = args.sectionId;
      if (args.blockId !== undefined) selectors.blockId = args.blockId;
    }
    return selectors;
  }

  async function resolveBinding(session, evidenceId, profileId) {
    const selected = session.observer.getEvidence(evidenceId, { facets: ["page"] });
    if (selected?.status !== "available") throw new Error("The selected evidence is not retained on this exact target.");
    const loaded = await loadEnvironmentProfile(profileId);
    if (!loaded) throw new Error("Sensitive evidence release requires an explicit local profileId.");
    const application = resolveApplication(loaded.environment, selected.page?.url ?? "");
    if (application.status !== "matched") throw new Error(`Selected evidence does not resolve to one profile-bound application: ${application.reason ?? application.status}.`);
    return {
      selected,
      environmentScope: {
        profileId: loaded.environment.profileId,
        environmentId: loaded.environment.environmentId,
        applicationId: application.applicationId,
        authenticationRealm: application.authenticationRealm ?? null
      }
    };
  }

  async function requestEvidenceRelease(session, args) {
    const { selected, environmentScope } = await resolveBinding(session, args.evidenceId, args.profileId);
    const facet = args.facet;
    if (facet === "screenshot" && selected.coverage?.screenshot !== true) throw new Error("The selected evidence has no retained screenshot; capture it with observe_page profile:'visual' first.");
    if (facet === "form_values") {
      const formEvidence = session.observer.getEvidence(args.evidenceId, { facets: args.facets });
      if (formEvidence?.status !== "available") throw new Error("Selected form-capable evidence is unavailable.");
    }
    if (facet === "runtime_values") {
      const runtime = await session.observer.inspectRuntimeState(args.evidenceId, {
        path: args.path ?? [], frameTargetId: args.frameTargetId ?? null, includeSensitiveValues: false
      });
      if (runtime?.status !== "available") throw new Error(`Selected runtime value is ${runtime?.status ?? "unavailable"}.`);
    }
    if (facet === "response_body" || facet === "response_credential_values") {
      const response = await session.observer.inspectNetworkResponse(args.evidenceId, {
        requestId: args.requestId, includeSensitive: false, includeSensitiveUrlData: false
      });
      if (response?.status !== "available" || response.responseBody?.available !== true) throw new Error("The selected response body is unavailable for release.");
    }
    const request = store.request({
      targetId: session.target.id,
      evidenceId: args.evidenceId,
      facet,
      principalId,
      callerInstanceId,
      selectors: selectorsFor(facet, args, environmentScope),
      maxBytes: args.byteBudget,
      expiresInMs: args.expiresInMs ?? 5 * 60 * 1000
    });
    return { ...request, operatorApprovalRequired: true, tokenReturned: false };
  }

  async function releaseEvidence(session, args) {
    const { selected, environmentScope } = await resolveBinding(session, args.evidenceId, args.profileId);
    const facet = args.facet;
    const scope = {
      targetId: session.target.id,
      evidenceId: args.evidenceId,
      facet,
      principalId,
      callerInstanceId,
      selectors: selectorsFor(facet, args, environmentScope)
    };
    const entries = [{ token: args.grantToken, scope }];
    const responseFacet = facet === "response_body" || facet === "response_credential_values";
    let includeCredentialValues = false;
    if (responseFacet) {
      const credentialScope = { ...scope, facet: "response_credential_values" };
      const bodyScope = { ...scope, facet: "response_body" };
      entries[0].scope = bodyScope;
      if (facet === "response_credential_values") {
        if (typeof args.credentialGrantToken !== "string") throw new Error("Raw response credentials require a separately approved credential grant as well as the response-body grant.");
        entries.push({ token: args.credentialGrantToken, scope: credentialScope });
        includeCredentialValues = true;
      } else if (args.credentialGrantToken !== undefined) {
        entries.push({ token: args.credentialGrantToken, scope: credentialScope });
        includeCredentialValues = true;
      }
    } else if (args.credentialGrantToken !== undefined) {
      throw new Error("A credential grant token applies only to a selected response body.");
    }
    const verified = store.verifyMany(entries);
    if (!verified.ok) throw new Error(verified.reason);

    let result;
    let imageData = null;
    if (facet === "screenshot") {
      result = session.observer.getEvidence(args.evidenceId, { facets: [], includeScreenshot: true });
      if (result?.status !== "available" || typeof result.screenshotBase64 !== "string") throw new Error("The approved screenshot is no longer retained.");
      imageData = result.screenshotBase64;
      delete result.screenshotBase64;
      result.screenshotReleased = true;
    } else if (facet === "form_values") {
      result = session.observer.getEvidence(args.evidenceId, { facets: args.facets, includeSensitiveFormValues: true });
      if (result?.status !== "available") throw new Error("The approved form evidence is no longer retained.");
    } else if (facet === "runtime_values") {
      result = await session.observer.inspectRuntimeState(args.evidenceId, {
        path: args.path ?? [], frameTargetId: args.frameTargetId ?? null, includeSensitiveValues: true,
        offset: args.offset ?? 0, maxChars: args.maxChars
      });
      if (result?.status !== "available") throw new Error(`The approved runtime value is ${result?.status ?? "unavailable"}.`);
    } else if (responseFacet) {
      result = await session.observer.inspectNetworkResponse(args.evidenceId, {
        requestId: args.requestId,
        includeSensitive: true,
        includeCredentialValues,
        includeSensitiveUrlData: false,
        view: args.view ?? "markdown",
        offset: args.offset ?? 0,
        maxBytes: args.maxBytes ?? 32 * 1024,
        ...(args.sectionId !== undefined ? { sectionId: args.sectionId } : {}),
        ...(args.blockId !== undefined ? { blockId: args.blockId } : {})
      });
      if (result?.status !== "available" || result.responseBody?.status !== "included") throw new Error("The approved response-body selection is unavailable or incomplete.");
      result.responseBody.credentialValuesIncluded = includeCredentialValues;
    } else throw new Error("Evidence-release facet is unsupported.");

    if (imageData !== null) Object.defineProperty(result, imageContentKey, { value: [{ data: imageData, mimeType: "image/jpeg" }] });
    // Charge the actual MCP representation, which contains both textual and
    // structured forms (and one base64 image block for screenshot releases).
    const releasedBytes = Buffer.byteLength(JSON.stringify(serializeResult(result))) + 128;
    const charged = store.chargeMany(entries, releasedBytes);
    if (!charged.ok) throw new Error(charged.reason);
    return result;
  }

  return { requestEvidenceRelease, releaseEvidence };
}
