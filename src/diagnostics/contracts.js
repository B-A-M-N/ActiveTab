/**
 * Diagnostic source contracts.
 *
 * Every diagnostic source must declare its authentication authority,
 * permitted operations, scope, data sensitivity, and rate limits.
 * A contract is an authorization boundary, not documentation: the collector
 * enforces it before each call.
 */

export const SENSITIVITY = Object.freeze({
  METADATA_ONLY: "metadata_only",
  AGGREGATE: "aggregate",
  PRIVATE_CONTENT: "private_content",
  SECRET: "secret"
});

export const AUTHORITY = Object.freeze({
  BROWSER_CDP: "browser_cdp",
  APPLICATION_SESSION: "application_session",
  ADMIN_SESSION: "admin_session",
  SERVICE_ACCOUNT: "service_account",
  LOCAL_FIXTURE: "local_fixture"
});

export const OPERATION = Object.freeze({
  READ: "read",
  READ_AGGREGATE: "read_aggregate",
  READ_SCOPED: "read_scoped"
});

export function createDiagnosticContract({
  id,
  authority,
  operations,
  scope,
  sensitivity,
  rateLimit = null,
  description = ""
}) {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Diagnostic contract requires an id.");
  }
  if (!Object.values(AUTHORITY).includes(authority)) {
    throw new Error(`Diagnostic contract '${id}': unknown authority '${authority}'.`);
  }
  const operationList = Array.isArray(operations) ? operations : [operations];
  for (const operation of operationList) {
    if (!Object.values(OPERATION).includes(operation)) {
      throw new Error(`Diagnostic contract '${id}': unknown operation '${operation}'.`);
    }
  }
  if (typeof scope !== "string" || scope.length === 0) {
    throw new Error(`Diagnostic contract '${id}': scope is required.`);
  }
  if (!Object.values(SENSITIVITY).includes(sensitivity)) {
    throw new Error(`Diagnostic contract '${id}': unknown sensitivity '${sensitivity}'.`);
  }
  if (rateLimit !== null && (typeof rateLimit !== "object" || rateLimit === null)) {
    throw new Error(`Diagnostic contract '${id}': rateLimit must be an object or null.`);
  }
  return Object.freeze({
    id: String(id),
    authority,
    operations: Object.freeze([...operationList]),
    scope: String(scope),
    sensitivity,
    rateLimit: rateLimit ? Object.freeze({ ...rateLimit }) : null,
    description: String(description)
  });
}

/**
 * Validate a contract against a requested operation.
 * Returns null when allowed; returns a human-readable reason when denied.
 */
export function validateAccess(contract, operation) {
  if (!Object.values(OPERATION).includes(operation)) {
    return `Unknown operation '${operation}' requested from '${contract.id}'.`;
  }
  if (!contract.operations.includes(operation)) {
    return `Source '${contract.id}' does not permit operation '${operation}'.`;
  }
  return null;
}
