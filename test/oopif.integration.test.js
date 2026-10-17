import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connectChromeAuto, listChromeTargets, resolveChromeTarget } from "../src/browser/chrome-autoconnect.js";
import { BrowserSession } from "../src/browser/session.js";
import { NavigationEngine } from "../src/navigation/engine.js";

const chromePath = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

test("native CDP recursively attaches, observes, and controls nested out-of-process iframes", { timeout: 90_000 }, async t => {
  let chrome;
  let connection;
  let session;
  let childServer;
  let parentServer;
  let profileDir;
  let parentPort;
  try {
    childServer = createServer((request, response) => {
      if (request.url?.startsWith("/api?")) {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ loaded: true, access_token: "fixture-oopif-secret" }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><title>OOPIF child</title><script>globalThis.__activetabFrameState__={frameLabel:'cross-origin runtime fixture'};addEventListener('message',event=>{if(event.origin==='http://127.0.0.1:${parentPort}'&&event.data?.kind==='remove-nested'){globalThis.__nestedRemovalRequested=true;document.querySelector('iframe')?.remove()}})</script><h1>Child</h1><a href='/child-destination?token=child-url-secret'>Child account</a><label>Password <input type=password value=oopif-secret></label><button onclick=\"document.querySelector('h1').textContent='OOPIF preferences';parent.postMessage({kind:'oopif-open'}, '*')\">Open OOPIF preferences</button>`);
    });
    childServer.listen(0, "127.0.0.1");
    await once(childServer, "listening");
    const childPort = childServer.address().port;
    parentServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (_request.url?.startsWith("/nested")) {
        response.end("<!doctype html><title>Nested OOPIF child</title><h1>Nested</h1><button onclick=\"document.querySelector('h1').textContent='Nested preferences';parent.parent.postMessage({kind:'nested-open'}, '*')\">Open nested preferences</button>");
        return;
      }
      response.end(`<!doctype html><title>OOPIF parent</title><h1>Parent</h1><button onclick="document.querySelector('h1').textContent='Account';document.title='Account'">Open account</button><iframe src="http://localhost:${childPort}/?token=oopif-url-secret"></iframe><script>addEventListener('message',event=>{if(event.origin==='http://localhost:${childPort}'&&event.data?.kind==='oopif-open'){document.querySelector('h1').textContent='OOPIF preferences';document.title='OOPIF preferences'}else if(event.origin==='http://127.0.0.1:${parentPort}'&&event.data?.kind==='nested-open'){document.querySelector('h1').textContent='Nested preferences';document.title='Nested preferences'}})</script>`);
    });
    parentServer.listen(0, "127.0.0.1");
    await once(parentServer, "listening");
    parentPort = parentServer.address().port;
    profileDir = await mkdtemp(join(tmpdir(), "activetab-oopif-profile-"));
    chrome = spawn(chromePath, [
      ...(process.env.ACTIVETAB_HEADLESS === "1" ? ["--headless=new"] : []),
      "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--site-per-process",
      "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, `http://127.0.0.1:${parentPort}/`
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", chunk => { stderr += chunk.slice(-5000); });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const poll = setInterval(() => {
        if (/DevTools listening on ws:\/\/127\.0\.0\.1:\d+\//.test(stderr)) { clearInterval(poll); resolve(); }
        else if (Date.now() > deadline || chrome.exitCode !== null) { clearInterval(poll); reject(new Error(`Chrome startup failed: ${stderr}`)); }
      }, 50);
    });
    connection = await connectChromeAuto({ userDataDir: profileDir });
    const page = (await listChromeTargets(connection)).find(target => target.url.includes(`127.0.0.1:${parentPort}`));
    assert.ok(page, "Chrome exposes the parent fixture page");
    session = await new BrowserSession(await resolveChromeTarget(connection, page.id, page.id)).attach();
    let attached = [];
    const frameDeadline = Date.now() + 5_000;
    while (Date.now() < frameDeadline && attached.length < 1) {
      attached = await session.getOutOfProcessFrames();
      if (attached.length < 1) await new Promise(resolve => setTimeout(resolve, 50));
    }
    const targetInfos = (await connection.client.send("Target.getTargets")).targetInfos;
    const iframeTarget = targetInfos.find(item => item.type === "iframe" && item.parentId === page.id);
    assert.ok(iframeTarget, "Chrome exposes the cross-site frame as an iframe target");
    const childFrameSession = attached.find(frame => frame.targetId === iframeTarget.targetId);
    assert.ok(childFrameSession, "the direct OOPIF belongs to the authorized page target");
    await childFrameSession.client.send("Runtime.evaluate", { expression: `const nested=document.createElement('iframe');nested.src='http://127.0.0.1:${parentPort}/nested';document.body.append(nested)` });
    const nestedDeadline = Date.now() + 5_000;
    while (Date.now() < nestedDeadline && attached.length < 2) {
      attached = await session.getOutOfProcessFrames();
      if (attached.length < 2) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(attached.length, 2, "the browser adapter recursively attaches to both OOPIF levels");
    assert.ok(attached.every(frame => frame.status === "ready"));
    const nestedFrameSession = attached.find(frame => frame.targetId !== iframeTarget.targetId);
    assert.ok(nestedFrameSession, "the nested OOPIF is attached as a child target");
    const observation = await session.observe();
    const frameRuntime = await session.observer.inspectRuntimeState(observation.evidenceId, { path: ["__activetabFrameState__", "frameLabel"], frameTargetId: childFrameSession.targetId });
    assert.equal(frameRuntime.status, "available", JSON.stringify(frameRuntime));
    assert.equal(frameRuntime.result.selected.valueRedacted, true, "runtime inspection can target an attached OOPIF while redacting values by default");
    const candidate = observation.candidates.find(item => item.name === "Open OOPIF preferences");
    const nestedCandidate = observation.candidates.find(item => item.name === "Open nested preferences");
    assert.ok(candidate, "the compact observation exposes a control from the direct out-of-process frame");
    assert.ok(nestedCandidate, "recursive auto-attach exposes a control from the nested out-of-process frame");
    assert.equal(candidate.frameTargetId, iframeTarget.targetId);
    assert.equal(observation.coverage.outOfProcessFramesObserved, 2);
    const frameEvidence = session.observer.getEvidence(observation.evidenceId, { facets: ["outOfProcessFrames"] }).outOfProcessFrames;
    assert.equal(frameEvidence.length, 2, "full DOMSnapshot and accessibility evidence for each OOPIF remains selectively retrievable");
    assert.ok(frameEvidence.some(frame => frame.targetId === iframeTarget.targetId && frame.page.url.startsWith("http://localhost:")));
    assert.equal(JSON.stringify(frameEvidence).includes("oopif-url-secret"), false, "OOPIF URL query values are redacted by default");
    const directEvidence = frameEvidence.find(frame => frame.targetId === childFrameSession.targetId);
    const nestedEvidence = frameEvidence.find(frame => frame.targetId === nestedFrameSession.targetId);
    assert.equal(nestedEvidence.parentFrameId, directEvidence.frameId, "the captured frame relation preserves the nested OOPIF parent");
    assert.equal(JSON.stringify(frameEvidence).includes("oopif-secret"), false, "OOPIF form values are redacted by default");
    const sensitiveFrameEvidence = session.observer.getEvidence(observation.evidenceId, { facets: ["outOfProcessFrames"], includeSensitiveFormValues: true }).outOfProcessFrames;
    assert.equal(JSON.stringify(sensitiveFrameEvidence).includes("oopif-secret"), true, "OOPIF form values are available only through explicit opt-in");
    const detail = session.observer.getEvidence(observation.evidenceId, { facets: ["selectedElement"], backendNodeId: candidate.backendNodeId, frameTargetId: candidate.frameTargetId });
    assert.equal(detail.selectedElement.name, "Open OOPIF preferences");
    const nestedDetail = session.observer.getEvidence(observation.evidenceId, { facets: ["selectedElement"], backendNodeId: nestedCandidate.backendNodeId, frameTargetId: nestedCandidate.frameTargetId });
    assert.equal(nestedDetail.selectedElement.name, "Open nested preferences");
    const childLink = observation.candidates.find(item => item.name === "Child account");
    const childLinkDetail = session.observer.getEvidence(observation.evidenceId, { facets: ["selectedElement"], backendNodeId: childLink.backendNodeId, frameTargetId: childLink.frameTargetId });
    assert.equal(childLinkDetail.selectedElement.attributes.href, `http://localhost:${childPort}/child-destination`, "relative OOPIF links resolve against their own frame URL");
    assert.equal(JSON.stringify(childLinkDetail).includes("child-url-secret"), false, "OOPIF selected-element URLs redact query values");
    await childFrameSession.client.send("Runtime.evaluate", { expression: "fetch('/api?session=oopif-network-secret').then(response=>response.json())", returnByValue: true, awaitPromise: true });
    const childResult = await new NavigationEngine(session, { maxActions: 2, maxRecoveries: 1 }).run("Open OOPIF preferences page");
    assert.equal(childResult.status, "succeeded", `the frame-target session can click the direct OOPIF control and verify its parent-page result: ${JSON.stringify(childResult)}`);
    assert.equal(childResult.page.title, "OOPIF preferences");
    const result = await new NavigationEngine(session, { maxActions: 2, maxRecoveries: 1 }).run("Open nested preferences page");
    assert.equal(result.status, "succeeded", `recursive frame sessions can click a nested OOPIF control and verify its parent-page result: ${JSON.stringify(result)}`);
    assert.equal(result.page.title, "Nested preferences");
    const activity = session.observer.getEvidence(result.evidenceId, { facets: ["networkActivity", "domMutations"] });
    const frameApiRequest = activity.networkActivity.find(request => request.frameTargetId === candidate.frameTargetId && request.url.includes("/api"));
    assert.ok(frameApiRequest, "OOPIF network activity retains its frame-target provenance");
    assert.equal(JSON.stringify(activity).includes("oopif-network-secret"), false, "OOPIF request query values are redacted by default");
    const hiddenFrameBody = await session.observer.inspectNetworkResponse(result.evidenceId, { requestId: frameApiRequest.requestId });
    assert.equal(hiddenFrameBody.responseBody.status, "not_returned", "OOPIF response bodies stay hidden by default");
    assert.equal(JSON.stringify(hiddenFrameBody).includes("fixture-oopif-secret"), false);
    const selectedFrameBody = await session.observer.inspectNetworkResponse(result.evidenceId, { requestId: frameApiRequest.requestId, includeSensitive: true });
    assert.equal(selectedFrameBody.responseBody.status, "included", "selected OOPIF responses use the matching frame CDP session");
    assert.ok(selectedFrameBody.responseBody.data.includes("fixture-oopif-secret"));
    assert.ok(activity.domMutations.some(mutation => mutation.frameTargetId === candidate.frameTargetId), "direct OOPIF DOM mutations retain their frame-target provenance");
    assert.ok(activity.domMutations.some(mutation => mutation.frameTargetId === nestedCandidate.frameTargetId), "nested OOPIF DOM mutations retain their frame-target provenance");

    await nestedFrameSession.client.send("Runtime.evaluate", { expression: "const close=document.createElement('button');close.textContent='Close nested frame';close.onclick=()=>parent.postMessage({kind:'remove-nested'},'*');document.body.append(close)" });
    const detachObservation = await session.observe();
    const closeNested = detachObservation.candidates.find(item => item.name === "Close nested frame");
    const fallbackAccountAction = detachObservation.candidates.find(item => item.name === "Open account");
    assert.ok(closeNested, "a test action is available inside the nested OOPIF");
    assert.ok(fallbackAccountAction, "a recovery action remains available in the top-level page");
    const nativeSessionClick = session.click.bind(session);
    const dispatchedIdentities = [];
    const plannerSelections = [];
    const planningEvidenceIds = [];
    session.click = async target => {
      dispatchedIdentities.push(target.identity);
      let dispatchError;
      try { await nativeSessionClick(target); }
      catch (error) {
        if (target.name !== "Close nested frame") throw error;
        dispatchError = error;
      }
      if (target.name === "Close nested frame") {
        const detachDeadline = Date.now() + 3_000;
        while (Date.now() < detachDeadline && session.frameSessions.has(nestedFrameSession.targetId)) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(session.frameSessions.has(nestedFrameSession.targetId), false, "the nested target detaches during native input dispatch");
        const acknowledgement = await childFrameSession.client.send("Runtime.evaluate", { expression: "globalThis.__nestedRemovalRequested===true", returnByValue: true });
        assert.equal(acknowledgement.result?.value, true, "the cross-origin parent handled the click message and removed the nested iframe");
        throw new Error(`Injected lost action result after OOPIF detach${dispatchError ? `: ${dispatchError.message}` : ""}`);
      }
    };
    const detachPlanner = {
      calls: 0,
      async plan(_goal, observation) {
        this.calls++;
        const label = this.calls === 1 ? "Close nested frame" : "Open account";
        const target = observation.candidates.find(item => item.name === label);
        plannerSelections.push(target?.identity);
        planningEvidenceIds.push(observation.evidenceId);
        return target ? { status: "planned", action: { type: "click", target } } : { status: "ambiguous", reason: `Fresh observation has no ${label} control.` };
      }
    };
    const detachJournal = { value: undefined, async write(value) { this.value = structuredClone(value); } };
    const detachRun = await new NavigationEngine(session, { planner: detachPlanner, journal: detachJournal, maxActions: 3, maxRecoveries: 1 }).run("Open the account page");
    session.click = nativeSessionClick;
    assert.equal(detachRun.status, "succeeded", JSON.stringify(detachRun));
    assert.equal(detachRun.attempts, 2);
    assert.equal(detachRun.recoveries, 1);
    assert.equal(detachRun.page.title, "Account");
    assert.match(detachJournal.value.attempts[0].error.message, /lost action result after OOPIF detach/);
    assert.deepEqual(dispatchedIdentities, plannerSelections, "each dispatched identity came from the corresponding fresh planner observation");
    assert.ok(planningEvidenceIds.every(evidenceId => evidenceId !== detachObservation.evidenceId), "the engine does not plan from the fixture's earlier captured evidence");
    assert.notEqual(planningEvidenceIds[1], planningEvidenceIds[0], "recovery replans from new browser evidence after the frame detach");
    t.diagnostic(`Chrome ${chromePath}: attached two recursive OOPIF targets and verified both navigation actions`);
    await childFrameSession.client.send("Runtime.evaluate", { expression: "document.querySelector('iframe').remove()" });
    const detachDeadline = Date.now() + 3_000;
    while (Date.now() < detachDeadline && session.frameSessions.size > 1) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(session.frameSessions.size, 1, "removing a nested iframe releases its child target session");
    await session.client.send("Runtime.evaluate", { expression: "document.querySelector('iframe').remove()" });
    while (Date.now() < detachDeadline && session.frameSessions.size > 0) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(session.frameSessions.size, 0, "removing the direct iframe releases its nested target session");
    const attachedTargetIds = new Set(attached.map(frame => frame.targetId));
    await session.close();
    session = undefined;
    const remainingAttached = (await connection.client.send("Target.getTargets")).targetInfos.filter(info => attachedTargetIds.has(info.targetId) && info.attached);
    assert.equal(remainingAttached.length, 0, "closing the authorized tab session detaches its recursive OOPIF sessions");
  } finally {
    if (session) await session.close().catch(() => {});
    if (connection) await connection.close().catch(() => {});
    if (chrome && chrome.exitCode === null) {
      try { process.kill(-chrome.pid, "SIGTERM"); } catch { chrome.kill("SIGTERM"); }
      await Promise.race([once(chrome, "exit"), new Promise(resolve => setTimeout(resolve, 1000))]);
      if (chrome.exitCode === null) { try { process.kill(-chrome.pid, "SIGKILL"); } catch { chrome.kill("SIGKILL"); } }
    }
    if (parentServer) await new Promise(resolve => parentServer.close(resolve));
    if (childServer) await new Promise(resolve => childServer.close(resolve));
    if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
