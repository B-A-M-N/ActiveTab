import { NavigationEngine as RuntimeNavigationEngine } from "../src/navigation/engine.js";

const fixtureLeaseAssertion = async () => {};
const normalizedSessions = new WeakSet();

function normalizeFixtureSession(session) {
  if (!session || typeof session.observe !== "function" || normalizedSessions.has(session)) return;
  const originalObserve = session.observe.bind(session);
  session.attached = true;
  session.target ??= { id: "fixture-target", endpoint: "test-fixture" };
  session.observe = async (...args) => {
    const observation = await originalObserve(...args);
    return observation?.targetId || !session.target?.id
      ? observation
      : { ...observation, targetId: session.target.id };
  };
  normalizedSessions.add(session);
}

/**
 * NavigationEngine for deterministic test sessions and disposable local
 * browser fixtures. Production entrypoints must acquire a durable target
 * lease and pass its assertion directly.
 */
export class FixtureNavigationEngine extends RuntimeNavigationEngine {
  constructor(session, options = {}) {
    normalizeFixtureSession(session);
    super(session, {
      ...options,
      assertExecutionLease: options.assertExecutionLease ?? fixtureLeaseAssertion
    });
  }
}
