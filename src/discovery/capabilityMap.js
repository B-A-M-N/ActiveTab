/**
 * Application capability map — persistent, revision-aware representation
 * of an application\'s structure, built from passive observations.
 */

import { createHash } from "node:crypto";

export const RELATIONSHIP_STRENGTH = Object.freeze({
  HYPOTHESIZED: "hypothesized",
  OBSERVED: "observed",
  CORRELATED: "correlated",
  VERIFIED: "verified"
});

export class ApplicationCapabilityMap {
  constructor({ applicationId, origin } = {}) {
    if (typeof applicationId !== "string" || !applicationId) throw new Error("ApplicationCapabilityMap requires an applicationId.");
    if (typeof origin !== "string" || !origin) throw new Error("ApplicationCapabilityMap requires an origin.");
    this.applicationId = String(applicationId);
    this.origin = String(origin);
    this.revision = 0;
    this.pages = new Map();
    this.controls = new Map();
    this.networkOperations = new Map();
    this.diagnosticSources = new Map();
    this.authBoundaries = new Map();
    this.observationCount = 0;
    this.firstObservedAt = new Date().toISOString();
    this.lastObservedAt = null;
  }

  recordObservation({ page, candidates, headings, frames, networkRequests } = {}) {
    this.observationCount++;
    this.lastObservedAt = new Date().toISOString();
    this.revision++;
    const pageUrl = page?.url;
    if (typeof pageUrl !== "string" || !pageUrl) return { revision: this.revision, observationCount: this.observationCount };
    let pageInfo = this.pages.get(pageUrl);
    if (!pageInfo) {
      pageInfo = {
        url: pageUrl,
        title: null,
        headings: [],
        controls: [],
        frames: [],
        networkRequests: [],
        firstObservedAt: this.lastObservedAt,
        lastObservedAt: this.lastObservedAt,
        observationCount: 0
      };
      this.pages.set(pageUrl, pageInfo);
    }
    pageInfo.observationCount++;
    pageInfo.lastObservedAt = this.lastObservedAt;
    if (typeof page.title === "string" && page.title) pageInfo.title = page.title;

    for (const heading of headings ?? []) {
      if (typeof heading?.text === "string" && heading.text && pageInfo.headings.length < 100) {
        pageInfo.headings.push({ text: heading.text.slice(0, 300), level: heading.level ?? null, frameId: heading.frameId ?? null });
      }
    }

    for (const candidate of candidates ?? []) {
      if (typeof candidate?.name !== "string" || !candidate.name) continue;
      const structuralContext = [
        candidate.contextName?.slice(0, 100) ?? "",
        candidate.frameId ?? "",
        candidate.role ?? candidate.tag ?? "unknown",
        candidate.name.slice(0, 200)
      ].join(":");
      const key = createHash("sha256").update(`${pageUrl}\n${structuralContext}`).digest("hex").slice(0, 32);
      let control = this.controls.get(key);
      if (!control) {
        control = {
          key,
          role: candidate.role ?? candidate.tag ?? "unknown",
          name: candidate.name.slice(0, 300),
          href: candidate.href ?? null,
          contextName: candidate.contextName ?? null,
          pages: new Set([pageUrl]),
          firstObservedAt: this.lastObservedAt,
          lastObservedAt: this.lastObservedAt
        };
        this.controls.set(key, control);
      }
      control.pages.add(pageUrl);
      control.lastObservedAt = this.lastObservedAt;
      if (pageInfo.controls.length < 100 && !pageInfo.controls.includes(key)) pageInfo.controls.push(key);
    }

    for (const frame of frames ?? []) {
      if (typeof frame?.url !== "string" || !frame.url) continue;
      const exists = pageInfo.frames.find(f => f.frameId === frame.frameId && f.url === frame.url);
      if (!exists) pageInfo.frames.push({ frameId: frame.frameId ?? null, url: frame.url, mainFrame: frame.mainFrame === true });
    }

    for (const request of networkRequests ?? []) {
      if (typeof request?.url !== "string" || !request.url) continue;
      const key = `${request.method ?? "GET"}:${request.url}`;
      let networkOp = this.networkOperations.get(key);
      if (!networkOp) {
        networkOp = {
          key,
          method: request.method ?? "GET",
          url: request.url,
          pages: new Set([pageUrl]),
          firstObservedAt: this.lastObservedAt,
          lastObservedAt: this.lastObservedAt
        };
        this.networkOperations.set(key, networkOp);
      }
      networkOp.pages.add(pageUrl);
      networkOp.lastObservedAt = this.lastObservedAt;
      if (pageInfo.networkRequests.length < 100 && !pageInfo.networkRequests.includes(key)) pageInfo.networkRequests.push(key);
    }
    return { revision: this.revision, observationCount: this.observationCount };
  }

  getControlKeys() {
    return [...this.controls.keys()];
  }

  getPageUrls() {
    return [...this.pages.keys()];
  }

  getNetworkOperations() {
    return [...this.networkOperations.values()];
  }

  getControls() {
    return [...this.controls.values()];
  }

  toObject() {
    return {
      applicationId: this.applicationId,
      origin: this.origin,
      revision: this.revision,
      observationCount: this.observationCount,
      firstObservedAt: this.firstObservedAt,
      lastObservedAt: this.lastObservedAt,
      pages: [...this.pages.values()].map(page => ({
        ...page,
        controls: [...page.controls],
        frames: [...page.frames],
        networkRequests: [...page.networkRequests]
      })),
      controls: [...this.controls.values()].map(control => ({
        ...control,
        pages: [...control.pages]
      })),
      networkOperations: [...this.networkOperations.values()].map(op => ({
        ...op,
        pages: [...op.pages]
      }))
    };
  }
}
