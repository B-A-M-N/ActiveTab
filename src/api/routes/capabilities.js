import { randomUUID } from "node:crypto";

/** Handle capability endpoints after the local API's common auth and origin gates. */
export function createCapabilityRoutes({
  executorReady,
  navigationRunner,
  capabilityRegistry,
  capabilityService,
  readBody,
  sendJson,
  sendError
} = {}) {
  return async function handleCapabilityRoute(req, res, { method, path } = {}) {
    if (method === "GET" && path === "/v3/capabilities") {
      const items = (capabilityService?.registry?.list?.() ?? capabilityRegistry?.list?.() ?? []).map(manifest => ({
        capability_id: manifest.capabilityId,
        version: manifest.capabilityVersion,
        kind: manifest.kind,
        application_id: manifest.applicationId,
        environment_id: manifest.environmentId,
        origin: manifest.origin,
        page_path: manifest.pagePath,
        output_schema: manifest.extractionContract.fields.map(field => ({
          name: field.name,
          type: field.type,
          required: field.required,
          data_class: field.dataClass,
          ...(field.sourceHeader ? { source_header: field.sourceHeader } : {}),
          ...(field.sourceKey ? { source_key: field.sourceKey, source_tag: field.sourceTagName } : {})
        })),
        completion_policy: manifest.extractionContract.completionPolicy,
        ...(manifest.extractionContract.expectedRecords === undefined ? {} : { expected_records: manifest.extractionContract.expectedRecords }),
        min_records: manifest.extractionContract.minRecords ?? 1,
        unique_by: manifest.extractionContract.uniqueBy,
        ...(manifest.extractionContract.pagination ? { pagination: manifest.extractionContract.pagination } : {}),
        qualification: manifest.qualification
      }));
      sendJson(res, 200, { items });
      return true;
    }

    if (method === "POST" && path === "/v3/capabilities/revoke") {
      const body = await readBody(req) ?? {};
      const allowedFields = new Set(["capability_id", "version", "origin", "environment_id", "application_id", "principal_id", "reason_code"]);
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some(key => !allowedFields.has(key))
        || [...allowedFields].some(key => !Object.hasOwn(body, key))) {
        sendError(res, 400, 99001, "Capability revocation requires the exact registered scope and a reason code.");
        return true;
      }
      const revoke = capabilityService?.revoke
        ? (identity, options) => capabilityService.revoke(identity, options)
        : capabilityRegistry?.revoke
          ? (identity, options) => capabilityRegistry.revoke(identity, options)
          : null;
      if (!revoke) {
        sendError(res, 503, 99503, "Capability revocation is unavailable on this server.");
        return true;
      }
      const result = await revoke({
        capabilityId: body.capability_id,
        capabilityVersion: body.version,
        origin: body.origin,
        environmentId: body.environment_id,
        applicationId: body.application_id,
        principalId: body.principal_id
      }, { reasonCode: body.reason_code });
      if (result.status === "not_found") {
        sendError(res, 404, 99404, "No active capability matches the exact supplied scope.");
        return true;
      }
      sendJson(res, 200, result);
      return true;
    }

    if (method === "POST" && path === "/v3/capabilities/network/discover") {
      if (!executorReady || typeof navigationRunner.discoverObservedApis !== "function") {
        sendError(res, 503, 99503, "Observed API discovery is unavailable on this server.");
        return true;
      }
      const input = await readBody(req) ?? {};
      const result = await navigationRunner.discoverObservedApis({ input, req, templateId: "observed-api-discovery", taskId: randomUUID() });
      sendJson(res, 200, result);
      return true;
    }

    const inspectObservedApiMatch = method === "POST" && path.match(/^\/v3\/capabilities\/network\/candidates\/([0-9a-f-]{36})\/inspect$/);
    if (inspectObservedApiMatch) {
      if (!executorReady || typeof navigationRunner.inspectObservedApi !== "function") {
        sendError(res, 503, 99503, "Observed API inspection is unavailable on this server.");
        return true;
      }
      const input = await readBody(req) ?? {};
      const result = await navigationRunner.inspectObservedApi(inspectObservedApiMatch[1], {
        input,
        req,
        targetId: input.target_id,
        templateId: "observed-api-inspection",
        taskId: randomUUID()
      });
      sendJson(res, 200, result);
      return true;
    }

    const qualifyObservedApiMatch = method === "POST" && path.match(/^\/v3\/capabilities\/network\/candidates\/([0-9a-f-]{36})\/qualify$/);
    if (qualifyObservedApiMatch) {
      if (!executorReady || typeof navigationRunner.qualifyObservedApi !== "function") {
        sendError(res, 503, 99503, "Observed API qualification is unavailable on this server.");
        return true;
      }
      const body = await readBody(req) ?? {};
      const result = await navigationRunner.qualifyObservedApi(qualifyObservedApiMatch[1], {
        variants: body.variants ?? 30,
        ...(req.signal ? { signal: req.signal } : {})
      }, { req });
      sendJson(res, 200, result);
      return true;
    }

    if (method === "POST" && path === "/v3/capabilities/discover") {
      if (!executorReady || typeof navigationRunner.discoverCapabilities !== "function") {
        sendError(res, 503, 99503, "Capability discovery is unavailable on this server.");
        return true;
      }
      const input = await readBody(req) ?? {};
      const result = await navigationRunner.discoverCapabilities({ input, req, templateId: "capability-discovery", taskId: randomUUID() });
      sendJson(res, 200, result);
      return true;
    }

    if (method === "POST" && path === "/v3/capabilities/read") {
      if (!executorReady || typeof navigationRunner.readObservedRecords !== "function") {
        sendError(res, 503, 99503, "Ephemeral read-only extraction is unavailable on this server.");
        return true;
      }
      const body = await readBody(req) ?? {};
      const allowed = new Set(["candidate_id", "fields", "max_records", "unique_by"]);
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some(key => !allowed.has(key))
        || !Array.isArray(body.fields) || body.fields.length < 1 || body.fields.length > 32
        || (body.max_records !== undefined && (!Number.isInteger(body.max_records) || body.max_records < 1 || body.max_records > 1000))
        || (body.unique_by !== undefined && (!Array.isArray(body.unique_by) || body.unique_by.length > 8))) {
        sendError(res, 400, 99001, "Read-only extraction requires bounded fields, max_records, and unique_by values.");
        return true;
      }
      const result = await navigationRunner.readObservedRecords({
        ...(body.candidate_id ? { candidateId: body.candidate_id } : {}),
        requestedFields: body.fields,
        maxRecords: body.max_records ?? 100,
        uniqueBy: body.unique_by ?? []
      }, { input: body, req, templateId: "ephemeral-page-data-read", taskId: randomUUID() });
      sendJson(res, 200, result);
      return true;
    }

    if (method === "POST" && path === "/v3/capabilities/compile") {
      if (!executorReady || typeof navigationRunner.compileCapability !== "function") {
        sendError(res, 503, 99503, "Capability compilation is unavailable on this server.");
        return true;
      }
      const body = await readBody(req) ?? {};
      const result = await navigationRunner.compileCapability({
        candidateId: body.candidate_id,
        capabilityId: body.capability_id,
        capabilityVersion: body.capability_version ?? 1,
        fields: body.fields,
        maxRecords: body.max_records,
        minRecords: body.min_records ?? 1,
        expectedRecords: body.expected_records,
        completionPolicy: body.completion_policy ?? "exact_count",
        uniqueBy: body.unique_by ?? [],
        ...(body.pagination ? { pagination: body.pagination } : {})
      }, { req, templateId: "capability-compile" });
      sendJson(res, 200, result);
      return true;
    }

    const qualifyCapabilityMatch = method === "POST" && path.match(/^\/v3\/capabilities\/recipes\/([0-9a-f-]{36})\/qualify$/);
    if (qualifyCapabilityMatch) {
      if (!executorReady || typeof navigationRunner.qualifyCapability !== "function") {
        sendError(res, 503, 99503, "Capability qualification is unavailable on this server.");
        return true;
      }
      const body = await readBody(req) ?? {};
      const result = await navigationRunner.qualifyCapability(qualifyCapabilityMatch[1], {
        variants: body.variants ?? 30,
        ...(req.signal ? { signal: req.signal } : {})
      }, { req });
      sendJson(res, 200, result);
      return true;
    }

    return false;
  };
}
