import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { launchOwnedChrome, parseChromeWindowPosition } from "../src/browser/ownedChrome.js";
import { createBrowserEnvironmentProfile, initializeOwnedBrowserEnvironment } from "../src/browser/browserEnvironment.js";
import { chromeWindowPositionArgs, resolveChromeWindowPosition } from "../src/browser/chromeWindowPlacement.js";

const requestedWindowPosition = resolveChromeWindowPosition();

test("owned headed Chrome window stays on the configured test display", {
  skip: !requestedWindowPosition
}, async () => {
  const server = createServer((_request, response) => response.end("display placement fixture"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { x, y } = requestedWindowPosition;
  let browser;
  try {
    browser = await launchOwnedChrome({
      initialUrl: `http://127.0.0.1:${server.address().port}/`,
      allowPrivateAddress: true,
      headed: true
    });
    const window = await browser.session.transport.send("Browser.getWindowForTarget", { targetId: browser.targetId });
    const viewport = await browser.session.client.send("Runtime.evaluate", {
      expression: "({screenX,screenY,devicePixelRatio})",
      returnByValue: true
    });
    assert.deepEqual(browser.windowBounds && { left: browser.windowBounds.left, top: browser.windowBounds.top }, { left: x, top: y });
    assert.equal(window.bounds.left, x);
    assert.equal(window.bounds.top, y);
    assert.equal(viewport.result.value.screenX, x);
    assert.equal(viewport.result.value.screenY, y);
    assert.ok(viewport.result.value.devicePixelRatio > 0);
    const cleanup = await browser.close();
    browser = null;
    assert.equal(cleanup.processStopped, true);
    assert.equal(cleanup.profileRemoved, true);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test("browser environment profiles validate explicit bounded settings", () => {
  assert.deepEqual(createBrowserEnvironmentProfile(), {
    locale: null, timeZone: null, viewport: null, geolocation: null
  });
  assert.deepEqual(createBrowserEnvironmentProfile({
    locale: "en-us",
    timeZone: "America/Chicago",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1.25 },
    geolocation: { latitude: 41.8, longitude: -87.6 }
  }), {
    locale: "en-US",
    timeZone: "America/Chicago",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1.25 },
    geolocation: { latitude: 41.8, longitude: -87.6, accuracy: 100 }
  });
  assert.throws(() => createBrowserEnvironmentProfile({ locale: "not a locale" }), /valid BCP 47/u);
  assert.throws(() => createBrowserEnvironmentProfile({ timeZone: "Mars/Olympus" }), /supported IANA/u);
  assert.throws(() => createBrowserEnvironmentProfile({ viewport: { width: 100, height: 800 } }), /bounded integer dimensions/u);
  assert.throws(() => createBrowserEnvironmentProfile({ geolocation: { latitude: 91, longitude: 0 } }), /valid explicit/u);
  assert.throws(() => createBrowserEnvironmentProfile({ userAgent: "fake" }), /unsupported settings/u);
});

test("Chrome window position accepts desktop coordinates and rejects malformed values", () => {
  assert.deepEqual(parseChromeWindowPosition("2880,0"), { x: 2880, y: 0 });
  assert.deepEqual(parseChromeWindowPosition("-1920,120"), { x: -1920, y: 120 });
  assert.equal(parseChromeWindowPosition(undefined), null);
  assert.throws(() => parseChromeWindowPosition("2880;0"), /x,y form/u);
  assert.throws(() => parseChromeWindowPosition("99999,0"), /desktop coordinate range/u);
});

test("Chrome display selection resolves main, secondary, overrides, and launch flags", () => {
  assert.deepEqual(resolveChromeWindowPosition({ env: {} }), { x: 1440, y: 0 });
  assert.deepEqual(resolveChromeWindowPosition({ env: { ACTIVETAB_CHROME_DISPLAY: "main" } }), { x: 0, y: 0 });
  assert.deepEqual(resolveChromeWindowPosition({ env: { ACTIVETAB_CHROME_DISPLAY: "secondary" } }), { x: 1440, y: 0 });
  assert.deepEqual(resolveChromeWindowPosition({ env: {
    ACTIVETAB_CHROME_DISPLAY: "secondary", ACTIVETAB_CHROME_SECONDARY_POSITION: "1600,20"
  } }), { x: 1600, y: 20 });
  assert.deepEqual(resolveChromeWindowPosition({ env: {
    ACTIVETAB_CHROME_DISPLAY: "main", ACTIVETAB_CHROME_WINDOW_POSITION: "320,40"
  } }), { x: 320, y: 40 });
  assert.deepEqual(chromeWindowPositionArgs({ env: { ACTIVETAB_CHROME_DISPLAY: "secondary" } }), ["--window-position=1440,0"]);
  assert.throws(() => resolveChromeWindowPosition({ env: { ACTIVETAB_CHROME_DISPLAY: "third" } }), /main.*secondary/u);
});

test("owned environment setup preserves actual UA/client hints and browser permission defaults", async () => {
  const calls = [];
  const client = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { value: {
        userAgent: "Mozilla/5.0 Chrome/150.0.0.0",
        platform: "Linux x86_64",
        clientHints: { platform: "Linux", mobile: false, brands: [{ brand: "Chromium", version: "150" }] },
        language: "fr-FR", languages: ["fr-FR", "fr"], timeZone: "Asia/Tokyo",
        viewport: { width: 1280, height: 800, screenWidth: 1280, screenHeight: 800, deviceScaleFactor: 1.25 },
        webgl: { supported: true, version: "WebGL 2.0", shadingLanguage: "WebGL GLSL ES 3.00" },
        permissions: { notifications: "prompt", geolocation: "prompt" },
        storage: { cookiesEnabled: true, localStorageAvailable: true, estimate: null }
      } } };
      return {};
    }
  };
  const result = await initializeOwnedBrowserEnvironment(client, {
    browserVersion: "Chrome/150.0.7871.114",
    headed: false,
    startupOrigin: "https://example.test",
    profile: createBrowserEnvironmentProfile({
      locale: "fr-FR", timeZone: "Asia/Tokyo",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1.25 },
      geolocation: { latitude: 35.68, longitude: 139.69 }
    })
  });
  assert.equal(result.browserVersion, "Chrome/150.0.7871.114");
  assert.equal(result.browserFamily, "Chromium-derived");
  assert.equal(result.headed, false);
  assert.match(result.observed.userAgent, /Chrome\/150/u);
  assert.equal(result.observed.clientHints.platform, "Linux");
  assert.equal(result.observed.platform, "Linux x86_64");
  assert.equal(result.observed.timeZone, "Asia/Tokyo");
  assert.equal(result.observed.webgl.supported, true);
  assert.equal(result.configuration.userAgentStringChanged, false);
  assert.equal(result.configuration.permissionsGranted, false);
  assert.deepEqual(calls.map(call => call.method), [
    "Runtime.evaluate", "Emulation.setLocaleOverride", "Emulation.setTimezoneOverride", "Emulation.setGeolocationOverride",
    "Emulation.setDeviceMetricsOverride", "Emulation.setUserAgentOverride", "Runtime.evaluate"
  ]);
  const uaOverride = calls.find(call => call.method === "Emulation.setUserAgentOverride");
  assert.deepEqual(uaOverride.params, {
    userAgent: "Mozilla/5.0 Chrome/150.0.0.0",
    platform: "Linux x86_64",
    acceptLanguage: "fr-FR"
  });
  assert.equal(calls.some(call => call.method === "Browser.grantPermissions"), false);
});

