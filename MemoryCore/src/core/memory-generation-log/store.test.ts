import { describe, expect, test } from "vitest";

import {
  buildGenerationLogIdentity,
  buildGenerationProvenance,
  buildPromptGenerationRef,
} from "./store.js";

describe("memory generation log builders", () => {
  test("uses the built-in system prompt reference when no prompt resolves", () => {
    expect(buildPromptGenerationRef(undefined, "l3")).toEqual({
      memory_prompt_id: "builtin:l3",
      version: 1,
      source: "system",
      prompt_sha256: "",
    });
  });

  test("hashes the resolved prompt body while preserving its revision metadata", () => {
    expect(
      buildPromptGenerationRef(
        {
          memory_prompt_id: "prompt-team-7",
          prompt: "Team prompt",
          layer: "l2",
          source: "team",
          version: 7,
        },
        "l2",
      ),
    ).toEqual({
      memory_prompt_id: "prompt-team-7",
      version: 7,
      source: "team",
      prompt_sha256:
        "80eb60d661c8fc80fffcd041a5236b761b29849d5e232117896ccd564343e177",
    });
  });

  test("partitions failed generations by UTC hour and hashes unsafe anchor IDs", () => {
    const identity = buildGenerationLogIdentity(
      "l2",
      1_788_408_306_789,
      "team/project id",
      "failed",
    );
    const prompt = buildPromptGenerationRef(undefined, "l2");

    expect(identity.generationId).toMatch(/^mg_[a-f0-9]{32}$/);
    expect(identity.logId).toMatch(
      /^mgl_l2_failed_1788408306789_h_d7bd29b858b06e7dd3fb1d40_[a-f0-9]{16}$/,
    );
    expect(identity.key).toMatch(
      /^memory-generation-logs\/v1\/layer=l2\/date=2026-09-03\/hour=04\/8211591693210__mid=h_d7bd29b858b06e7dd3fb1d40__lid=mgl_l2_failed_1788408306789_h_d7bd29b858b06e7dd3fb1d40_[a-f0-9]{16}\.json$/,
    );
    expect(buildGenerationProvenance(identity, prompt)).toEqual({
      generation_id: identity.generationId,
      generation_log_id: identity.logId,
      generation_log_key: identity.key,
      memory_prompt_id: "builtin:l2",
      memory_prompt_version: 1,
      memory_prompt_source: "system",
    });
  });
});
