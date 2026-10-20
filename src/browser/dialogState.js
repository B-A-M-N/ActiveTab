/** Holds one currently observed JavaScript dialog for a BrowserSession. */
export class DialogState {
  #pending = null;

  get pending() {
    return this.#pending;
  }

  set pending(dialog) {
    this.#pending = dialog ?? null;
  }

  get hasPending() {
    return this.#pending !== null;
  }

  open(event) {
    this.#pending = {
      type: event?.type ?? "alert",
      message: String(event?.message ?? "").slice(0, 500),
      defaultPrompt: event?.defaultPrompt ?? null,
      url: event?.url ?? null,
      capturedAt: new Date().toISOString()
    };
    return this.#pending;
  }

  clear() {
    this.#pending = null;
  }
}
