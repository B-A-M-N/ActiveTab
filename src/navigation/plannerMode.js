/** Resolve the CLI planner override while keeping auto as its public default. */
export function plannerModeFromArgs(args = []) {
  const index = Array.isArray(args) ? args.indexOf("--planner-mode") : -1;
  return index >= 0 ? args[index + 1] ?? "auto" : "auto";
}
