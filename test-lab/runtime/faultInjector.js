const FAULT_TRIGGERS = Object.freeze({
  persist_job_then_drop_response: "task_submit",
  first_status_check_503: "run_status_check",
  first_status_check_running: "run_status_check",
  expire_agent_session_before_submit: "task_submit",
  delay_job_completion: "background_job",
  fail_job: "background_job"
});
const ALLOWED_FAULTS = new Set(Object.keys(FAULT_TRIGGERS));

export class FaultInjector {
  #remaining = new Map();

  constructor(faults = []) { this.configure(faults); }

  configure(faults = []) {
    this.#remaining.clear();
    if (!Array.isArray(faults) || faults.length > 16) throw new Error("Fault schedule must be a bounded array.");
    for (const fault of faults) {
      if (!ALLOWED_FAULTS.has(fault?.behavior)) throw new Error(`Unsupported fixture fault '${String(fault?.behavior)}'.`);
      if (fault?.when !== FAULT_TRIGGERS[fault.behavior]) throw new Error(`Fixture fault '${fault.behavior}' must target '${FAULT_TRIGGERS[fault.behavior]}'.`);
      if (this.#remaining.has(fault.behavior)) throw new Error(`Fixture fault '${fault.behavior}' may only be scheduled once.`);
      this.#remaining.set(fault.behavior, true);
    }
  }

  take(behavior) {
    if (!this.#remaining.get(behavior)) return false;
    this.#remaining.set(behavior, false);
    return true;
  }

  inject(behavior) {
    if (!ALLOWED_FAULTS.has(behavior)) throw new Error(`Unsupported fixture fault '${String(behavior)}'.`);
    if (this.#remaining.get(behavior) === true) throw new Error(`Fixture fault '${behavior}' is already scheduled.`);
    this.#remaining.set(behavior, true);
  }

  has(behavior) { return this.#remaining.get(behavior) === true; }
}

export function fixtureFaultTrigger(behavior) { return FAULT_TRIGGERS[behavior] ?? null; }
export const fixtureFaults = Object.freeze([...ALLOWED_FAULTS]);
