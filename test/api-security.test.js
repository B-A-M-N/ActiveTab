import test from "node:test";
import assert from "node:assert/strict";
import { createMutationAuthorizer, checkHost, checkOrigin, isLoopbackHost } from "../src/api/security.js";

function fakeRequest({ host = "127.0.0.1:9377", origin = null, authorization = null } = {}) {
  return { headers: { host, ...(origin ? { origin } : {}), ...(authorization ? { authorization } : {}) } };
}

test("createMutationAuthorizer rejects mutations when no token is configured", () => {
  const authorizer = createMutationAuthorizer(null);
  assert.equal(authorizer(fakeRequest()), false, "No-token deployments must not silently allow mutations.");
  assert.equal(authorizer(fakeRequest({ authorization: "Bearer x" })), false);
});

test("createMutationAuthorizer allows mutations when a valid token is presented", () => {
  const token = "test-secret-token";
  const authorizer = createMutationAuthorizer(token);
  assert.equal(authorizer(fakeRequest({ authorization: `Bearer ${token}` })), true);
  assert.equal(authorizer(fakeRequest({ authorization: "Bearer wrong" })), false);
  assert.equal(authorizer(fakeRequest({ authorization: "Bearer wrong", origin: "http://127.0.0.1:9377" })), false);
});

test("createMutationAuthorizer rejects cross-origin bearer tokens", () => {
  const token = "test-secret-token";
  const authorizer = createMutationAuthorizer(token);
  assert.equal(authorizer(fakeRequest({ authorization: `Bearer ${token}`, origin: "https://evil.example" })), false);
});

test("checkHost rejects non-loopback hosts", () => {
  const responses = [];
  const sendError = (res, code, subCode, message) => responses.push({ code, subCode, message });
  assert.equal(checkHost(fakeRequest({ host: "evil.example" }), {}, sendError), false);
  assert.equal(responses.length, 1);
});

test("checkHost accepts loopback hosts", () => {
  assert.equal(checkHost(fakeRequest({ host: "127.0.0.1:9377" }), {}, () => {}), true);
  assert.equal(checkHost(fakeRequest({ host: "localhost:9377" }), {}, () => {}), true);
});

test("checkOrigin rejects non-browser origins", () => {
  const responses = [];
  const sendError = (res, code, subCode, message) => responses.push({ code, subCode, message });
  assert.equal(checkOrigin(fakeRequest({ origin: "https://evil.example" }), {}, sendError), false);
  assert.equal(responses.length, 1);
});

test("checkOrigin allows loopback and chrome-extension origins", () => {
  assert.equal(checkOrigin(fakeRequest({ origin: "http://127.0.0.1:9377" }), {}, () => {}), true);
  assert.equal(checkOrigin(fakeRequest({ origin: "chrome-extension://abc" }), {}, () => {}), true);
});
