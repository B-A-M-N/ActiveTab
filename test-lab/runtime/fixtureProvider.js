/** Shared lifecycle for isolated benchmark targets. */
export class FixtureProvider {
  async provision() { throw new Error("FixtureProvider.provision() must be implemented."); }
  async seed() { throw new Error("FixtureProvider.seed() must be implemented."); }
  getTargetBinding() { throw new Error("FixtureProvider.getTargetBinding() must be implemented."); }
  async injectFault() { throw new Error("FixtureProvider.injectFault() must be implemented."); }
  async verifyOutcome() { throw new Error("FixtureProvider.verifyOutcome() must be implemented."); }
  async reset() { throw new Error("FixtureProvider.reset() must be implemented."); }
  async dispose() { throw new Error("FixtureProvider.dispose() must be implemented."); }
}

export function assertFixtureProvider(provider) {
  for (const method of ["provision", "seed", "getTargetBinding", "injectFault", "verifyOutcome", "reset", "dispose"]) {
    if (typeof provider?.[method] !== "function") throw new TypeError(`Fixture provider requires ${method}().`);
  }
  return provider;
}
