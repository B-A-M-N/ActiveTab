import test from "node:test";
import assert from "node:assert/strict";
import { createFixtureAuthService } from "../test-lab/fixtures/fi-agent-twin/auth.js";
import { cookieValue, send } from "../test-lab/fixtures/fi-agent-twin/http.js";
import { renderPlatformLogin, renderAgentLogin } from "../test-lab/fixtures/fi-agent-twin/frontend.js";

function request(body = "", headers = {}) {
  return {
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); }
  };
}

function response() {
  return {
    headers: {},
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; this.writableEnded = true; }
  };
}

function makeAuth(scenario) {
  return createFixtureAuthService({
    sessionTtlMs: 60_000,
    getScenario: () => scenario,
    send,
    readForm: async req => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    },
    cookieValue,
    renderPlatformLogin,
    renderAgentLogin
  });
}

const validCredentials = "username=lab-user&password=lab-password";

test("FI Twin sessions remain bound to separate platform and Cloud Agent realms", async () => {
  const auth = makeAuth({ application: {} });
  const platformResponse = response();
  await auth.handleLogin(request(validCredentials), platformResponse, "platform");
  const platformToken = cookieValue({ headers: { cookie: platformResponse.headers["set-cookie"] } }, "platform_session");
  assert.equal(platformResponse.status, 303);
  assert.ok(auth.getSession({ headers: { cookie: `platform_session=${platformToken}` } }, "platform"));
  assert.equal(auth.getSession({ headers: { cookie: `agent_session=${platformToken}` } }, "cloud-agent"), null);

  const agentResponse = response();
  await auth.handleLogin(request(validCredentials), agentResponse, "cloud-agent");
  const agentToken = cookieValue({ headers: { cookie: agentResponse.headers["set-cookie"] } }, "agent_session");
  assert.ok(auth.getSession({ headers: { cookie: `agent_session=${agentToken}` } }, "cloud-agent"));
  assert.equal(auth.getSession({ headers: { cookie: `platform_session=${agentToken}` } }, "platform"), null);
});

test("FI Twin MFA challenges are realm-bound and invalid credentials create no session", async () => {
  const auth = makeAuth({ application: { require_platform_mfa: true, require_agent_mfa: false } });
  const badLogin = response();
  await auth.handleLogin(request("username=wrong&password=wrong"), badLogin, "platform");
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.headers["set-cookie"], undefined);

  const platformMfa = response();
  await auth.handleLogin(request(validCredentials), platformMfa, "platform");
  assert.equal(platformMfa.status, 200);
  const challenge = cookieValue({ headers: { cookie: platformMfa.headers["set-cookie"] } }, "platform_mfa");

  const crossRealm = response();
  await auth.handleMfa(request("code=246810", { cookie: `platform_mfa=${challenge}` }), crossRealm, "cloud-agent");
  assert.equal(crossRealm.status, 401);

  const badCode = response();
  await auth.handleMfa(request("code=000000", { cookie: `platform_mfa=${challenge}` }), badCode, "platform");
  assert.equal(badCode.status, 401);

  const verified = response();
  await auth.handleMfa(request("code=246810", { cookie: `platform_mfa=${challenge}` }), verified, "platform");
  assert.equal(verified.status, 303);
  const token = cookieValue({ headers: { cookie: verified.headers["set-cookie"] } }, "platform_session");
  assert.ok(auth.getSession({ headers: { cookie: `platform_session=${token}` } }, "platform"));
});
