import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { launchOwnedChrome } from "../src/browser/ownedChrome.js";
import { ApplicationRunService } from "../src/navigation/applicationRunService.js";
import { createRunStateFixture } from "./runStateFixture.js";

const chromeExecutable = process.env.CHROME_PATH ?? process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

test("a real Chrome target reattaches after a dispatched same-tab navigation without replay", {
  skip: !existsSync(chromeExecutable),
  timeout: 60_000
}, async () => {
  const requests = { source: 0, destination: 0 };
  const server = createServer((request, response) => {
    if (request.url === "/") requests.source++;
    if (request.url === "/destination-page") requests.destination++;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(request.url === "/destination-page"
      ? "<!doctype html><title>Destination Page</title><h1>Destination Page</h1>"
      : "<!doctype html><title>Source Page</title><h1>Source Page</h1><a href='/destination-page'>Open Destination Page</a>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const origin = `http://127.0.0.1:${server.address().port}`;
  const runState = await createRunStateFixture("activetab-target-reattach-integration-");
  let owned = null;
  let injectedDetach = false;

  try {
    owned = await launchOwnedChrome({ initialUrl: `${origin}/`, headed: true });
    const originalSession = owned.session;
    const waitForChange = originalSession.waitForChange.bind(originalSession);
    originalSession.waitForChange = async (...args) => {
      await waitForChange(...args);
      if (!injectedDetach) {
        injectedDetach = true;
        const ownsBrowserClient = originalSession.ownsBrowserClient;
        originalSession.ownsBrowserClient = false;
        try { await originalSession.close(); }
        finally { originalSession.ownsBrowserClient = ownsBrowserClient; }
        throw new Error("Target detached during post-navigation observation.");
      }
    };

    const environment = { environmentId: "local-target-reattach", authorizedOrigins: [origin] };
    const service = new ApplicationRunService({ runStateStore: runState.store });
    const result = await service.runNavigation({
      session: originalSession,
      leaseOwner: "target-reattach-integration-run",
      goal: "Open the Destination Page",
      engineOptions: {
        environment,
        maxActions: 1,
        maxRecoveries: 0,
        planner: {
          async plan(_goal, observation) {
            const candidate = observation.candidates.find(item => item.name === "Open Destination Page");
            return candidate
              ? { status: "planned", action: { type: "click", target: candidate } }
              : { status: "unavailable", reason: "The local destination link was not observed." };
          }
        }
      }
    });

    assert.equal(injectedDetach, true);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.page.title, "Destination Page");
    assert.equal(requests.source, 1, "the source page loads once");
    assert.equal(requests.destination, 1, "the dispatched destination navigation is not replayed");
  } finally {
    if (owned) {
      const cleanup = await owned.close();
      assert.equal(cleanup.processStopped, true, JSON.stringify(cleanup));
      assert.equal(cleanup.profileRemoved, true, JSON.stringify(cleanup));
    }
    await runState.cleanup();
    await new Promise(resolve => server.close(resolve));
  }
});
