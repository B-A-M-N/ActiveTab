export const RUBRIC_VERSION = "2";

export const INTENT_ALIGNMENT_QUESTION = Object.freeze({
  type: "noul",
  instructions: "Given only the declared operation and the observed control's structural role, is this control a plausible match for the caller's stated target role? Do not decide whether the operation is authorized. If evidence is ambiguous, answer no."
});

export const TARGET_CLARITY_QUESTION = Object.freeze({
  type: "choice",
  instructions: "How clearly does the supplied structural evidence distinguish the proposed control from alternatives? Do not infer authorization.",
  criteria: Object.freeze({
    clear: "One observed candidate is distinctly identified by role and current evidence.",
    ambiguous: "Several observed candidates could match or the proposed mapping conflicts with labels.",
    insufficient: "The evidence does not contain enough structure to judge the mapping."
  })
});

export const EVIDENCE_SUPPORT_QUESTION = Object.freeze({
  type: "noul",
  instructions: "Does the supplied typed evidence directly support the stated postcondition? Do not treat a UI dispatch acknowledgment alone as proof of application success."
});

export const OUTCOME_ANOMALY_QUESTION = Object.freeze({
  type: "choice",
  instructions: "Which bounded category best describes the discrepancy in the supplied outcome evidence? Choose none only when the evidence is consistent.",
  criteria: Object.freeze({
    none: "The independent observations agree with the expected outcome.",
    ui_backend_mismatch: "Browser-visible and backend-observed states disagree.",
    operation_failed: "Evidence indicates the intended operation failed.",
    evidence_missing: "Evidence required to verify the outcome is absent.",
    unexpected_state: "The observed state does not fit the other categories."
  })
});

export const WORKFLOW_PLAN_QUESTIONS = Object.freeze({
  plan_coherence: Object.freeze({
    type: "noul",
    instructions: "Does the supplied bounded workflow have a coherent dependency order for its declared operation roles? Judge only the structural projection; do not infer missing steps from page content."
  }),
  plan_verifiability: Object.freeze({
    type: "noul",
    instructions: "Does each declared operation include an explicit verification contract before later dependent operations proceed? A dispatch acknowledgment is not verification."
  }),
  plan_boundary_alignment: Object.freeze({
    type: "noul",
    instructions: "Are effects that require approval explicitly marked, with no unknown-effect operation presented as routine? This is an advisory review and never grants authority."
  })
});
