import { createHash } from "node:crypto";

const VARIANTS = Object.freeze({
  modelSelector: ["native_select", "accessible_combobox"],
  navigation: ["full_page", "spa"],
  composer: ["inline", "modal"],
  controlOrder: ["model_first", "prompt_first"]
});

function choice(seed, dimension, values) {
  const digest = createHash("sha256").update(`${seed}:${dimension}`).digest();
  return values[digest.readUInt32BE(0) % values.length];
}

/** Deterministic, semantically-preserving presentation variation. */
export function deriveUiVariant(scenario) {
  const seed = scenario?.seed;
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("Scenario seed must be a non-negative safe integer.");
  const declared = scenario.application?.variants ?? {};
  const selected = {};
  for (const [dimension, values] of Object.entries(VARIANTS)) {
    const value = declared[dimension] ?? choice(seed, dimension, values);
    if (!values.includes(value)) throw new Error(`Unsupported ${dimension} variant '${String(value)}'.`);
    selected[dimension] = value;
  }
  return Object.freeze({ seed, ...selected });
}

export const supportedUiVariants = VARIANTS;
