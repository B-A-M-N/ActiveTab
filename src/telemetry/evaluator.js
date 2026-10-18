/** Basic, deterministic metrics for approved decision labels. */
export function evaluateDecisionExamples(examples, { positiveLabel = "yes", approvalThreshold = 0.8 } = {}) {
  if (!Array.isArray(examples)) throw new Error("Decision examples must be an array.");
  if (!Number.isFinite(approvalThreshold) || approvalThreshold < 0 || approvalThreshold > 1) throw new Error("Approval threshold must be in [0, 1].");
  const labeled = examples.filter(example => example.label?.labelCode && example.model && example.prediction);
  let correct = 0, brierSum = 0, brierCount = 0, falseApprovals = 0, approvals = 0, positives = 0, truePositives = 0;
  const calibration = new Map();
  for (const example of labeled) {
    const truth = example.label.labelCode;
    const prediction = example.prediction;
    let probability = null;
    let predictedLabel = null;
    if (prediction.type === "noul") {
      probability = prediction.probabilityYes;
      predictedLabel = probability >= 0.5 ? positiveLabel : "no";
      const positive = truth === positiveLabel ? 1 : 0;
      brierSum += (probability - positive) ** 2;
      brierCount++;
      const bin = Math.min(9, Math.floor(probability * 10));
      const bucket = calibration.get(bin) ?? { count: 0, confidence: 0, accuracy: 0 };
      bucket.count++;
      bucket.confidence += probability;
      bucket.accuracy += positive;
      calibration.set(bin, bucket);
      positives += positive;
      if (probability >= approvalThreshold) {
        approvals++;
        if (positive) truePositives++;
        else falseApprovals++;
      }
    } else if (prediction.type === "choice") {
      predictedLabel = prediction.choice;
    } else if (prediction.type === "semantic") {
      predictedLabel = prediction.resultCode;
      if (Number.isFinite(prediction.confidence)) {
        const correct = prediction.resultCode === truth ? 1 : 0;
        brierSum += (prediction.confidence - correct) ** 2;
        brierCount++;
      }
    }
    if (predictedLabel !== null && predictedLabel === truth) correct++;
  }
  return {
    exampleCount: labeled.length,
    accuracy: labeled.length ? correct / labeled.length : null,
    brierScore: brierCount ? brierSum / brierCount : null,
    approvalThreshold,
    approvalPrecision: approvals ? truePositives / approvals : null,
    falseApprovalRate: approvals ? falseApprovals / approvals : null,
    positiveRecall: positives ? truePositives / positives : null,
    calibration: [...calibration.entries()].sort(([a], [b]) => a - b).map(([bin, bucket]) => ({
      lower: bin / 10, upper: (bin + 1) / 10, count: bucket.count,
      meanConfidence: bucket.confidence / bucket.count, observedPositiveRate: bucket.accuracy / bucket.count
    }))
  };
}
