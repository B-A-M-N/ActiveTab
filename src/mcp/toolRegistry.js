/** Validate and dispatch the server-composed MCP tool catalog. */
export function createMcpToolDispatcher({ tools, handlerGroups }) {
  if (!Array.isArray(tools) || !Array.isArray(handlerGroups)) {
    throw new Error("MCP tool dispatch requires a catalog and handler groups.");
  }

  const handlers = new Map();
  for (const group of handlerGroups) {
    if (!group || typeof group !== "object") throw new Error("MCP handler groups must be objects.");
    for (const [name, handler] of Object.entries(group)) {
      if (typeof handler !== "function") throw new Error(`MCP handler '${name}' must be a function.`);
      if (handlers.has(name)) throw new Error(`Duplicate MCP handler for '${name}'.`);
      handlers.set(name, handler);
    }
  }

  const advertised = new Set();
  for (const tool of tools) {
    const name = tool?.name;
    if (typeof name !== "string" || !name) throw new Error("MCP catalog entries require a tool name.");
    if (advertised.has(name)) throw new Error(`Duplicate MCP catalog entry for '${name}'.`);
    advertised.add(name);
    if (!handlers.has(name)) throw new Error(`Advertised MCP tool '${name}' has no handler.`);
  }
  for (const name of handlers.keys()) {
    if (!advertised.has(name)) throw new Error(`MCP handler '${name}' is not advertised in the catalog.`);
  }

  return Object.freeze({
    has: name => handlers.has(name),
    async dispatch(name, args) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      return await handler(args);
    }
  });
}
