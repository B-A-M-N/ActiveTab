/**
 * MCP exposes redacted evidence only. Request flags are not authority to
 * release sensitive browser content; a separate authenticated operator
 * release path must be composed before this policy can permit raw output.
 */
export function assertRedactedEvidenceOnly(args, fields = []) {
  const requested = fields.filter(field => args?.[field] === true);
  if (requested.length) {
    throw new Error("Sensitive browser evidence cannot be released through MCP without a separately authenticated evidence grant.");
  }
}
