import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_INFERENCE_ATTEMPT_BUDGET = 4;

export class InferenceBudgetError extends Error {
  constructor(message = "The durable per-run inference attempt budget is exhausted.") {
    super(message);
    this.name = "InferenceBudgetError";
    this.kind = "budget_exhausted";
  }
}

export class InferenceAttemptBudget {
  #context = new AsyncLocalStorage();

  constructor({ eventStore, maxAttempts = DEFAULT_INFERENCE_ATTEMPT_BUDGET } = {}) {
    if (!eventStore || typeof eventStore.reserveInferenceAttempt !== "function") throw new Error("InferenceAttemptBudget requires durable event-store reservations.");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > DEFAULT_INFERENCE_ATTEMPT_BUDGET) throw new Error("Inference attempt budget must be between 1 and 4.");
    this.eventStore = eventStore;
    this.maxAttempts = maxAttempts;
  }

  run({ runId }, callback) {
    if (typeof runId !== "string" || !runId || typeof callback !== "function") throw new Error("Inference budget context requires a run ID and callback.");
    return this.#context.run(Object.freeze({ runId }), callback);
  }

  wrapFetch(taskCode, fetchImpl = fetch) {
    if (typeof fetchImpl !== "function") throw new Error("Inference transport must be a fetch-compatible function.");
    return (...args) => {
      const context = this.#context.getStore();
      if (!context) return fetchImpl(...args);
      const reservation = this.eventStore.reserveInferenceAttempt({ runId: context.runId, taskCode, maxAttempts: this.maxAttempts });
      if (!reservation.allowed) throw new InferenceBudgetError();
      return fetchImpl(...args);
    };
  }

  snapshot(runId) {
    const episode = this.eventStore.getLatestEpisodeForRun(runId);
    if (!episode) return Object.freeze({ attempts: 0, maxAttempts: this.maxAttempts });
    const attempts = this.eventStore.getEvents(episode.episode_id).filter(event => event.eventType === "inference.attempted").length;
    return Object.freeze({ attempts, maxAttempts: this.maxAttempts });
  }
}
