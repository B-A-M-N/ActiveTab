import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JevDecisionClient, JEV_MODEL_ID } from "../src/decisions/jevClient.js";
import { JEV_IMAGE_PREPARATION_VERSION, isJevImageSizeSupported, jpegDimensions, planJevImagePreparation } from "../src/decisions/imagePreparation.js";

const fixtureBytes = readFileSync(resolve("docs/assets/first-run.jpg"));
const fixtureBase64 = fixtureBytes.toString("base64");
const state = {
  operation_code: "inspect",
  operation_class: "read",
  requested_target_role: "save_button",
  proposed_control: { candidate_ref: "candidate_1", role: "button", tag: "button", visible: true, disabled: false },
  page_surface: "observed_browser_surface",
  alternative_count: 1
};
const questions = {
  target_present: { type: "noul", instructions: "Is the requested Save target visible?" },
  save_button_box: { type: "box", instructions: "Find the visible Save button." }
};
const imageEvidence = {
  evidenceId: "obs_jev_box",
  targetId: "target_jev_box",
  documentGeneration: 2,
  viewport: { width: 780, height: 437 },
  screenshotBase64: fixtureBase64
};

test("Jev accepts one paired Noul and Box answer and preserves typed coordinates", async () => {
  let request;
  const client = new JevDecisionClient({
    apiKey: "fixture-jev-key",
    allowImages: true,
    fetchImpl: async (_url, options) => {
      request = options;
      return new Response(JSON.stringify({
        model: JEV_MODEL_ID,
        answers: {
          target_present: { type: "noul", noul: 0.91 },
          save_button_box: { type: "box", box: { top: 0.4, bottom: 0.5, left: 0.6, right: 0.8 }, confidence: 0.84 }
        }
      }), { status: 200 });
    }
  });
  const result = await client.decide({ state, questions, imageEvidence });
  assert.equal(request.headers["TypeSafe-Danger-Zone-Images"], "true");
  assert.deepEqual(result.answers.save_button_box, {
    type: "box",
    box: { top: 0.4, bottom: 0.5, left: 0.6, right: 0.8 },
    confidence: 0.84
  });
});

test("Jev Box requests require a bound image and paired Noul presence question", async () => {
  let calls = 0;
  const client = new JevDecisionClient({ apiKey: "fixture-jev-key", allowImages: true, fetchImpl: async () => { calls++; throw new Error("must not call provider"); } });
  await assert.rejects(client.decide({ state, questions }), error => error.kind === "privacy");
  await assert.rejects(client.decide({
    state,
    questions: { save_button_box: questions.save_button_box },
    imageEvidence
  }), /paired Noul/u);
  assert.equal(calls, 0);
});

test("Jev rejects malformed, incomplete, reversed, out-of-range, or unconfident boxes", async t => {
  const cases = [
    { top: 0.2, bottom: 0.8, left: 0.1 },
    { top: 0.8, bottom: 0.2, left: 0.1, right: 0.4 },
    { top: 0.1, bottom: 0.4, left: 0.7, right: 0.3 },
    { top: -0.1, bottom: 0.4, left: 0.1, right: 0.3 },
    { top: 0.1, bottom: 0.4, left: 0.1, right: 0.3, confidence: 1.2 }
  ];
  for (const [index, box] of cases.entries()) {
    await t.test(`invalid box ${index + 1}`, async () => {
      const client = new JevDecisionClient({
        apiKey: "fixture-jev-key",
        allowImages: true,
        fetchImpl: async () => new Response(JSON.stringify({
          model: JEV_MODEL_ID,
          answers: {
            target_present: { type: "noul", noul: 0.9 },
            save_button_box: { type: "box", box, ...(box.confidence === undefined ? { confidence: 0.8 } : { confidence: box.confidence }) }
          }
        }), { status: 200 })
      });
      await assert.rejects(client.decide({ state, questions, imageEvidence }), error => error.kind === "schema");
    });
  }
});

test("image preparation scales large viewports through CDP bounds without upscaling small ones", () => {
  assert.deepEqual(planJevImagePreparation({ width: 2560, height: 1440 }), {
    status: "ready", scale: 0.6125, width: 2560, height: 1440, outputWidth: 1568, outputHeight: 882
  });
  assert.equal(planJevImagePreparation({ width: 1920, height: 1080 }).status, "ready");
  assert.equal(planJevImagePreparation({ width: 1280, height: 720 }).scale, 1);
  assert.equal(planJevImagePreparation({ width: 256, height: 144 }).reasonCode, "below_minimum_dimension");
  assert.deepEqual(jpegDimensions(fixtureBytes), { width: 780, height: 437 });
  assert.equal(isJevImageSizeSupported({ width: 280, height: 280 }), true);
  assert.equal(isJevImageSizeSupported({ width: 256, height: 437 }), false);
  assert.equal(JEV_IMAGE_PREPARATION_VERSION, "jev_image_preparation_v1");
});
