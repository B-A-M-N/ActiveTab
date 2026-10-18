/** Return stored event IDs that already reference one of the supplied evidence IDs. */
export function eventIdsForEvidence(eventStore, { episodeId, decisionId, evidenceIds = [], eventTypes = null } = {}) {
  if (!eventStore || typeof eventStore.getEvents !== "function" || !episodeId || !decisionId) return [];
  const requestedEvidence = new Set(evidenceIds.filter(value => typeof value === "string" && value.length > 0));
  if (!requestedEvidence.size) return [];
  const allowedTypes = eventTypes ? new Set(eventTypes) : null;
  return eventStore.getEvents(episodeId)
    .filter(event => event.decisionId === decisionId && (!allowedTypes || allowedTypes.has(event.eventType)))
    .filter(event => requestedEvidence.has(event.observationId)
      || (event.payload?.evidenceRefs ?? []).some(reference => requestedEvidence.has(reference)))
    .map(event => event.eventId);
}
