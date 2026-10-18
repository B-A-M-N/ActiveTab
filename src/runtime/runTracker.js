/** Track a run promise without blocking status reads or leaking rejections. */
export function trackRunResult(promise) {
  const state = {
    status: "RUNNING",
    settled: false,
    receipt: null,
    error: null,
    completion: null
  };

  state.completion = Promise.resolve(promise).then(
    receipt => {
      state.receipt = receipt ?? null;
      state.status = receipt?.status ?? "UNKNOWN";
      state.settled = true;
      return receipt ?? null;
    },
    error => {
      state.error = error;
      state.status = "FAILED";
      state.settled = true;
      return null;
    }
  );

  return state;
}
