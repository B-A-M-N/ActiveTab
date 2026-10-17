function boundedText(value, max = 256) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

export class BrowserActivityRecorder {
  constructor({ maxRequests = 300, maxLifecycleEvents = 500, maxDomMutations = 500 } = {}) {
    this.maxRequests = Math.max(1, Math.min(maxRequests, 1_000));
    this.maxLifecycleEvents = Math.max(1, Math.min(maxLifecycleEvents, 2_000));
    this.maxDomMutations = Math.max(1, Math.min(maxDomMutations, 2_000));
    this.requests = [];
    this.latestRequestById = new Map();
    this.lifecycleEvents = [];
    this.domMutations = [];
    this.totalRequests = 0;
    this.totalLifecycleEvents = 0;
    this.totalDomMutations = 0;
    this.droppedRequests = 0;
    this.droppedLifecycleEvents = 0;
    this.droppedDomMutations = 0;
  }

  recordNetworkEvent(method, params = {}, { frameTargetId = null } = {}) {
    const protocolRequestId = boundedText(params.requestId, 200);
    const requestId = protocolRequestId && frameTargetId ? `${frameTargetId}:${protocolRequestId}` : protocolRequestId;
    if (method === "Network.requestWillBeSent") {
      const request = params.request ?? {};
      const previous = requestId ? this.latestRequestById.get(requestId) : undefined;
      if (previous && params.redirectResponse) {
        previous.status = Number.isFinite(params.redirectResponse.status) ? params.redirectResponse.status : previous.status;
        previous.mimeType = boundedText(params.redirectResponse.mimeType, 200) ?? previous.mimeType;
        previous.redirectedTo = boundedText(request.url, 4_096);
        previous.finishedAt = Number.isFinite(params.timestamp) ? params.timestamp : null;
      }
      const record = {
        requestId,
        protocolRequestId,
        frameTargetId,
        url: boundedText(request.url, 4_096),
        urlTruncated: typeof request.url === "string" && request.url.length > 4_096,
        method: boundedText(request.method, 32),
        resourceType: boundedText(params.type, 64),
        frameId: boundedText(params.frameId, 200),
        loaderId: boundedText(params.loaderId, 200),
        initiatorType: boundedText(params.initiator?.type, 64),
        timestamp: Number.isFinite(params.timestamp) ? params.timestamp : null,
        status: null,
        mimeType: null,
        fromDiskCache: false,
        fromServiceWorker: false,
        encodedDataLength: null,
        finishedAt: null,
        failure: null
      };
      this.requests.push(record);
      this.totalRequests++;
      if (requestId) this.latestRequestById.set(requestId, record);
      this.#trimRequests();
      return;
    }

    const record = this.latestRequestById.get(requestId);
    if (!record) return;
    if (method === "Network.responseReceived") {
      const response = params.response ?? {};
      record.status = Number.isFinite(response.status) ? response.status : null;
      record.mimeType = boundedText(response.mimeType, 200);
      record.fromDiskCache = response.fromDiskCache === true;
      record.fromServiceWorker = response.fromServiceWorker === true;
    } else if (method === "Network.loadingFinished") {
      record.encodedDataLength = Number.isFinite(params.encodedDataLength) ? params.encodedDataLength : null;
      record.finishedAt = Number.isFinite(params.timestamp) ? params.timestamp : null;
    } else if (method === "Network.loadingFailed") {
      record.finishedAt = Number.isFinite(params.timestamp) ? params.timestamp : null;
      record.failure = {
        errorText: boundedText(params.errorText, 200),
        canceled: params.canceled === true,
        blockedReason: boundedText(params.blockedReason, 100)
      };
    }
  }

  recordLifecycleEvent(method, params = {}, { frameTargetId = params.frameTargetId ?? null } = {}) {
    const frame = params.frame ?? params;
    this.lifecycleEvents.push({
      event: boundedText(method, 100),
      frameTargetId,
      name: boundedText(params.name, 100),
      frameId: boundedText(params.frameId ?? frame.id, 200),
      loaderId: boundedText(params.loaderId ?? frame.loaderId, 200),
      url: boundedText(params.url ?? frame.url, 4_096),
      timestamp: Number.isFinite(params.timestamp) ? params.timestamp : null,
      observedAt: new Date().toISOString()
    });
    this.totalLifecycleEvents++;
    while (this.lifecycleEvents.length > this.maxLifecycleEvents) {
      this.lifecycleEvents.shift();
      this.droppedLifecycleEvents++;
    }
  }

