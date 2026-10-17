/**
 * Profile loader — loads application profiles and test packs from disk.
 * Profile data is a starting point; routes are validated before use.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { validateWorkflow } from "./schema.js";

export class ProfileLoader {
  constructor(profilesDir) {
    if (typeof profilesDir !== "string" || !profilesDir) throw new Error("ProfileLoader requires a profilesDir.");
    this.profilesDir = resolve(String(profilesDir));
  }

  async listProfiles() {
    const files = await readdir(this.profilesDir).catch(() => []);
    const profiles = [];
    for (const file of files.filter(f => f.endsWith(".json") && f !== "profile-schema.json")) {
      try {
        const raw = await readFile(join(this.profilesDir, file), "utf8");
        const profile = JSON.parse(raw);
        if (profile?.profile_id) profiles.push(profile);
      } catch { /* skip invalid */ }
    }
    return profiles;
  }

  async loadProfile(profileId) {
    const profiles = await this.listProfiles();
    return profiles.find(profile => profile.profile_id === profileId) ?? null;
  }

  async loadTestPack(workflowId) {
    const profiles = await this.listProfiles();
    for (const profile of profiles) {
      const pack = (profile.test_packs ?? []).find(pack => pack.workflow_id === workflowId);
      if (pack) return pack;
    }
    // Also check the examples directory relative to profiles.
    const examplesDir = resolve(this.profilesDir, "..", "examples", "cloud-agent");
    const files = await readdir(examplesDir).catch(() => []);
    for (const file of files.filter(f => f.endsWith(".json"))) {
      try {
        const raw = await readFile(join(examplesDir, file), "utf8");
        const workflow = JSON.parse(raw);
        if (workflow.workflow_id === workflowId) return { ...workflow, id: workflow.workflow_id };
      } catch { /* skip invalid */ }
    }
    return null;
  }

  /**
   * Validate a loaded workflow: required fields, steps, and profile reference.
   */
  validateWorkflow(workflow) {
    const normalized = {
      id: workflow.workflow_id ?? workflow.id,
      name: workflow.name,
      steps: (workflow.steps ?? []).map(step => ({
        id: step.id,
        type: step.type,
        ...(step.url !== undefined ? { url: step.url } : {}),
        ...(step.action !== undefined ? { action: step.action } : {}),
        ...(step.assertion !== undefined ? { assertion: step.assertion } : {}),
        ...(step.condition !== undefined ? { condition: step.condition } : {}),
        ...(step.operation !== undefined ? { operation: step.operation } : {}),
        ...(step.preconditions !== undefined ? { preconditions: step.preconditions } : {})
      }))
    };
    const result = validateWorkflow(normalized);
    return { ...result, normalized };
  }
}
