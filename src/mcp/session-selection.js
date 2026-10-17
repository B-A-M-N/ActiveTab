export function selectBrowserSession(sessions, targetId) {
  let session;
  if (targetId !== undefined) session = sessions.get(targetId);
  else if (sessions.size === 1) session = sessions.values().next().value;
  else if (sessions.size > 1) throw new Error("targetId is required when multiple tabs are attached.");
  if (!session) throw new Error("No explicitly authorized tab is attached for that targetId.");
  return session;
}