  recordDomMutation(method, params = {}, { frameTargetId = params.frameTargetId ?? null } = {}) {
    const node = params.node ?? params.root ?? params.pseudoElement;
    const attributes = Array.isArray(node?.attributes)
      ? Array.from({ length: Math.floor(node.attributes.length / 2) }, (_, index) => ({
        name: boundedText(node.attributes[index * 2], 200),
        value: boundedText(node.attributes[index * 2 + 1], 1_024),
        valueLength: typeof node.attributes[index * 2 + 1] === "string" ? node.attributes[index * 2 + 1].length : null,
        valueTruncated: typeof node.attributes[index * 2 + 1] === "string" && node.attributes[index * 2 + 1].length > 1_024
      })).slice(0, 24)
      : [];
    const characterData = boundedText(params.characterData, 2_048);
    const nodeValue = boundedText(node?.nodeValue, 2_048);
    const relatedNodeIds = [...new Set([
      params.nodeId, params.parentNodeId, params.previousNodeId, params.hostId,
      params.rootId, params.parentId, params.pseudoElementId, params.insertionPointId,
      ...(Array.isArray(params.nodeIds) ? params.nodeIds.slice(0, 2_000) : [])
    ])].filter(Number.isInteger).slice(0, 2_000);
    this.domMutations.push({
      event: boundedText(method, 100),
      frameTargetId,
      nodeId: Number.isInteger(params.nodeId) ? params.nodeId : Number.isInteger(node?.nodeId) ? node.nodeId : null,
      parentNodeId: Number.isInteger(params.parentNodeId) ? params.parentNodeId : null,
      previousNodeId: Number.isInteger(params.previousNodeId) ? params.previousNodeId : null,
      hostId: Number.isInteger(params.hostId) ? params.hostId : null,
      rootId: Number.isInteger(params.rootId) ? params.rootId : null,
      parentId: Number.isInteger(params.parentId) ? params.parentId : null,
      pseudoElementId: Number.isInteger(params.pseudoElementId) ? params.pseudoElementId : null,
      insertionPointId: Number.isInteger(params.insertionPointId) ? params.insertionPointId : null,
      relatedNodeIds,
      backendNodeId: Number.isInteger(node?.backendNodeId) ? node.backendNodeId : null,
      nodeType: Number.isInteger(node?.nodeType) ? node.nodeType : null,
      nodeName: boundedText(node?.nodeName, 200),
      localName: boundedText(node?.localName, 200),
      pseudoType: boundedText(node?.pseudoType, 100),
      shadowRootType: boundedText(node?.shadowRootType, 100),
      frameId: boundedText(node?.frameId, 200),
      attributes,
      attributeName: boundedText(params.name, 200),
      value: boundedText(params.value, 1_024),
      valueLength: typeof params.value === "string" ? params.value.length : null,
      valueTruncated: typeof params.value === "string" && params.value.length > 1_024,
      characterData,
      characterDataLength: typeof params.characterData === "string" ? params.characterData.length : null,
      characterDataTruncated: typeof params.characterData === "string" && params.characterData.length > 2_048,
      nodeValue,
      nodeValueLength: typeof node?.nodeValue === "string" ? node.nodeValue.length : null,
      nodeValueTruncated: typeof node?.nodeValue === "string" && node.nodeValue.length > 2_048,
      childNodeCount: Number.isInteger(params.childNodeCount) ? params.childNodeCount : null,
      relatedBackendNodeIds: Array.isArray(params.distributedNodes)
        ? params.distributedNodes.slice(0, 200).map(item => Number.isInteger(item?.backendNodeId) ? item.backendNodeId : null).filter(Number.isInteger)
        : [],
      observedAt: new Date().toISOString()
    });
    this.totalDomMutations++;
    while (this.domMutations.length > this.maxDomMutations) {
      this.domMutations.shift();
      this.droppedDomMutations++;
    }
  }

  snapshot() {
    return {
      networkRequests: structuredClone(this.requests),
      lifecycleEvents: structuredClone(this.lifecycleEvents),
      domMutations: structuredClone(this.domMutations),
      totalRequests: this.totalRequests,
      totalLifecycleEvents: this.totalLifecycleEvents,
      totalDomMutations: this.totalDomMutations,
      droppedRequests: this.droppedRequests,
      droppedLifecycleEvents: this.droppedLifecycleEvents,
      droppedDomMutations: this.droppedDomMutations
    };
  }

  #trimRequests() {
    while (this.requests.length > this.maxRequests) {
      const removed = this.requests.shift();
      this.droppedRequests++;
      if (removed.requestId && this.latestRequestById.get(removed.requestId) === removed) this.latestRequestById.delete(removed.requestId);
    }
  }
}
