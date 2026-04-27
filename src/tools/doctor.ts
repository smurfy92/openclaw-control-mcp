import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildDoctorTools(client: GatewayClient): ToolDef[] {
  const status: ToolDef = {
    name: "openclaw_doctor_memory_status",
    description:
      "Get the memory subsystem health (short-term store, dream diary, grounding state). Wraps `doctor.memory.status`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("doctor.memory.status", {}),
  };

  const dreamDiary: ToolDef = {
    name: "openclaw_doctor_memory_dreamDiary",
    description:
      "Read the dream diary (the gateway's REM/light dream artifacts that promote into MEMORY.md). Wraps `doctor.memory.dreamDiary`. Read-only.",
    inputSchema: z
      .object({
        limit: z.number().int().positive().max(500).optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("doctor.memory.dreamDiary", args ?? {}),
  };

  const backfill: ToolDef = {
    name: "openclaw_doctor_memory_backfillDreamDiary",
    description:
      "Backfill the dream diary from past sessions (re-runs dreaming on history). Wraps `doctor.memory.backfillDreamDiary`. Mutates — can be expensive in tokens.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("doctor.memory.backfillDreamDiary", args ?? {}),
  };

  const dedupe: ToolDef = {
    name: "openclaw_doctor_memory_dedupeDreamDiary",
    description:
      "Deduplicate dream diary entries. Wraps `doctor.memory.dedupeDreamDiary`. Mutates.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("doctor.memory.dedupeDreamDiary", args ?? {}),
  };

  const repair: ToolDef = {
    name: "openclaw_doctor_memory_repairDreamingArtifacts",
    description:
      "Repair corrupted dreaming artifacts (e.g. orphan files, broken JSON). Wraps `doctor.memory.repairDreamingArtifacts`. Mutates.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("doctor.memory.repairDreamingArtifacts", args ?? {}),
  };

  const resetDreamDiary: ToolDef = {
    name: "openclaw_doctor_memory_resetDreamDiary",
    description:
      "Wipe the dream diary entirely. Wraps `doctor.memory.resetDreamDiary`. DESTRUCTIVE — confirm before calling. Loses all promoted-into-memory candidates.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("doctor.memory.resetDreamDiary", args ?? {}),
  };

  const resetGrounded: ToolDef = {
    name: "openclaw_doctor_memory_resetGroundedShortTerm",
    description:
      "Wipe the grounded short-term memory store. Wraps `doctor.memory.resetGroundedShortTerm`. DESTRUCTIVE — agents lose their recent recall.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("doctor.memory.resetGroundedShortTerm", args ?? {}),
  };

  return [status, dreamDiary, backfill, dedupe, repair, resetDreamDiary, resetGrounded];
}
