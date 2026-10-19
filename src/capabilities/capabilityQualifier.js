import { createHash } from "node:crypto";
import { validateSiteCapabilityManifest } from "./siteCapabilityManifest.js";

function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

const RESOLVER_QUALIFICATION = Object.freeze({
  level: "resolver",
  providerId: "activetab_extraction_resolver",
  providerIdentity: "activetab_synthetic_dom_resolver_v1",
  scenarioSeed: 0,
  sourceRevision: "activetab_extraction_resolver_v1",
  oracleReference: "synthetic_dom_variant_oracle_v1",
  cleanupResult: { status: "not_applicable", reasonCode: "in_memory_variants_only" },
  independentApplicationOutcome: false
});

/** Qualify only the resolver against synthetic DOM variants. This is not application qualification. */
export class CapabilityQualifier {
  constructor({ runQualification } = {}) { this.runQualification = runQualification; }

  async qualify(candidate, { variants = 30, signal } = {}) {
    const validation = validateSiteCapabilityManifest(candidate);
    if (!validation.valid || candidate.qualification.status !== "candidate") throw new Error("Only a valid unqualified capability candidate can enter qualification.");
    if (typeof this.runQualification !== "function") return { status: "unavailable", reasonCode: "fixture_qualification_adapter_unavailable" };
    if (!Number.isInteger(variants) || variants < 3 || variants > 1000) throw new Error("Capability qualification requires 3 to 1000 seeded variants.");
    const result = await this.runQualification({ manifest: candidate, variants, signal });
    const reports = Array.isArray(result?.variants) ? result.variants : [];
    const eligible = reports.length === variants
      && reports.every(item => item?.status === "complete" && item.schemaMatch === true
        && item.completenessVerified === true && item.privacyBoundaryPassed === true);
    if (!eligible) return { status: "not_qualified", reasonCode: "variant_oracle_check_failed", passedVariants: reports.filter(item => item?.status === "complete").length, variantCount: variants };
    const evidenceRefs = [...new Set(reports.map(item => item.evidenceRef).filter(value => typeof value === "string" && value.length > 0))].slice(0, 32);
    if (evidenceRefs.length === 0) return { status: "inconclusive", reasonCode: "qualification_evidence_missing" };
    const qualified = {
      ...structuredClone(candidate),
      qualification: {
        status: "qualified",
        ...structuredClone(RESOLVER_QUALIFICATION),
        variantCount: variants,
        evidenceRefs,
        evidenceDigest: digest(reports.map(item => ({
          scenarioId: item.scenarioId ?? null,
          status: item.status,
          schemaMatch: item.schemaMatch,
          completenessVerified: item.completenessVerified,
          privacyBoundaryPassed: item.privacyBoundaryPassed
        })))
      }
    };
    const finalCheck = validateSiteCapabilityManifest(qualified, { requireQualified: true });
    if (!finalCheck.valid) throw new Error(`Qualification result cannot be registered: ${finalCheck.errors.join(" ")}`);
    return { status: "qualified", manifest: Object.freeze(qualified) };
  }
}
