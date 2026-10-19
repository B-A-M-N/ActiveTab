import { randomUUID } from "node:crypto";
import { classifyObservedPublicField } from "./fieldPolicy.js";

const MAX_REQUESTS = 256;
const MAX_FIELDS = 32;

function normalizeProposal(proposal, { publicFieldPolicy = null } = {}) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)
    || Object.keys(proposal).some(key => !["origin", "pagePath", "targetId", "sourceFingerprint", "fields", "requestedOutput", "maxRecords", "maxBytes", "expiresInMs", "approvalPhrase"].includes(key))) {
    throw new Error("Public-read approval proposal has an unsupported shape.");
  }
  let origin;
  try { origin = new URL(proposal.origin); } catch { throw new Error("Public-read approval requires an exact HTTP(S) origin."); }
  if (!(["http:", "https:"].includes(origin.protocol) && origin.origin === proposal.origin)
    || typeof proposal.pagePath !== "string" || !proposal.pagePath.startsWith("/") || proposal.pagePath.startsWith("//")
    || proposal.pagePath.length > 2048
    || typeof proposal.targetId !== "string" || !proposal.targetId || proposal.targetId.length > 256
    || typeof proposal.sourceFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(proposal.sourceFingerprint)
    || !Array.isArray(proposal.fields) || proposal.fields.length < 1 || proposal.fields.length > MAX_FIELDS
    || !Array.isArray(proposal.requestedOutput) || proposal.requestedOutput.length !== proposal.fields.length
    || !Number.isInteger(proposal.maxRecords) || proposal.maxRecords < 1 || proposal.maxRecords > 10_000
    || !Number.isInteger(proposal.maxBytes) || proposal.maxBytes < 1024 || proposal.maxBytes > 1024 * 1024
    || !Number.isInteger(proposal.expiresInMs) || proposal.expiresInMs < 1000 || proposal.expiresInMs > 15 * 60_000
    || typeof proposal.approvalPhrase !== "string" || !/^APPROVE PUBLIC READ [A-F0-9]{8}$/u.test(proposal.approvalPhrase)) {
    throw new Error("Public-read approval proposal is invalid or exceeds its bounds.");
  }
  const names = new Set();
  const fields = proposal.fields.map(field => {
    if (!field || typeof field !== "object" || Array.isArray(field)
      || Object.keys(field).some(key => !["name", "sourceHeader", "sourceKey", "type"].includes(key))
      || typeof field.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(field.name)
      || (typeof field.sourceHeader === "string") === (typeof field.sourceKey === "string")
      || typeof (field.sourceHeader ?? field.sourceKey) !== "string"
      || (field.sourceHeader ?? field.sourceKey).length < 1 || (field.sourceHeader ?? field.sourceKey).length > 160
      || field.type !== "string" || names.has(field.name)) {
      throw new Error("Public-read approval fields must be unique, exact, bounded string fields.");
    }
    names.add(field.name);
    const classification = classifyObservedPublicField(field.sourceHeader ? { sourceHeader: field.sourceHeader } : { sourceKey: field.sourceKey });
    const configured = typeof publicFieldPolicy === "function"
      ? publicFieldPolicy({ origin: origin.origin, ...(field.sourceHeader ? { sourceHeader: field.sourceHeader } : { sourceKey: field.sourceKey }) })
      : null;
    if (classification !== "public" || configured?.dataClass && configured.dataClass !== "public"
      || configured && (configured.allowRead !== true || configured.allowRelease !== true)) {
      throw new Error("Unclassified or explicitly denied fields cannot enter a public-read approval request.");
    }
    return Object.freeze({
      name: field.name,
      ...(field.sourceHeader ? { sourceHeader: field.sourceHeader } : { sourceKey: field.sourceKey }),
      type: "string",
      dataClass: "public"
    });
  });
  if (proposal.requestedOutput.length !== fields.length
    || proposal.requestedOutput.some((name, index) => name !== fields[index].name)) {
    throw new Error("Public-read approval output must exactly match its requested fields.");
  }
  return Object.freeze({
    origin: origin.origin,
    pagePath: proposal.pagePath,
    targetId: proposal.targetId,
    sourceFingerprint: proposal.sourceFingerprint,
    fields: Object.freeze(fields),
    requestedOutput: Object.freeze([...proposal.requestedOutput]),
    maxRecords: proposal.maxRecords,
    maxBytes: proposal.maxBytes,
    expiresInMs: proposal.expiresInMs,
    approvalPhrase: proposal.approvalPhrase
  });
}

