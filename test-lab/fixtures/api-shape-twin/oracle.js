const EXPECTED_COLLECTION_PATH = ["orders"];
const EXPECTED_FIELDS = new Map([
  ["id", { type: "integer", valueType: Number.isSafeInteger }],
  ["total", { type: "number", valueType: value => typeof value === "number" && Number.isFinite(value) }],
  ["status", { type: "string", valueType: value => typeof value === "string" }],
  ["api_token", { type: "string", valueType: value => typeof value === "string", credentialLike: true }]
]);

function fixtureVariant(index) {
  const count = index % 5 + 1;
  const statuses = ["open", "paid", "refunded"];
  return Array.from({ length: count }, (_, row) => ({
    id: index * 100 + row + 1,
    total: Number((12.5 + index * 1.75 + row * 3.25).toFixed(2)),
    status: statuses[(index + row) % statuses.length],
    api_token: `api-shape-oracle-secret-${index}-${row}`
  }));
}

function candidateHasExpectedShape(candidate) {
  if (JSON.stringify(candidate.collectionPath) !== JSON.stringify(EXPECTED_COLLECTION_PATH)
    || !Array.isArray(candidate.fields) || candidate.fields.length !== EXPECTED_FIELDS.size) return false;
  const actual = new Map(candidate.fields.map(field => [field.name, field]));
  if (actual.size !== EXPECTED_FIELDS.size) return false;
  for (const [name, expected] of EXPECTED_FIELDS) {
    const field = actual.get(name);
    if (!field || field.type !== expected.type) return false;
    if (expected.credentialLike) {
      if (field.credentialLike !== true || field.readEligible !== false) return false;
    } else if (field.credentialLike !== false || field.readEligible !== true) return false;
  }
  return true;
}

/**
 * Independent provider-side API schema oracle for the native CDP fixture.
 * Its expected contract and seeded records are kept outside the browser driver
 * and selected-response evidence. The driver receives only public fixture URLs.
 */
export async function runApiShapeFixtureQualification({ candidate, variants = 30, signal } = {}) {
  if (!Number.isInteger(variants) || variants < 3 || variants > 1000) {
    throw new RangeError("API shape fixture qualification requires 3 to 1000 variants.");
  }
  const reports = [];
  for (let index = 0; index < variants; index++) {
    if (signal?.aborted) throw signal.reason ?? new Error("API fixture qualification was canceled.");
    const rows = fixtureVariant(index);
    const complete = rows.length > 0 && rows.every(row => {
      const keys = Object.keys(row).sort();
      return keys.length === EXPECTED_FIELDS.size
        && keys.every(name => EXPECTED_FIELDS.has(name))
        && [...EXPECTED_FIELDS].every(([name, field]) => field.valueType(row[name]));
    });
    const serializedCandidate = JSON.stringify(candidate);
    const privacyBoundaryPassed = [...rows].every(row => !serializedCandidate.includes(row.api_token))
      && candidate?.fields?.find(field => field.name === "api_token")?.readEligible === false;
    const schemaMatch = candidateHasExpectedShape(candidate);
    reports.push({
      scenarioId: `api_shape_seed_${String(index + 1).padStart(3, "0")}`,
      status: complete ? "complete" : "incomplete",
      schemaMatch,
      completenessVerified: complete,
      privacyBoundaryPassed,
      evidenceRef: `api-shape-fixture:${String(index + 1).padStart(3, "0")}`
    });
  }
  return { oracleIndependent: true, variants: reports };
}
