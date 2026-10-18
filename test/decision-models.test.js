import test from "node:test";
import assert from "node:assert/strict";
import { JEV_MODEL_ID, JevDecisionClient } from "../src/decisions/jevClient.js";

const QUESTION = { intent_alignment: { type: "noul", instructions: "Is the typed evidence aligned?" } };
const PRE_ACTION_STATE = {
  operation_code: "click",
  operation_class: "navigation",
  requested_target_role: "browser_target",
  proposed_control: { candidate_ref: "target-1:root:frame-1:1:2", role: "link", tag: "a", visible: true, disabled: false },
  page_surface: "observed_browser_surface",
  alternative_count: 0
};

test("Jev client pins 1.14, preserves typed probabilities and usage, and never returns its credential", async () => {
  let request;
  const client = new JevDecisionClient({
    apiKey: "test-secret-not-for-output",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        model: JEV_MODEL_ID,
        id: "request_1",
        answers: { intent_alignment: { type: "noul", noul: 0.93 } },
        usage: { input_tokens: 42, output_tokens: 7, prompt_tokens_details: { cached_tokens: 12 }, cost: 0.001 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const result = await client.decide({ state: PRE_ACTION_STATE, questions: QUESTION });
  assert.equal(JSON.parse(request.options.body).model, "typesafe/jev-1.14");
  assert.equal(request.options.headers.authorization, "Bearer test-secret-not-for-output");
  assert.equal(Object.hasOwn(client, "apiKey"), false, "the Jev credential is held in a private class field");
  assert.equal(JSON.stringify(client).includes("test-secret-not-for-output"), false);
  assert.equal(result.model, "typesafe/jev-1.14");
  assert.deepEqual(result.answers.intent_alignment, { type: "noul", probabilityYes: 0.93 });
  assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 7, cachedInputTokens: 12, cost: 0.001 });
  assert.equal(JSON.stringify(result).includes("test-secret-not-for-output"), false);
});

test("Jev client rejects a response that identifies a different model", async () => {
  const client = new JevDecisionClient({
    apiKey: "test-secret-not-for-output",
    fetchImpl: async () => new Response(JSON.stringify({ model: "typesafe/jev-latest", answers: { intent_alignment: { type: "noul", noul: 0.8 } } }), { status: 200 })
  });
  await assert.rejects(client.decide({ state: PRE_ACTION_STATE, questions: QUESTION }), /pinned decision model/);
});

test("Jev client accepts only the minimized typed state and does not send free text", async () => {
  let fetchCount = 0;
  const client = new JevDecisionClient({
    apiKey: "test-secret-not-for-output",
    fetchImpl: async () => {
      fetchCount++;
      return new Response(JSON.stringify({ model: JEV_MODEL_ID, answers: { intent_alignment: { type: "noul", noul: 0.9 } } }), { status: 200 });
    }
  });
  await assert.rejects(client.decide({
    state: { ...PRE_ACTION_STATE, page_text: "private page text" },
    questions: QUESTION
  }), error => error.kind === "privacy");
  assert.equal(fetchCount, 0);
});