/** In-memory operator rendezvous. Approval resolves a waiter; only the owning run issues its grant. */
export class RunLocalPublicReadApprovalBroker {
  constructor({ now = () => Date.now(), publicFieldPolicy = null, maxRequests = MAX_REQUESTS } = {}) {
    this.now = now;
    this.publicFieldPolicy = publicFieldPolicy;
    this.maxRequests = Math.max(1, Math.min(MAX_REQUESTS, Number(maxRequests) || MAX_REQUESTS));
    this.requests = new Map();
    this.waiters = new Map();
  }

  create(proposal) {
    const normalized = normalizeProposal(proposal, { publicFieldPolicy: this.publicFieldPolicy });
    this.#prune();
    if (this.requests.size >= this.maxRequests) throw new Error("Public-read approval queue is full.");
    const record = {
      requestId: randomUUID(), revision: 1, status: "pending",
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + normalized.expiresInMs).toISOString(),
      proposal: normalized,
      operatorId: null
    };
    this.requests.set(record.requestId, record);
    return this.#project(record);
  }

  async request(proposal, { signal } = {}) {
    const record = this.create(proposal);
    return await this.waitForResolution(record.requestId, { signal });
  }

  async waitForResolution(requestId, { signal } = {}) {
    const record = this.#current(requestId);
    if (!record || record.status !== "pending") return record?.status === "approved";
    if (signal?.aborted) return false;
    return await new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(requestId);
        resolve(value);
      };
      const onAbort = () => finish(false);
      const remaining = Math.max(0, Date.parse(record.expiresAt) - this.now());
      const timer = setTimeout(() => {
        const current = this.#current(requestId);
        if (current?.status === "pending") {
          current.status = "expired";
          current.revision++;
        }
        finish(false);
      }, remaining);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(requestId, finish);
    });
  }

  get(requestId) {
    const record = this.#current(requestId);
    return record ? this.#project(record) : null;
  }

  listPending() {
    this.#prune();
    return [...this.requests.values()].filter(record => record.status === "pending").map(record => this.#project(record));
  }

  resolve(requestId, { decision, operatorId, expectedRevision, approvalPhrase } = {}) {
    const record = this.#current(requestId);
    if (!record) throw new Error("Public-read approval request was not found or has expired.");
    if (record.status !== "pending") throw new Error("Public-read approval request is already resolved.");
    if (!Number.isInteger(expectedRevision) || expectedRevision !== record.revision) throw new Error("Public-read approval revision changed.");
    if (typeof operatorId !== "string" || !operatorId || operatorId.length > 128) throw new Error("Authenticated operator identity is required.");
    if (!new Set(["approve", "reject"]).has(decision)) throw new Error("Public-read decision must be approve or reject.");
    if (decision === "approve" && approvalPhrase !== record.proposal.approvalPhrase) throw new Error("The exact public-read approval phrase is required.");
    record.status = decision === "approve" ? "approved" : "rejected";
    record.operatorId = operatorId;
    record.resolvedAt = new Date(this.now()).toISOString();
    record.revision++;
    this.waiters.get(requestId)?.(record.status === "approved");
    return this.#project(record);
  }

  #current(requestId) {
    const record = this.requests.get(requestId);
    if (record?.status === "pending" && Date.parse(record.expiresAt) <= this.now()) {
      record.status = "expired";
      record.revision++;
      this.waiters.get(requestId)?.(false);
    }
    return record ?? null;
  }

  #prune() {
    for (const [id, record] of this.requests) {
      this.#current(id);
      if (record.status !== "pending" && this.requests.size > Math.floor(this.maxRequests * 0.75)) this.requests.delete(id);
    }
  }

  #project(record) {
    const { approvalPhrase, ...proposal } = record.proposal;
    return Object.freeze({
      requestId: record.requestId,
      revision: record.revision,
      status: record.status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
      ...(record.operatorId ? { operatorId: record.operatorId } : {}),
      proposal: Object.freeze({ ...proposal, fields: proposal.fields, requestedOutput: proposal.requestedOutput }),
      approvalPhrase
    });
  }
}

export { normalizeProposal as validatePublicReadApprovalProposal };
