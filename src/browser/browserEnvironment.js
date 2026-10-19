const MAX_VIEWPORT_WIDTH = 7_680;
const MAX_VIEWPORT_HEIGHT = 4_320;

function canonicalLocale(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 64) throw new Error("Browser locale must be a bounded BCP 47 locale string.");
  try { return Intl.getCanonicalLocales(value)[0] ?? null; }
  catch { throw new Error("Browser locale must be a valid BCP 47 locale string."); }
}

function canonicalTimeZone(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 80) throw new Error("Browser timezone must be a bounded IANA timezone string.");
  try { return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error("Browser timezone must be a supported IANA timezone."); }
}

function normalizeViewport(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isInteger(value.width) || value.width < 320 || value.width > MAX_VIEWPORT_WIDTH
    || !Number.isInteger(value.height) || value.height < 240 || value.height > MAX_VIEWPORT_HEIGHT
    || value.deviceScaleFactor !== undefined && (!Number.isFinite(value.deviceScaleFactor) || value.deviceScaleFactor < 0.5 || value.deviceScaleFactor > 3)) {
    throw new Error("Browser viewport requires bounded integer dimensions and an optional device scale from 0.5 to 3.");
  }
  return Object.freeze({ width: value.width, height: value.height, deviceScaleFactor: value.deviceScaleFactor ?? 1 });
}

function normalizeGeolocation(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90
    || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180
    || value.accuracy !== undefined && (!Number.isFinite(value.accuracy) || value.accuracy <= 0 || value.accuracy > 100_000)) {
    throw new Error("Browser geolocation requires valid explicit latitude, longitude, and optional accuracy.");
  }
  return Object.freeze({ latitude: value.latitude, longitude: value.longitude, accuracy: value.accuracy ?? 100 });
}

export function createBrowserEnvironmentProfile(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !["locale", "timeZone", "viewport", "geolocation"].includes(key))) {
    throw new Error("Browser environment profile contains unsupported settings.");
  }
  return Object.freeze({
    locale: canonicalLocale(options.locale),
    timeZone: canonicalTimeZone(options.timeZone),
    viewport: normalizeViewport(options.viewport),
    geolocation: normalizeGeolocation(options.geolocation)
  });
}

const ENVIRONMENT_PROBE = `async function(){
  const canvas=document.createElement('canvas');
  const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
  const permission=async name=>{try{return (await navigator.permissions.query({name})).state}catch{return 'unsupported'}};
  let storage=null;
  try{const estimate=await navigator.storage?.estimate?.();if(estimate)storage={usage:Number.isFinite(estimate.usage)?estimate.usage:null,quota:Number.isFinite(estimate.quota)?estimate.quota:null}}catch{}
  let clientHints=null;
  try{clientHints=navigator.userAgentData?{brands:navigator.userAgentData.brands.slice(0,8).map(item=>({brand:String(item.brand).slice(0,48),version:String(item.version).slice(0,24)})),mobile:navigator.userAgentData.mobile,platform:String(navigator.userAgentData.platform).slice(0,48)}:null}catch{}
  return {userAgent:String(navigator.userAgent).slice(0,512),platform:String(navigator.platform).slice(0,96),clientHints,language:String(navigator.language).slice(0,64),languages:Array.from(navigator.languages||[]).slice(0,8).map(value=>String(value).slice(0,64)),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||null,viewport:{width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,deviceScaleFactor:devicePixelRatio},webgl:{supported:!!gl,version:gl?String(gl.getParameter(gl.VERSION)).slice(0,64):null,shadingLanguage:gl?String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)).slice(0,64):null},permissions:{notifications:await permission('notifications'),geolocation:await permission('geolocation')},storage:{cookiesEnabled:navigator.cookieEnabled===true,localStorageAvailable:(()=>{try{localStorage.setItem('__activetab_probe','1');localStorage.removeItem('__activetab_probe');return true}catch{return false}})(),estimate:storage}};
}`;

async function readEnvironment(client) {
  const response = await client.send("Runtime.evaluate", {
    expression: `(${ENVIRONMENT_PROBE})()`,
    returnByValue: true,
    awaitPromise: true
  });
  const value = response?.result?.value;
  if (!value || typeof value !== "object") throw new Error("Chrome did not return a browser environment observation.");
  return value;
}

/** Apply only explicitly configured compatibility settings to a new owned target. */
export async function initializeOwnedBrowserEnvironment(client, {
  browserVersion,
  headed = true,
  profile = createBrowserEnvironmentProfile(),
  startupOrigin
} = {}) {
  if (!client?.send || typeof browserVersion !== "string" || !browserVersion
    || typeof startupOrigin !== "string" || !/^https?:\/\//u.test(startupOrigin)) {
    throw new Error("Owned browser initialization requires its actual CDP client, version, and validated startup origin.");
  }
  const defaults = await readEnvironment(client);
  if (profile.locale) await client.send("Emulation.setLocaleOverride", { locale: profile.locale });
  if (profile.timeZone) await client.send("Emulation.setTimezoneOverride", { timezoneId: profile.timeZone });
  if (profile.geolocation) await client.send("Emulation.setGeolocationOverride", profile.geolocation);
  if (profile.viewport) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: profile.viewport.width,
      height: profile.viewport.height,
      deviceScaleFactor: profile.viewport.deviceScaleFactor,
      mobile: false
    });
  }
  if (profile.locale) {
    const language = profile.locale;
    // Preserve Chromium's observed UA and platform while aligning the
    // language exposed by navigator with the explicit locale configuration.
    await client.send("Emulation.setUserAgentOverride", {
      userAgent: defaults.userAgent,
      platform: defaults.platform,
      acceptLanguage: language
    });
  }
  const observed = await readEnvironment(client);
  return Object.freeze({
    browserVersion: browserVersion.slice(0, 120),
    browserFamily: /\b(?:Google )?Chrome\//u.test(browserVersion) ? "Chromium-derived" : "Chromium-compatible",
    platform: observed.platform,
    headed: headed === true,
    startupOrigin: new URL(startupOrigin).origin,
    configuration: Object.freeze({
      locale: profile.locale,
      timeZone: profile.timeZone,
      viewport: profile.viewport,
      geolocationConfigured: Boolean(profile.geolocation),
      userAgentStringChanged: observed.userAgent !== defaults.userAgent,
      permissionsGranted: false
    }),
    observed
  });
}
