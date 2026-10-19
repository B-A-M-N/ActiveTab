import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, createDecisionEvent, DECISION_EVENT_SCHEMA_VERSION, TRAINING_ELIGIBILITY } from "./decisionEvents.js";
import { findPredictionForLabel, hasIndependentLabelEvidence, labelApprovalDigest } from "./labelProvenance.js";
import { isSafeTelemetryCode } from "./privacy.js";

const ZERO_HASH = "0".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ensurePrivateDatabasePath(databasePath) {
  const absolutePath = resolve(databasePath);
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(dirname(absolutePath));
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Decision telemetry directory must be a real private directory.");
  chmodSync(dirname(absolutePath), 0o700);
  try {
    const fileStat = lstatSync(absolutePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Decision telemetry database must be a regular file, not a symlink.");
    chmodSync(absolutePath, 0o600);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return absolutePath;
}

export class DecisionEventStore {
  #authenticateTrainingApprover;

  constructor({ databasePath = process.env.ACTIVETAB_TELEMETRY_DB ?? resolve(process.cwd(), ".activetab", "telemetry", "decision-events.sqlite"), busyTimeoutMs = 5000, authenticateTrainingApprover } = {}) {
    if (typeof databasePath !== "string" || !databasePath) throw new Error("DecisionEventStore requires a database path.");
    this.databasePath = databasePath === ":memory:" ? databasePath : ensurePrivateDatabasePath(databasePath);
    this.#authenticateTrainingApprover = authenticateTrainingApprover;
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${Math.max(100, Math.min(30_000, Number(busyTimeoutMs) || 5000))};
      PRAGMA synchronous = FULL;
      ${databasePath === ":memory:" ? "" : "PRAGMA journal_mode = WAL;"}
      CREATE TABLE IF NOT EXISTS episodes (
        episode_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        environment_class TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(episode_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS episodes_run_idx ON episodes(run_id, created_at);
      CREATE TABLE IF NOT EXISTS decision_events (
        event_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step_id TEXT,
        decision_id TEXT,
        observation_id TEXT,
        parent_event_id TEXT,
        sequence INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        training_eligibility TEXT NOT NULL CHECK(training_eligibility IN ('excluded','pending','eligible')),
        payload_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        UNIQUE(episode_id, sequence),
        FOREIGN KEY(episode_id, run_id) REFERENCES episodes(episode_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS decision_events_decision_idx ON decision_events(episode_id, decision_id, sequence);
      CREATE INDEX IF NOT EXISTS decision_events_type_idx ON decision_events(episode_id, event_type, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS decision_events_one_label_approval_idx
        ON decision_events(parent_event_id) WHERE event_type = 'label.approved' AND parent_event_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS decision_events_no_update BEFORE UPDATE ON decision_events
      BEGIN SELECT RAISE(ABORT, 'decision events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS decision_events_no_delete BEFORE DELETE ON decision_events
      BEGIN SELECT RAISE(ABORT, 'decision events are append-only'); END;
    `);
    if (this.databasePath !== ":memory:") chmodSync(this.databasePath, 0o600);
  }

  startEpisode({ runId = randomUUID(), workflowId, applicationId, environmentClass = "unknown", executionMode = "agent_directed", policyVersion = "unknown", workflowKind = "browser_workflow", trainingEligibility = TRAINING_ELIGIBILITY.PENDING }) {
    if (!isSafeTelemetryCode(workflowId, { maxLength: 96 })) throw new Error("Episode workflowId must be a bounded stable identifier.");
    const episodeId = randomUUID();
    const createdAt = new Date().toISOString();
    const started = createDecisionEvent({
      episodeId, runId, eventType: "episode.started", occurredAt: createdAt,
      payload: { workflowKind, applicationId, environmentClass, executionMode, policyVersion },
      trainingEligibility
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO episodes (episode_id, run_id, workflow_id, application_id, environment_class, execution_mode, policy_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(episodeId, runId, workflowId, applicationId, environmentClass, executionMode, policyVersion, createdAt);
      const event = this.#appendInTransaction(started);
      this.db.exec("COMMIT");
      return { episodeId, runId, event };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  append(input) {
    if (input?.eventType === "label.approved") throw new Error("Training-label approvals must pass through the authenticated approval boundary.");
    const event = createDecisionEvent(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT run_id FROM episodes WHERE episode_id = ?").get(event.episodeId);
      if (!row || row.run_id !== event.runId) throw new Error("Decision event episode/run identity mismatch.");
      const stored = this.#appendInTransaction(event);
      if (event.eventType === "episode.completed") {
        this.db.prepare("UPDATE episodes SET status = ?, completed_at = ? WHERE episode_id = ?")
          .run(event.payload.status, event.occurredAt, event.episodeId);
      }
      this.db.exec("COMMIT");
      return stored;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reserveInferenceAttempt({ runId, taskCode, maxAttempts = 4 } = {}) {
    if (!isSafeTelemetryCode(runId, { maxLength: 96 }) || !isSafeTelemetryCode(taskCode, { maxLength: 64 })) {
      throw new Error("Inference reservation requires bounded run and task identifiers.");
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4) throw new Error("Inference attempt budget must be between 1 and 4.");
    const episode = this.getLatestEpisodeForRun(runId);
    if (!episode) throw new Error("Inference attempts require a durable decision episode for this run.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM decision_events WHERE episode_id = ? AND event_type = 'inference.attempted'").get(episode.episode_id).count;
      if (count >= maxAttempts) {
        this.db.exec("ROLLBACK");
        return Object.freeze({ allowed: false, attempts: count, maxAttempts });
      }
      const event = createDecisionEvent({
        episodeId: episode.episode_id,
        runId,
        stepId: "inference_budget",
        decisionId: randomUUID(),
        eventType: "inference.attempted",
        trainingEligibility: TRAINING_ELIGIBILITY.PENDING,
        payload: { taskCode, attemptNumber: count + 1, maxAttempts }
      });
      const stored = this.#appendInTransaction(event);
      this.db.exec("COMMIT");
      return Object.freeze({ allowed: true, attempts: count + 1, maxAttempts, eventId: stored.eventId });
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async approveTrainingLabel({ episodeId, runId, labelEventId }) {
    if (typeof this.#authenticateTrainingApprover !== "function") throw new Error("Training-label export requires an independently authenticated reviewer.");
    const events = this.getEvents(episodeId);
    const proposed = events.find(event => event.eventId === labelEventId && event.eventType === "label.proposed");
    if (!proposed) throw new Error("The proposed training label was not found in this episode.");
    if (proposed.runId !== runId) throw new Error("Training label run identity mismatch.");
    if (events.some(event => event.eventType === "label.approved" && event.parentEventId === proposed.eventId)) {
      throw new Error("This training-label proposal has already been approved.");
    }
    const prediction = findPredictionForLabel(events, proposed);
    if (!prediction) throw new Error("Training label rubric does not match a recorded semantic or Jev prediction.");
    if (!hasIndependentLabelEvidence(events, proposed, prediction)) {
      throw new Error("Training labels require matching, independently verified evidence for the same decision and step.");
    }
    const approvalDigest = labelApprovalDigest(proposed);
    const request = {
      episodeId: proposed.episodeId,
      runId: proposed.runId,
      stepId: proposed.stepId ?? null,
      decisionId: proposed.decisionId,
      labelEventId: proposed.eventId,
      ...proposed.payload,
      approvalDigest
    };
    const authorization = await this.#authenticateTrainingApprover({ request });
    if (!authorization || authorization.authenticated !== true
      || typeof authorization.principalId !== "string"
      || authorization.approvalDigest !== approvalDigest) {
      throw new Error("Reviewer authentication must approve the exact label proposal and evidence scope.");
    }
    const approval = createDecisionEvent({
      episodeId, runId, stepId: proposed.stepId, decisionId: proposed.decisionId,
      parentEventId: proposed.eventId, eventType: "label.approved",
      trainingEligibility: TRAINING_ELIGIBILITY.ELIGIBLE,
      payload: {
        labelEventId: proposed.eventId,
        rubricId: proposed.payload.rubricId,
        labelCode: proposed.payload.labelCode,
        sourceClass: proposed.payload.sourceClass,
        evidenceRefs: proposed.payload.evidenceRefs,
        reviewerId: authorization.principalId,
        approvalDigest
      }
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT event_id FROM decision_events WHERE event_type = 'label.approved' AND parent_event_id = ?").get(proposed.eventId);
      if (existing) throw new Error("This training-label proposal has already been approved.");
      const stored = this.#appendInTransaction(approval);
      this.db.exec("COMMIT");
      return stored;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #appendInTransaction(event) {
    const last = this.db.prepare("SELECT sequence, event_hash FROM decision_events WHERE episode_id = ? ORDER BY sequence DESC LIMIT 1").get(event.episodeId);
    const sequence = (last?.sequence ?? 0) + 1;
    const previousHash = last?.event_hash ?? ZERO_HASH;
    const hashInput = { ...event, sequence, previousHash };
    const eventHash = sha256(`${previousHash}\n${canonicalJson(hashInput)}`);
    const stored = { ...hashInput, eventHash };
    this.db.prepare(`INSERT INTO decision_events
      (event_id, episode_id, run_id, step_id, decision_id, observation_id, parent_event_id, sequence, occurred_at, event_type, schema_version, training_eligibility, payload_json, previous_hash, event_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(stored.eventId, stored.episodeId, stored.runId, stored.stepId ?? null, stored.decisionId ?? null,
        stored.observationId ?? null, stored.parentEventId ?? null, sequence, stored.occurredAt,
        stored.eventType, stored.schemaVersion, stored.trainingEligibility, canonicalJson(stored.payload), previousHash, eventHash);
    return stored;
  }

  getEpisode(episodeId) {
    return this.db.prepare("SELECT * FROM episodes WHERE episode_id = ?").get(episodeId) ?? null;
  }

  getLatestEpisodeForRun(runId) {
    return this.db.prepare("SELECT * FROM episodes WHERE run_id = ? ORDER BY created_at DESC, episode_id DESC LIMIT 1").get(runId) ?? null;
  }

  listEpisodes({ limit = 1000 } = {}) {
    const bounded = Math.max(1, Math.min(10_000, Number.isInteger(limit) ? limit : 1000));
    return this.db.prepare("SELECT * FROM episodes ORDER BY created_at, episode_id LIMIT ?").all(bounded);
  }

  listQualificationCandidates({ applicationId, environmentClass, principalId, providerId, limit = 100 } = {}) {
    for (const [field, value] of Object.entries({ applicationId, environmentClass, principalId, providerId })) {
      if (!isSafeTelemetryCode(value, { maxLength: 96 })) throw new Error(`Qualification candidate lookup requires a bounded ${field} scope.`);
    }
    const bounded = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 100));
    const rows = this.db.prepare(`
      SELECT completed.*, episodes.application_id, episodes.environment_class,
        started.payload_json AS started_payload, started.event_id AS started_event_id
      FROM decision_events AS completed
      JOIN episodes ON episodes.episode_id = completed.episode_id AND episodes.run_id = completed.run_id
      JOIN decision_events AS started ON started.event_id = completed.parent_event_id
        AND started.episode_id = completed.episode_id AND started.event_type = 'qualification.started'
      WHERE completed.event_type = 'qualification.completed'
        AND episodes.application_id = ? AND episodes.environment_class = ?
        AND json_extract(started.payload_json, '$.principalId') = ?
        AND json_extract(started.payload_json, '$.providerId') = ?
      ORDER BY completed.occurred_at DESC, completed.episode_id DESC LIMIT ?
    `).all(applicationId, environmentClass, principalId, providerId, bounded);
    const candidates = [];
    for (const row of rows) {
      const outcome = JSON.parse(row.payload_json);
      const proposal = JSON.parse(row.started_payload);
      if (outcome.qualificationStatus !== "qualified" || proposal.principalId !== principalId
        || proposal.providerId !== providerId || outcome.principalId !== principalId
        || outcome.providerId !== providerId || outcome.qualificationId !== proposal.qualificationId
        || outcome.strategyFingerprint !== proposal.strategyFingerprint || outcome.scenarioId !== proposal.scenarioId) continue;
      candidates.push(Object.freeze({
        state: "candidate",
        qualificationId: outcome.qualificationId,
        strategyFingerprint: outcome.strategyFingerprint,
        applicationId: row.application_id,
        environmentClass: row.environment_class,
        principalId,
        providerId,
        scenarioId: outcome.scenarioId,
        episodeId: row.episode_id,
        runId: row.run_id,
        sourceEventIds: proposal.sourceEventIds,
        evidenceRefs: outcome.evidenceRefs,
        qualifiedAt: row.occurred_at,
        trainingEligibility: TRAINING_ELIGIBILITY.PENDING
      }));
      if (candidates.length >= bounded) break;
    }
    return candidates;
  }

  getEvents(episodeId) {
    return this.db.prepare("SELECT * FROM decision_events WHERE episode_id = ? ORDER BY sequence").all(episodeId).map(row => ({
      eventId: row.event_id,
      episodeId: row.episode_id,
      runId: row.run_id,
      ...(row.step_id ? { stepId: row.step_id } : {}),
      ...(row.decision_id ? { decisionId: row.decision_id } : {}),
      ...(row.observation_id ? { observationId: row.observation_id } : {}),
      ...(row.parent_event_id ? { parentEventId: row.parent_event_id } : {}),
      sequence: row.sequence,
      occurredAt: row.occurred_at,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      trainingEligibility: row.training_eligibility,
      payload: JSON.parse(row.payload_json),
      previousHash: row.previous_hash,
      eventHash: row.event_hash
    }));
  }

  verifyEpisodeChain(episodeId) {
    const events = this.getEvents(episodeId);
    let previousHash = ZERO_HASH;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const { eventHash, ...base } = event;
      if (event.sequence !== i + 1 || event.previousHash !== previousHash) return { ok: false, sequence: event.sequence, reason: "sequence_or_previous_hash_mismatch" };
      if (sha256(`${previousHash}\n${canonicalJson(base)}`) !== eventHash) return { ok: false, sequence: event.sequence, reason: "event_hash_mismatch" };
      previousHash = eventHash;
    }
    return { ok: true, eventCount: events.length, lastHash: previousHash };
  }

  close() { this.db.close(); }
}
