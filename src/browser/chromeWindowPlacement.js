/** Resolve a requested position for a new Chrome window. Coordinates use
 * Chrome desktop coordinates (device-independent pixels). */
export function parseChromeWindowPosition(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 24) throw new Error("Chrome window position must use the bounded x,y form.");
  const match = value.match(/^(-?\d{1,5}),(-?\d{1,5})$/u);
  if (!match) throw new Error("Chrome window position must use the bounded x,y form.");
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (x < -16_384 || x > 16_384 || y < -16_384 || y > 16_384) {
    throw new Error("Chrome window position is outside the supported desktop coordinate range.");
  }
  return Object.freeze({ x, y });
}

export function resolveChromeWindowPosition({ env = process.env, position } = {}) {
  const explicitPosition = position ?? env.ACTIVETAB_CHROME_WINDOW_POSITION;
  if (explicitPosition !== undefined && explicitPosition !== null && explicitPosition !== "") {
    return parseChromeWindowPosition(explicitPosition);
  }

  const display = env.ACTIVETAB_CHROME_DISPLAY;
  if (display === undefined || display === "") return null;
  if (display === "main") return parseChromeWindowPosition(env.ACTIVETAB_CHROME_MAIN_POSITION ?? "0,0");
  if (display === "secondary") return parseChromeWindowPosition(env.ACTIVETAB_CHROME_SECONDARY_POSITION ?? "1440,0");
  throw new Error("ACTIVETAB_CHROME_DISPLAY must be 'main' or 'secondary'.");
}

export function chromeWindowPositionArgs(options = {}) {
  const position = resolveChromeWindowPosition(options);
  return position ? [`--window-position=${position.x},${position.y}`] : [];
}
