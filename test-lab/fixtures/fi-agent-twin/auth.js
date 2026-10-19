import { randomBytes, randomUUID } from "node:crypto";

const FIXTURE_USER = "lab-user";
const FIXTURE_PASSWORD = "lab-password";
const FIXTURE_MFA = "246810";

/** Owns fixture credentials, realm-bound sessions, and one-time MFA challenges. */
export function createFixtureAuthService({ sessionTtlMs, getScenario, send, readForm, cookieValue, renderPlatformLogin, renderAgentLogin }) {
  const sessions = new Map();
  const pendingMfa = new Map();

  function addSession(realm) {
    const token = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + sessionTtlMs;
    sessions.set(token, { realm, expiresAt, sessionId: randomUUID() });
    return { token, expiresAt };
  }

  function getSession(request, realm) {
    const name = realm === "platform" ? "platform_session" : "agent_session";
    const token = cookieValue(request, name);
    const value = token ? sessions.get(token) : null;
    if (!value || value.realm !== realm || value.expiresAt <= Date.now()) return null;
    return value;
  }

  async function handleLogin(request, response, realm) {
    const form = await readForm(request).catch(error => {
      send(response, error.status ?? 400, "Invalid login request.", "text/plain; charset=utf-8");
      return null;
    });
    if (!form || response.writableEnded) return;
    if (form.get("username") !== FIXTURE_USER || form.get("password") !== FIXTURE_PASSWORD) {
      return send(response, 401, "Invalid fixture credentials.", "text/plain; charset=utf-8");
    }
    const scenario = getScenario();
    const requiresMfa = realm === "platform"
      ? scenario.application.require_platform_mfa === true
      : scenario.application.require_agent_mfa === true;
    if (requiresMfa) {
      const challenge = randomBytes(24).toString("base64url");
      pendingMfa.set(challenge, realm);
      const renderer = realm === "platform" ? renderPlatformLogin : renderAgentLogin;
      const cookieName = realm === "platform" ? "platform_mfa" : "agent_mfa";
      return send(response, 200, renderer({ mfa: true }), "text/html; charset=utf-8", {
        "set-cookie": `${cookieName}=${challenge}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`
      });
    }
    const session = addSession(realm);
    const cookieName = realm === "platform" ? "platform_session" : "agent_session";
    const location = realm === "platform" ? "/" : "/app";
    return send(response, 303, "", "text/plain; charset=utf-8", {
      location,
      "set-cookie": `${cookieName}=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=900`
    });
  }

  async function handleMfa(request, response, realm) {
    const form = await readForm(request).catch(error => {
      send(response, error.status ?? 400, "Invalid MFA request.", "text/plain; charset=utf-8");
      return null;
    });
    if (!form || response.writableEnded) return;
    const challengeName = realm === "platform" ? "platform_mfa" : "agent_mfa";
    const challenge = cookieValue(request, challengeName);
    if (form.get("code") !== FIXTURE_MFA || pendingMfa.get(challenge) !== realm) {
      return send(response, 401, "Invalid fixture MFA code.", "text/plain; charset=utf-8");
    }
    pendingMfa.delete(challenge);
    const session = addSession(realm);
    const cookieName = realm === "platform" ? "platform_session" : "agent_session";
    const location = realm === "platform" ? "/" : "/app";
    return send(response, 303, "", "text/plain; charset=utf-8", {
      location,
      "set-cookie": `${cookieName}=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=900`
    });
  }

  function reset() {
    sessions.clear();
    pendingMfa.clear();
  }

  return Object.freeze({ addSession, getSession, handleLogin, handleMfa, reset });
}
