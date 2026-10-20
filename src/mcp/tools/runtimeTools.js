/** Read-only MCP projections of server-owned browser and model readiness. */
export function createRuntimeToolHandlers({ sessions, modelPreflight, workflowStore, env = process.env }) {
  return Object.freeze({
    get_runtime_capabilities: () => {
      const routeFor = roles => roles.map(role => modelPreflight.routes.find(route => route.role === role)).find(Boolean) ?? null;
      const secondary = routeFor(["planner", "semantic", "workflow"]);
      const jev = routeFor(["jev"]);
      const modelRouteStatus = route => !route ? "disabled" : route.status;
      const pageConsent = env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT === "1";
      const screenshotConsent = env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS === "1";
      const configuredModelEndpoint = Boolean(env.ACTIVETAB_MODEL_ENDPOINT || env.ACTIVETAB_SEMANTIC_ENDPOINT || env.ACTIVETAB_WORKFLOW_ENDPOINT);
      const plannerStatus = !configuredModelEndpoint ? "disabled"
        : !pageConsent ? "requires_consent"
          : modelRouteStatus(secondary);
      const imageStatus = (route, optedIn) => !route || route.imageCapability !== true ? "unavailable"
        : !screenshotConsent || !optedIn ? "requires_consent"
          : route.status;
      const attachedTargetIds = [...sessions.entries()].filter(([, session]) => session?.attached === true).map(([targetId]) => targetId).sort();
      return {
        browser: { status: attachedTargetIds.length ? "attached" : "requires_target_attachment", attachedTargetCount: attachedTargetIds.length, targetIds: attachedTargetIds },
        navigation: { status: "requires_profile", reasonCode: "navigation_scope_required" },
        planning: { status: plannerStatus, reasonCode: plannerStatus === "requires_consent" ? "model_page_content_consent_required" : plannerStatus === "disabled" ? "provider_unavailable" : null, model: secondary?.model ?? null, preflight: secondary?.status ?? "not_configured", preflightKind: "authenticated_catalog_only", inferenceReachability: secondary?.inferenceReachability ?? "not_configured", pageContentConsent: pageConsent },
        visual: {
          secondary: { status: imageStatus(secondary, true), model: secondary?.model ?? null, catalogSupportsImages: secondary?.imageCapability === true, screenshotConsent },
          jev: { status: imageStatus(jev, env.ACTIVETAB_JEV_ALLOW_IMAGES === "1"), model: jev?.model ?? null, catalogSupportsImages: jev?.imageCapability === true, screenshotConsent }
        },
        jev: { status: modelRouteStatus(jev), model: jev?.model ?? null, preflight: jev?.status ?? "not_configured", preflightKind: "authenticated_catalog_only", inferenceReachability: jev?.inferenceReachability ?? "not_configured" },
        forms: { status: "requires_profile_operation_contract", reasonCode: "operation_not_admitted" },
        extraction: { status: "requires_profile_field_policy", reasonCode: "extraction_field_policy_required" },
        workflowReuse: { status: workflowStore ? "available" : "disabled" },
        modelPreflight: { status: modelPreflight.status, telemetryRecorded: modelPreflight.telemetryRecorded === true }
      };
    }
  });
}
