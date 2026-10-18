/**
 * Application discovery engine - progressive, evidence-driven exploration
 * of an unfamiliar application starting from a passive observation.
 */

import { ApplicationCapabilityMap } from "./capabilityMap.js";
import { KnowledgeStore } from "./knowledgeStore.js";
import { URL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { authorizePlannedAction } from "../navigation/actionPolicy.js";
import { verifyObservedUrl } from "../environments/model.js";
import { sanitizeUrl } from "../browser/urlPrivacy.js";
import { isOperatorProhibitedNavigation } from "../runtime/controlRestrictions.js";
import { executeAuthorizedAction } from "../runtime/authorizedExecutor.js";
import { adjudicatePreActionReview } from "../decisions/adjudication.js";

const SAFE_CONTROL_ROLES = new Set(["link", "tab", "button", "menuitem", "menuitemradio", "menuitemcheckbox"]);
const SAFE_SUBMIT_CONTROLS = false;
const MAX_DISCOVERY_STEPS = 16;
const MAX_LINKS_PER_STEP = 6;

function isSafeToNavigate(control) {
  if (!control || typeof control !== "object") return false;
  if (control.disabled === true) return false;
  if (!SAFE_CONTROL_ROLES.has(control.role)) return false;
  if (typeof control.href !== "string" || !control.href) return false;
  try {
    const url = new URL(control.href);
    if (!["http:", "https:"].includes(url.protocol)) return false;
  } catch { return false; }
  return true;
}

export class ApplicationDiscoveryEngine {
  constructor({ session, maxSteps = 8, maxLinksPerStep = 4, signal, knowledgeDir = null, environment = null, decisionRuntime = null, onAuthorizationBoundary = null, assertExecutionLease = null } = {}) {
    this.session = session;
    this.maxSteps = Math.max(1, Math.min(maxSteps, MAX_DISCOVERY_STEPS));
    this.maxLinksPerStep = Math.max(1, Math.min(maxLinksPerStep, MAX_LINKS_PER_STEP));
    this.signal = signal;
    this.knowledgeStore = knowledgeDir ? new KnowledgeStore(knowledgeDir) : null;
    // Verified platform/environment binding (P1-3): cross-origin application
    // transitions are verified against the environment's authorized origins;
    // new authorization boundaries pause discovery instead of being bypassed.
    this.environment = environment;
    this.decisionRuntime = decisionRuntime;
    this.onAuthorizationBoundary = onAuthorizationBoundary;
    this.assertExecutionLease = assertExecutionLease;
    this.discoveries = [];
    this.visitedUrls = new Set();
    this.capabilityMap = null;
    this.reusedKnowledge = null;
  }

  async discover() {
    if (!this.session) throw new Error("ApplicationDiscoveryEngine requires a browser session.");
    if (this.session.attached === true && this.session.target?.id && typeof this.assertExecutionLease !== "function") {
      throw new Error("Application discovery requires a durable browser target execution lease.");
    }
    let observation = await this.session.observe();
    if (!observation?.page?.url) throw new Error("Initial observation did not return a page URL.");

    const origin = new URL(observation.page.url).origin;
    const runId = randomUUID();
    const environmentId = String(this.environment?.environmentId ?? "").toLowerCase();
    const environmentClass = this.environment?.environmentClass
      ?? (environmentId.includes("production") ? "production" : environmentId.includes("staging") ? "staging" : environmentId ? "local" : "unknown");
    const configuredApplicationId = this.environment?.applications?.find(application => application.origin === origin)?.applicationId;
    const applicationId = typeof configuredApplicationId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(configuredApplicationId)
      ? configuredApplicationId
      : `app_${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`;
    const episode = this.decisionRuntime?.startEpisode({
      runId,
      workflowId: "application_discovery",
      applicationId,
      environmentClass,
      executionMode: "agent_directed",
      policyVersion: "active_policy_v1",
      workflowKind: "application_discovery"
    });
    this.capabilityMap = new ApplicationCapabilityMap({
      applicationId: origin,
      origin,
      ...(this.environment ? { platform: this.environment.platform, environmentId: this.environment.environmentId } : {})
    });
    this.visitedUrls.add(observation.page.url);
    if (this.knowledgeStore) {
      const prior = await this.knowledgeStore.load(origin).catch(() => null);
      if (prior && typeof prior === "object") {
        this.reusedKnowledge = {
          origin,
          revision: prior.revision ?? null,
          observationCount: prior.observationCount ?? null,
          savedAt: prior.savedAt ?? null,
          stale: true
        };
        this.discoveries.push({ type: "reused_knowledge", origin, revision: prior.revision ?? null, requiresRevalidation: true });
      }
    }

    await this.#recordObservation(observation);
    this.discoveries.push({ type: "initial_observation", url: observation.page.url, title: observation.page.title ?? null });

    let currentUrl = observation.page.url;
    for (let step = 1; step <= this.maxSteps; step++) {
      if (this.signal?.aborted) {
        this.discoveries.push({ type: "aborted", reason: "Run was canceled." });
        break;
      }
      const controls = this.#safeControls(observation);
      const unvisited = controls.filter(control => !this.visitedUrls.has(control.href));
      if (unvisited.length === 0) {
        this.discoveries.push({ type: "no_more_links", url: currentUrl });
        break;
      }
      const targets = unvisited.slice(0, this.maxLinksPerStep);
      let navigated = 0;
      for (const target of targets) {
        if (this.signal?.aborted) break;
        if (this.#isSideEffectingRoute(target.href)) {
          this.discoveries.push({ type: "navigation_skipped_side_effect", url: target.href, control: target.name.slice(0, 100) });
          continue;
        }
        if (isOperatorProhibitedNavigation(target.href)) {
          this.discoveries.push({ type: "navigation_skipped_operator_restriction", url: target.href, control: target.name.slice(0, 100) });
          continue;
        }
        if (this.environment) {
          const destination = (() => {
            try { return new URL(target.href, observation.page.url); }
            catch { return null; }
          })();
          if (!destination || !this.environment.authorizedOrigins.includes(destination.origin)) {
            this.discoveries.push({
              type: "cross_origin_untrusted",
              from: sanitizeUrl(currentUrl, { base: currentUrl }),
              toOrigin: destination?.origin ?? null,
              toPathname: destination?.pathname ?? null,
              observed: false,
              dispatched: false,
              control: target.name.slice(0, 100),
              reasonCode: "destination_origin_not_authorized"
            });
            continue;
          }
        }
        const telemetry = this.decisionRuntime && episode ? {
          decisionId: randomUUID(),
          operationId: randomUUID(),
          stepId: `discovery_step_${step}`,
          beforeEvidenceId: observation.evidenceId
        } : null;
        if (telemetry) {
          try {
            const review = await this.decisionRuntime.reviewBeforeAction({
              episodeId: episode.episodeId,
              runId,
              stepId: telemetry.stepId,
              decisionId: telemetry.decisionId,
              observation,
              operation: "click",
              operationClass: "navigation",
              targetRole: "discovery_navigation_target",
              expectedOutcomeClass: "destination_observed",
              candidate: target,
              signal: this.signal
            });
            const adjudication = adjudicatePreActionReview(review);
            if (!adjudication.allowed) {
              await this.decisionRuntime.recordPolicy({
                episodeId: episode.episodeId,
                runId,
                stepId: telemetry.stepId,
                decisionId: telemetry.decisionId,
                observationId: observation.evidenceId,
                disposition: "deny",
                reasonCode: "jev_review_required"
              });
              this.discoveries.push({ type: "decision_review_required", control: target.name.slice(0, 100), category: adjudication.category });
              continue;
            }
            await this.decisionRuntime.recordPolicy({
              episodeId: episode.episodeId,
              runId,
              stepId: telemetry.stepId,
              decisionId: telemetry.decisionId,
              observationId: observation.evidenceId,
              disposition: "allow",
              reasonCode: "discovery_navigation_admitted"
            });
            await this.decisionRuntime.reserveExecution({
              episodeId: episode.episodeId,
              runId,
              stepId: telemetry.stepId,
              decisionId: telemetry.decisionId,
              observationId: observation.evidenceId,
                operation: "click",
              targetRole: "discovery_navigation_target",
              operationId: telemetry.operationId
            });
          } catch (error) {
            this.discoveries.push({ type: "telemetry_admission_failed", control: target.name.slice(0, 100), reason: String(error?.message ?? error).slice(0, 200) });
            continue;
          }
        }
        let actionDispatched = false;
        try {
          const hasLinkDestination = typeof target.href === "string" && target.href.length > 0;
          if (!hasLinkDestination && typeof this.session.click !== "function") {
            // Scripted/observation-only sessions cannot click; record and
            // move on rather than fabricating a navigation.
            this.discoveries.push({ type: "click_unsupported", control: target.name.slice(0, 100) });
            continue;
          }
          if (hasLinkDestination && typeof this.session.click !== "function") {
            this.discoveries.push({ type: "click_unsupported", control: target.name.slice(0, 100), reasonCode: "native_link_click_unavailable" });
            continue;
          }
          const dispatch = await executeAuthorizedAction({
            session: this.session,
            environment: this.environment,
            assertExecutionLease: this.assertExecutionLease,
            // Follow the observed link through the exact candidate and the
            // central executor. Page.navigate would discard link identity
            // and could turn untrusted page content into a URL command.
            action: "click",
            candidate: target,
            goal: "safe_navigation_discovery"
          });
          if (!dispatch.dispatched) {
            const dispatchStatus = dispatch.authorized ? "uncertain" : "refused";
            if (telemetry) {
              try {
                this.decisionRuntime.recordDispatch({
                  episodeId: episode.episodeId,
                  runId,
                  stepId: telemetry.stepId,
                  decisionId: telemetry.decisionId,
                  observationId: telemetry.beforeEvidenceId,
                  operation: "click",
                  targetRole: "discovery_navigation_target",
                  operationId: telemetry.operationId,
                  dispatchStatus
                });
              } catch { /* retain the refusal or uncertainty even if telemetry fails */ }
            }
            this.discoveries.push({
              type: dispatch.authorized ? "navigation_dispatch_uncertain" : "navigation_refused",
              control: target.name.slice(0, 100),
              category: dispatch.category ?? "unknown"
            });
            continue;
          }
          actionDispatched = true;
          if (telemetry) {
            try {
              this.decisionRuntime.recordDispatch({
                episodeId: episode.episodeId,
                runId,
                stepId: telemetry.stepId,
                decisionId: telemetry.decisionId,
                observationId: telemetry.beforeEvidenceId,
                operation: "click",
                targetRole: "discovery_navigation_target",
                operationId: telemetry.operationId,
                dispatchStatus: "dispatched"
              });
            } catch { /* dispatch already happened; retain the browser flow */ }
          }
          await this.session.waitForChange(3_000);
          const postObservation = await this.session.observe();
          if (postObservation?.page?.url) {
            if (telemetry) {
              try {
                this.decisionRuntime.recordObserved({
                  episodeId: episode.episodeId,
                  runId,
                  stepId: telemetry.stepId,
                  decisionId: telemetry.decisionId,
                  observationId: postObservation.evidenceId,
                  outcomeClass: "discovery_destination_observed",
                  changed: postObservation.pageChangeFingerprint !== observation.pageChangeFingerprint,
                  evidenceRefs: [telemetry.beforeEvidenceId, postObservation.evidenceId]
                });
              } catch { /* retain the observed discovery result */ }
            }
            // Cross-origin application transition (P1-3): verify the target
            // belongs to the intended platform; never automatically trust
            // arbitrary cross-origin links. A new authorization boundary
            // pauses discovery rather than being bypassed.
            if (this.environment) {
              const verified = verifyObservedUrl(this.environment, postObservation.page.url);
              const childOrigin = new URL(postObservation.page.url).origin;
              const crossedOrigin = childOrigin !== new URL(currentUrl).origin;
              if (crossedOrigin) {
                this.capabilityMap.recordChildApplication({
                  applicationId: childOrigin,
                  origin: childOrigin,
                  entryFrom: currentUrl
                });
                if (!verified.ok) {
                  this.discoveries.push({ type: "cross_origin_untrusted", from: currentUrl, to: postObservation.page.url, reason: verified.reason });
                  // Stop: the destination is outside the verified platform.
                  break;
                }
                this.capabilityMap.markChildVerified(childOrigin);
                this.discoveries.push({ type: "cross_origin_verified", from: currentUrl, to: postObservation.page.url });
              }
              // Detect a new authentication boundary (login/consent screen at
              // a different realm) and pause instead of bypassing it.
              const { classifyHumanHandoff } = await import("../navigation/handoff.js");
              const handoff = classifyHumanHandoff(postObservation);
              if (handoff && (handoff.category === "authentication" || handoff.category === "anti_automation")) {
                this.discoveries.push({ type: "authorization_boundary", url: postObservation.page.url, category: handoff.category, reason: handoff.reason });
                if (typeof this.onAuthorizationBoundary === "function") {
                  await this.onAuthorizationBoundary({ url: postObservation.page.url, category: handoff.category, reason: handoff.reason, observation: postObservation });
                }
                observation = postObservation;
                break; // hold at the boundary; a human must authorize/authenticate
              }
            }
            this.visitedUrls.add(postObservation.page.url);
            await this.#recordObservation(postObservation);
            this.discoveries.push({ type: "navigated", from: currentUrl, to: postObservation.page.url, control: target.name.slice(0, 100) });
            currentUrl = postObservation.page.url;
            navigated++;
            observation = postObservation;
          }
        } catch (error) {
          if (telemetry && !actionDispatched) {
            try {
              this.decisionRuntime.recordDispatch({
                episodeId: episode.episodeId,
                runId,
                stepId: telemetry.stepId,
                decisionId: telemetry.decisionId,
                observationId: telemetry.beforeEvidenceId,
                operation: "click",
                targetRole: "discovery_navigation_target",
                operationId: telemetry.operationId,
                dispatchStatus: "uncertain"
              });
            } catch { /* preserve the original dispatch failure */ }
          }
          this.discoveries.push({ type: "navigation_error", url: target.href, reason: String(error?.message ?? error).slice(0, 200) });
        }
        if (navigated >= this.maxLinksPerStep) break;
      }
      if (navigated === 0) {
        this.discoveries.push({ type: "no_safe_navigations", url: currentUrl });
        break;
      }
    }

    let savedKnowledge = null;
    if (this.knowledgeStore) {
      try {
        savedKnowledge = await this.knowledgeStore.save(this.capabilityMap.toObject());
      } catch (error) {
        this.discoveries.push({ type: "knowledge_save_failed", reason: String(error?.message ?? error).slice(0, 200) });
      }
    }
    if (this.decisionRuntime && episode) {
      this.decisionRuntime.completeEpisode({ episodeId: episode.episodeId, runId, status: this.signal?.aborted ? "canceled" : "passed", cleanupStatus: "not_required" });
    }
    return {
      ...(episode ? { runId, decisionEpisodeId: episode.episodeId } : {}),
      discoveries: this.discoveries,
      capabilityMap: this.capabilityMap.toObject(),
      visitedCount: this.visitedUrls.size,
      stepCount: this.discoveries.filter(d => d.type === "navigated").length,
      reusedKnowledge: this.reusedKnowledge,
      savedKnowledge
    };
  }

  #isSideEffectingRoute(url) {
    let pathname;
    try { pathname = new URL(url).pathname; }
    catch { return true; }
    const segments = pathname.normalize("NFKC").toLowerCase().split("/").filter(Boolean);
    const prohibitedSegments = new Set([
      "logout", "log-out", "signout", "sign-out", "deactivate", "delete", "remove", "destroy", "revoke", "cancel", "unsubscribe"
    ]);
    if (segments.some(segment => prohibitedSegments.has(segment))) return true;
    const adminRoots = new Set(["admin", "configuration"]);
    const mutationSegments = new Set(["edit", "delete", "create", "update"]);
    return segments.some((segment, index) => adminRoots.has(segment)
      && segments.slice(index + 1).some(child => mutationSegments.has(child)));
  }

  #safeControls(observation) {
    if (!observation?.candidates) return [];
    return observation.candidates.filter(candidate => {
      if (!candidate.visible || candidate.disabled === true) return false;
      if (candidate.submitsForm === true) return false; // never auto-submit forms
      if (candidate.role && SAFE_CONTROL_ROLES.has(candidate.role)) return true;
      // Links with same-origin hrefs are safe to navigate.
      if (typeof candidate.href === "string" && candidate.href) {
        try {
          return ["http:", "https:"].includes(new URL(candidate.href).protocol) &&
            new URL(candidate.href).origin === new URL(observation.page.url).origin;
        } catch { return false; }
      }
      return false;
    });
  }

  async #recordObservation(observation) {
    if (!this.capabilityMap) return;
    let networkRequests = [];
    const evidenceId = observation?.evidenceId;
    if (evidenceId && this.session?.observer?.getEvidence) {
      const evidence = this.session.observer.getEvidence(evidenceId, { facets: ["networkActivity"] });
      if (evidence?.status === "available" && Array.isArray(evidence.networkActivity)) {
        networkRequests = evidence.networkActivity;
      }
    }
    this.capabilityMap.recordObservation({
      page: observation.page,
      candidates: observation.candidates ?? [],
      headings: observation.headings ?? [],
      frames: observation.frames ?? [],
      networkRequests
    });
  }
}