test("environment overrides are refused for an existing target before any browser connection", async () => {
  await assert.rejects(launchOwnedChrome({
    initialUrl: "https://example.test/",
    attachExistingTargetId: "operator-target",
    userDataDir: "/unused/profile",
    preserveProfile: true,
    allowedExistingOrigins: ["https://example.test"],
    environmentProfile: { locale: "fr-FR" }
  }), /never an attached or persistent browser/u);
});

const chromeExecutable = process.env.CHROME_PATH ?? process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

test("owned Chrome applies explicit locale, timezone, and viewport before the first site request", {
  skip: !existsSync(chromeExecutable),
  timeout: 60_000
}, async () => {
  let firstRequestHeaders = null;
  const server = createServer((request, response) => {
    firstRequestHeaders = request.headers;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>Environment fixture</title><script>window.observedEnvironment={language:navigator.language,languages:[...navigator.languages],timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},userAgent:navigator.userAgent,platform:navigator.platform,clientHints:navigator.userAgentData?{platform:navigator.userAgentData.platform,mobile:navigator.userAgentData.mobile}:null}</script><main>Ready</main>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  let owner = null;
  try {
    owner = await launchOwnedChrome({
      initialUrl: origin,
      headed: false,
      environmentProfile: {
        locale: "fr-FR",
        timeZone: "Asia/Tokyo",
        viewport: { width: 960, height: 720, deviceScaleFactor: 1.25 }
      }
    });
    assert.equal(firstRequestHeaders?.["accept-language"], "fr-FR");
    const observed = await owner.session.client.send("Runtime.evaluate", {
      expression: "window.observedEnvironment",
      returnByValue: true,
      awaitPromise: false
    });
    const page = observed.result.value;
    assert.match(page.language, /^fr/u);
    assert.match(page.languages[0], /^fr/u);
    assert.equal(page.timezone, "Asia/Tokyo");
    assert.deepEqual(page.viewport, { width: 960, height: 720, dpr: 1.25 });
    assert.equal(page.userAgent, owner.browserEnvironment.observed.userAgent);
    assert.equal(page.platform, owner.browserEnvironment.observed.platform);
    assert.equal(owner.browserEnvironment.configuration.userAgentStringChanged, false);
    assert.equal(owner.readiness.environment.browserVersion, owner.browserVersion);
    assert.equal(owner.launchMode, "headless (explicit opt-in)");
  } finally {
    if (owner) await owner.close();
    await new Promise(resolve => server.close(resolve));
  }
});
