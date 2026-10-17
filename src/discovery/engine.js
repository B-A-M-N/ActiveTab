/**
 * Application discovery engine - progressive, evidence-driven exploration
 * of an unfamiliar application starting from a passive observation.
 */

import { ApplicationCapabilityMap } from "./capabilityMap.js";
import { KnowledgeStore } from "./knowledgeStore.js";
import { URL } from "node:url";
import { authorizePlannedAction } from "../navigation/actionPolicy.js";

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
  constructor({ session, maxSteps = 8, maxLinksPerStep = 4, signal, knowledgeDir = null } = {}) {
    this.session = session;
    this.maxSteps = Math.max(1, Math.min(maxSteps, MAX_DISCOVERY_STEPS));
    this.maxLinksPerStep = Math.max(1, Math.min(maxLinksPerStep, MAX_LINKS_PER_STEP));
    this.signal = signal;
    this.knowledgeStore = knowledgeDir ? new KnowledgeStore(knowledgeDir) : null;
    this.discoveries = [];
    this.visitedUrls = new Set();
    this.capabilityMap = null;
    this.reusedKnowledge = null;
  }

  async discover() {
    if (!this.session) throw new Error("ApplicationDiscoveryEngine requires a browser session.");
    let observation = await this.session.observe();
    if (!observation?.page?.url) throw new Error("Initial observation did not return a page URL.");

    const origin = new URL(observation.page.url).origin;
    this.capabilityMap = new ApplicationCapabilityMap({ applicationId: origin, origin });
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
        try {
          if (typeof target.href === "string" && target.href) {
            await this.session.client.send("Page.navigate", { url: target.href });
          } else {
            // For buttons/menu items/tabs without hrefs, use the authorized
            // click path which validates target freshness and visibility.
            await this.session.click(target);
          }
          await this.session.waitForChange(3_000);
          const postObservation = await this.session.observe();
          if (postObservation?.page?.url) {
            this.visitedUrls.add(postObservation.page.url);
            await this.#recordObservation(postObservation);
            this.discoveries.push({ type: "navigated", from: currentUrl, to: postObservation.page.url, control: target.name.slice(0, 100) });
            currentUrl = postObservation.page.url;
            navigated++;
            observation = postObservation;
          }
        } catch (error) {
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
    return {
      discoveries: this.discoveries,
      capabilityMap: this.capabilityMap.toObject(),
      visitedCount: this.visitedUrls.size,
      stepCount: this.discoveries.filter(d => d.type === "navigated").length,
      reusedKnowledge: this.reusedKnowledge,
      savedKnowledge
    };
  }

  #isSideEffectingRoute(url) {
    const SENSITIVE_PATTERNS = [
      /\b(?:logout|log.?out|sign.?out|deactivate|delete|remove|destroy|revoke|cancel)\b/i,
      /\b(?:unsubscribe|account.?delete|settings.?delete)\b/i,
      /\b(?:admin|configuration)\b.*\b(?:edit|delete|create|update)\b/i
    ];
    return SENSITIVE_PATTERNS.some(pattern => pattern.test(url));
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
