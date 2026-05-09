import { randomUUID } from "node:crypto";

/**
 * In-memory dry-run gateway. Activated with `OPENCLAW_MOCK=1` (or `--mock`).
 * Lets callers exercise the full MCP surface without provisioning a real
 * gateway — handy for CI, demos, and ad-hoc workflow rehearsals before
 * touching prod.
 *
 * State is realistic enough that workflow chains work end-to-end:
 *   sessions.create → chat.send → chat.history (sees user msg + auto-reply)
 *   cron.add → cron.list (sees the job) → cron.run → cron.runs (sees the run)
 *   config.get → config.patch (with baseHash) → config.get (sees the patch)
 *
 * Un-canned methods return `{ mock: true, ok: true, method, note: "…" }` so
 * nothing crashes — extend the relevant `handle*` block to specialise.
 */

type Message = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content?: string;
  text?: string;
  createdAtMs: number;
};

type Session = {
  sessionId: string;
  key: string;
  agentId: string;
  status: "running" | "done" | "error" | "aborted" | "timeout";
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  messages: Message[];
  inputTokens: number;
  outputTokens: number;
};

export class MockGateway {
  // ── domain state ───────────────────────────────────────────────────────
  private cronJobs: Array<Record<string, unknown>> = [
    {
      id: "mock-job-1",
      name: "sample-weekly",
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * 5", tz: "Europe/Paris" },
      payload: { kind: "agentTurn", message: "sample weekly digest", timeoutSeconds: 900 },
      createdAtMs: Date.now() - 7 * 24 * 3600_000,
      updatedAtMs: Date.now() - 24 * 3600_000,
    },
  ];
  private cronRuns = new Map<string, Array<Record<string, unknown>>>();

  private sessions: Map<string, Session> = new Map([
    [
      "agent:main:main",
      {
        sessionId: "mock-session-main",
        key: "agent:main:main",
        agentId: "main",
        status: "done",
        title: "Mock main session",
        createdAtMs: Date.now() - 3600_000,
        updatedAtMs: Date.now() - 1800_000,
        messages: [],
        inputTokens: 0,
        outputTokens: 0,
      },
    ],
  ]);

  private agents: Array<Record<string, unknown>> = [
    { agentId: "main", displayName: "Main", model: "claude-sonnet-4-6" },
  ];

  private channels: Record<string, Record<string, unknown>> = {
    telegram: { configured: true, running: true, lastError: null },
    discord: { configured: true, running: true, lastError: null },
  };

  private execApprovals: Array<Record<string, unknown>> = [];
  private pluginApprovals: Array<Record<string, unknown>> = [];

  private skills: Array<Record<string, unknown>> = [
    { id: "sample-skill", name: "Sample Skill", installed: true, version: "0.1.0" },
    { id: "another-sample", name: "Another Sample", installed: true, version: "0.2.0" },
  ];

  private nodes: Array<Record<string, unknown>> = [
    { nodeId: "mock-canvas-1", role: "canvas", connected: true },
  ];

  private devicesPaired: Array<Record<string, unknown>> = [];
  private devicesPending: Array<Record<string, unknown>> = [];

  private config: Record<string, unknown> = {
    agents: { defaults: { model: { primary: "claude-sonnet-4-6" } } },
    channels: { telegram: { dmPolicy: "closed" }, discord: { groupPolicy: "allowlist" } },
  };
  private configHash = "mock-hash-0";

  private tts: Record<string, unknown> = {
    enabled: false,
    provider: "",
    voice: null,
  };
  private talk: Record<string, unknown> = { config: {}, mode: false };
  private voicewake: Record<string, unknown> = { triggers: ["openclaw"], enabled: true };

  // ── public dispatch ────────────────────────────────────────────────────
  request(method: string, rawParams: unknown): unknown {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const handler = this.routeMap[method];
    if (handler) return handler.call(this, params);
    return {
      mock: true,
      ok: true,
      method,
      note: "no canned mock handler — extend src/gateway/mock.ts to specialise",
    };
  }

  // ── route table (one entry per method, grouped by domain in source order)
  private readonly routeMap: Record<string, (this: MockGateway, params: Record<string, unknown>) => unknown> = {
    // root / status / identity
    "health": () => ({ ok: true, mock: true }),
    "status": this.handleStatus,
    "system-presence": () => [{ host: "mock-host", ip: "127.0.0.1", mode: "gateway", reason: "self" }],
    "system-event": () => ({ mock: true, ok: true }),
    "last-heartbeat": () => ({ mock: true, tsMs: Date.now(), source: "mock-gateway" }),
    "set-heartbeats": () => ({ mock: true, ok: true }),
    "wake": () => ({ mock: true, ok: true }),
    "send": (p) => this.handleSend(p),
    "agent": (p) => this.handleAgent(p),
    "agent.identity.get": () => ({ mock: true, agentId: "main", displayName: "Main" }),
    "agent.wait": () => ({ mock: true, ok: true, status: "idle" }),
    "gateway.identity.get": () => ({
      mock: true,
      id: "mock-gateway",
      version: "mock-2026.0.0",
      owner: "mock-user",
    }),
    "introspect": () => ({ mock: true, methods: [], events: [] }),

    // agents
    "agents.list": this.handleAgentsList,
    "agents.create": this.handleAgentsCreate,
    "agents.update": this.handleAgentsUpdate,
    "agents.delete": this.handleAgentsDelete,
    "agents.files.list": () => ({ mock: true, files: ["system.md", "memory.md"] }),
    "agents.files.get": () => ({ mock: true, content: "(mock file body)" }),
    "agents.files.set": () => ({ mock: true, ok: true }),

    // channels
    "channels.status": this.handleChannelsStatus,
    "channels.logout": this.handleChannelsLogout,

    // chat
    "chat.send": this.handleChatSend,
    "chat.history": this.handleChatHistory,
    "chat.abort": this.handleChatAbort,

    // sessions
    "sessions.list": this.handleSessionsList,
    "sessions.preview": this.handleSessionsPreview,
    "sessions.create": this.handleSessionsCreate,
    "sessions.patch": this.handleSessionsPatch,
    "sessions.send": this.handleSessionsSend,
    "sessions.abort": this.handleSessionsAbort,
    "sessions.reset": this.handleSessionsReset,
    "sessions.delete": this.handleSessionsDelete,
    "sessions.compact": () => ({ mock: true, ok: true, snapshotId: randomUUID() }),
    "sessions.compaction.list": () => ({ mock: true, snapshots: [] }),
    "sessions.compaction.get": () => ({ mock: true, snapshot: null }),
    "sessions.compaction.restore": () => ({ mock: true, ok: true }),
    "sessions.compaction.branch": () => ({
      mock: true,
      ok: true,
      session: { sessionId: randomUUID(), key: "agent:main:branch", status: "running" },
    }),
    "sessions.subscribe": () => ({ mock: true, ok: true, subscribed: true }),
    "sessions.unsubscribe": () => ({ mock: true, ok: true, subscribed: false }),
    "sessions.messages.subscribe": () => ({ mock: true, ok: true, subscribed: true }),
    "sessions.messages.unsubscribe": () => ({ mock: true, ok: true, subscribed: false }),

    // cron
    "cron.list": () => ({ mock: true, jobs: this.cronJobs }),
    "cron.status": () => ({ mock: true, enabled: true, nextRunMs: Date.now() + 3600_000 }),
    "cron.add": this.handleCronAdd,
    "cron.update": this.handleCronUpdate,
    "cron.remove": this.handleCronRemove,
    "cron.run": this.handleCronRun,
    "cron.runs": this.handleCronRuns,

    // config
    "config.get": this.handleConfigGet,
    "config.patch": this.handleConfigPatch,
    "config.set": () => ({ mock: true, ok: true }),
    "config.apply": () => ({ mock: true, ok: true }),
    "config.schema": () => ({ mock: true, schema: { type: "object" } }),
    "config.schema.lookup": () => ({ mock: true, schema: { type: "object" } }),

    // secrets
    "secrets.reload": () => ({ mock: true, ok: true }),
    "secrets.resolve": this.handleSecretsResolve,

    // skills
    "skills.list": () => ({ mock: true, skills: this.skills }),
    "skills.status": () => ({ mock: true, count: this.skills.length, healthy: true }),
    "skills.search": (p) => ({
      mock: true,
      results: this.skills.filter((s) => !p.query || (s.id as string).includes(p.query as string)).slice(0, (p.limit as number) ?? 50),
    }),
    "skills.detail": (p) => ({
      mock: true,
      skill: this.skills.find((s) => s.id === p.id) ?? null,
    }),
    "skills.install": () => ({ mock: true, ok: true }),
    "skills.update": () => ({ mock: true, ok: true }),
    "skills.bins": () => ({ mock: true, bins: [] }),

    // tools catalog
    "tools.catalog": () => ({
      mock: true,
      tools: [
        { name: "edit", description: "Edit a file" },
        { name: "bash", description: "Run a shell command" },
      ],
    }),
    "tools.effective": () => ({
      mock: true,
      tools: [
        { name: "edit", description: "Edit a file" },
        { name: "bash", description: "Run a shell command" },
      ],
    }),

    // exec / plugin approvals
    "exec.approval.list": () => ({ mock: true, approvals: this.execApprovals }),
    "exec.approval.get": (p) => ({
      mock: true,
      approval: this.execApprovals.find((a) => a.id === p.id) ?? null,
    }),
    "exec.approval.request": (p) => {
      const id = randomUUID();
      this.execApprovals.push({ id, status: "pending", command: p.command ?? "(mock)", createdAtMs: Date.now() });
      return { mock: true, ok: true, id };
    },
    "exec.approval.resolve": (p) => {
      const idx = this.execApprovals.findIndex((a) => a.id === p.id);
      if (idx === -1) return { mock: true, ok: false, error: "not found" };
      this.execApprovals[idx] = { ...this.execApprovals[idx], status: p.decision ?? "approved" };
      return { mock: true, ok: true };
    },
    "exec.approval.waitDecision": (p) => ({
      mock: true,
      decision: this.execApprovals.find((a) => a.id === p.id)?.status ?? "approved",
    }),
    "exec.approvals.get": () => ({ mock: true, policy: { autoApprove: false } }),
    "exec.approvals.set": () => ({ mock: true, ok: true }),
    "exec.approvals.node.get": () => ({ mock: true, policy: null }),
    "exec.approvals.node.set": () => ({ mock: true, ok: true }),
    "plugin.approval.list": () => ({ mock: true, approvals: this.pluginApprovals }),
    "plugin.approval.request": () => ({ mock: true, ok: true, id: randomUUID() }),
    "plugin.approval.resolve": () => ({ mock: true, ok: true }),
    "plugin.approval.waitDecision": () => ({ mock: true, decision: "approved" }),

    // doctor memory
    "doctor.memory.status": () => ({ mock: true, healthy: true, dreams: 0 }),
    "doctor.memory.dreamDiary": (p) => ({
      mock: true,
      entries: [
        { id: "mock-dream-1", tsMs: Date.now() - 86400_000, summary: "[mock] sample dream entry" },
      ].slice(0, (p.limit as number) ?? 50),
    }),
    "doctor.memory.backfillDreamDiary": () => ({ mock: true, ok: true }),
    "doctor.memory.dedupeDreamDiary": () => ({ mock: true, ok: true, removed: 0 }),
    "doctor.memory.repairDreamingArtifacts": () => ({ mock: true, ok: true }),
    "doctor.memory.resetDreamDiary": () => ({ mock: true, ok: true }),
    "doctor.memory.resetGroundedShortTerm": () => ({ mock: true, ok: true }),

    // node
    "node.list": () => ({ mock: true, nodes: this.nodes }),
    "node.describe": (p) => ({
      mock: true,
      node: this.nodes.find((n) => n.nodeId === p.nodeId) ?? null,
    }),
    "node.invoke": () => ({ mock: true, invocationId: randomUUID() }),
    "node.invoke.result": () => ({ mock: true, status: "done", result: null }),
    "node.event": () => ({ mock: true, ok: true }),
    "node.rename": () => ({ mock: true, ok: true }),
    "node.pair.list": () => ({ mock: true, paired: [], pending: [] }),
    "node.pair.request": () => ({ mock: true, ok: true, requestId: randomUUID() }),
    "node.pair.verify": () => ({ mock: true, ok: true }),
    "node.pair.approve": () => ({ mock: true, ok: true }),
    "node.pair.reject": () => ({ mock: true, ok: true }),
    "node.pending.pull": () => ({ mock: true, items: [] }),
    "node.pending.drain": () => ({ mock: true, drained: 0 }),
    "node.pending.enqueue": () => ({ mock: true, ok: true, itemId: randomUUID() }),
    "node.pending.ack": () => ({ mock: true, ok: true }),
    "node.canvas.capability.refresh": () => ({ mock: true, ok: true }),

    // device
    "device.pair.list": () => ({
      mock: true,
      paired: this.devicesPaired,
      pending: this.devicesPending,
    }),
    "device.pair.approve": () => ({ mock: true, ok: true }),
    "device.pair.reject": () => ({ mock: true, ok: true }),
    "device.pair.remove": () => ({ mock: true, ok: true }),
    "device.token.revoke": () => ({ mock: true, ok: true }),
    "device.token.rotate": () => ({ mock: true, ok: true, newToken: "mock-token-rotated" }),

    // models / usage / logs / commands / update / message
    "models.list": () => ({
      mock: true,
      models: [
        { id: "claude-sonnet-4-6", provider: "anthropic" },
        { id: "claude-opus-4-7", provider: "anthropic" },
      ],
    }),
    "usage.status": () => ({ mock: true, period: "current", tokensIn: 0, tokensOut: 0 }),
    "usage.cost": () => ({ mock: true, total: 0, breakdown: [] }),
    "logs.tail": this.handleLogsTail,
    "commands.list": () => ({ mock: true, commands: ["/help", "/status"] }),
    "update.run": () => ({ mock: true, ok: true, version: "mock-2026.0.0" }),
    "message.action": () => ({ mock: true, ok: true }),

    // tts / talk / voicewake
    "tts.status": () => ({ mock: true, ...this.tts }),
    "tts.enable": () => {
      this.tts.enabled = true;
      return { mock: true, ok: true };
    },
    "tts.disable": () => {
      this.tts.enabled = false;
      return { mock: true, ok: true };
    },
    "tts.providers": () => ({ mock: true, providers: [{ id: "minimax" }] }),
    "tts.setProvider": (p) => {
      this.tts.provider = p.provider as string;
      return { mock: true, ok: true };
    },
    "tts.convert": () => ({ mock: true, audioUrl: "mock://audio" }),
    "talk.config": () => ({ mock: true, config: this.talk.config }),
    "talk.mode": (p) => {
      this.talk.mode = p.enabled as boolean;
      return { mock: true, ok: true };
    },
    "talk.speak": () => ({ mock: true, ok: true }),
    "voicewake.get": () => ({ mock: true, ...this.voicewake }),
    "voicewake.set": (p) => {
      this.voicewake = { ...this.voicewake, ...p };
      return { mock: true, ok: true };
    },

    // wizard
    "wizard.start": () => ({ mock: true, ok: true, step: "first" }),
    "wizard.next": () => ({ mock: true, step: "next" }),
    "wizard.cancel": () => ({ mock: true, ok: true }),
    "wizard.status": (p) => {
      // gateway requires sessionId — surface that via a shape-realistic response
      if (!p.sessionId) {
        throw new Error(
          "mock wizard.status: requires sessionId (verified live against gateway 2026.4.12+)",
        );
      }
      return { mock: true, sessionId: p.sessionId, step: "first", state: "idle" };
    },
  };

  // ── handlers (private, organized by domain) ────────────────────────────

  private handleStatus(): unknown {
    return {
      mock: true,
      uptimeMs: Date.now() % 1_000_000,
      agents: this.agents.length,
      sessions: this.sessions.size,
      queues: 0,
    };
  }

  private handleSend(params: Record<string, unknown>): unknown {
    if (!params.to) throw new Error("mock send: requires `to` (verified live)");
    if (!params.idempotencyKey) throw new Error("mock send: requires `idempotencyKey`");
    return { mock: true, ok: true, deliveredTo: params.to };
  }

  private handleAgent(params: Record<string, unknown>): unknown {
    if (!params.message) throw new Error("mock agent: requires `message` (verified live)");
    if (!params.idempotencyKey) throw new Error("mock agent: requires `idempotencyKey`");
    return { mock: true, ok: true, message: params.message, runId: randomUUID() };
  }

  // agents
  private handleAgentsList(): unknown {
    return { mock: true, agents: this.agents };
  }
  private handleAgentsCreate(params: Record<string, unknown>): unknown {
    const agent = {
      agentId: (params.agentId as string) ?? (params.id as string) ?? `mock-${randomUUID().slice(0, 8)}`,
      displayName: (params.displayName as string) ?? "(mock)",
      model: (params.model as string) ?? "claude-sonnet-4-6",
    };
    this.agents.push(agent);
    return { mock: true, ok: true, agent };
  }
  private handleAgentsUpdate(params: Record<string, unknown>): unknown {
    const idx = this.agents.findIndex((a) => a.agentId === params.agentId);
    if (idx === -1) throw new Error(`mock agents.update: unknown agent ${params.agentId}`);
    this.agents[idx] = { ...this.agents[idx], ...params };
    return { mock: true, ok: true, agent: this.agents[idx] };
  }
  private handleAgentsDelete(params: Record<string, unknown>): unknown {
    const before = this.agents.length;
    this.agents = this.agents.filter((a) => a.agentId !== params.agentId);
    return { mock: true, ok: true, deleted: before - this.agents.length };
  }

  // channels
  private handleChannelsStatus(): unknown {
    return {
      mock: true,
      channels: this.channels,
      channelOrder: Object.keys(this.channels),
    };
  }
  private handleChannelsLogout(params: Record<string, unknown>): unknown {
    const ch = params.channel as string;
    if (this.channels[ch]) this.channels[ch] = { ...this.channels[ch], running: false };
    return { mock: true, ok: true };
  }

  // chat (sessionKey-based, post-0.5.x wire format)
  private handleChatSend(params: Record<string, unknown>): unknown {
    const key = params.sessionKey as string;
    if (!key) throw new Error("mock chat.send: requires sessionKey");
    if (!params.message) throw new Error("mock chat.send: requires message");
    if (!params.idempotencyKey) throw new Error("mock chat.send: requires idempotencyKey");
    const session = this.getOrCreateSession(key);
    const userMsg: Message = {
      id: randomUUID(),
      role: "user",
      content: params.message as string,
      createdAtMs: Date.now(),
    };
    session.messages.push(userMsg);
    // Simulate an agent reply so workflow chains feel real
    const reply: Message = {
      id: randomUUID(),
      role: "assistant",
      content: `[mock reply to: ${(params.message as string).slice(0, 60)}]`,
      createdAtMs: Date.now() + 1,
    };
    session.messages.push(reply);
    session.outputTokens += reply.content?.length ?? 0;
    session.updatedAtMs = Date.now();
    return { mock: true, ok: true, messageId: userMsg.id, replyId: reply.id };
  }

  private handleChatHistory(params: Record<string, unknown>): unknown {
    const key = params.sessionKey as string;
    if (!key) throw new Error("mock chat.history: requires sessionKey");
    const session = this.sessions.get(key);
    if (!session) {
      return { mock: true, sessionKey: key, sessionId: null, messages: [] };
    }
    const limit = (params.limit as number) ?? session.messages.length;
    return {
      mock: true,
      sessionKey: key,
      sessionId: session.sessionId,
      messages: session.messages.slice(-limit),
    };
  }

  private handleChatAbort(params: Record<string, unknown>): unknown {
    const key = params.sessionKey as string;
    if (!key) throw new Error("mock chat.abort: requires sessionKey");
    const session = this.sessions.get(key);
    return { mock: true, ok: true, aborted: !!session && session.status === "running", runIds: [] };
  }

  // sessions
  private handleSessionsList(): unknown {
    return {
      mock: true,
      sessions: [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        key: s.key,
        agentId: s.agentId,
        status: s.status,
        title: s.title,
        createdAtMs: s.createdAtMs,
        updatedAtMs: s.updatedAtMs,
      })),
    };
  }

  private handleSessionsPreview(params: Record<string, unknown>): unknown {
    const keys = (params.keys as string[] | undefined) ?? [];
    const out: Record<string, unknown> = { mock: true };
    for (const k of keys) {
      const session = this.sessions.get(k);
      out[k] = session
        ? { messages: session.messages, status: session.status }
        : { messages: [], status: "unknown" };
    }
    return out;
  }

  private handleSessionsCreate(params: Record<string, unknown>): unknown {
    const sid = randomUUID();
    const agentId = (params.agentId as string) ?? "main";
    const key = `agent:${agentId}:${sid}`;
    const session: Session = {
      sessionId: sid,
      key,
      agentId,
      status: "running",
      title: (params.title as string) ?? "(mock session)",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      messages: [],
      inputTokens: 0,
      outputTokens: 0,
    };
    this.sessions.set(key, session);
    return { mock: true, ok: true, session };
  }

  private handleSessionsPatch(params: Record<string, unknown>): unknown {
    const id = params.id as string;
    // Find by sessionId or key
    let session = [...this.sessions.values()].find((s) => s.sessionId === id);
    if (!session) session = this.sessions.get(id);
    if (!session) return { mock: true, ok: false, error: "not found" };
    if (typeof params.title === "string") session.title = params.title;
    session.updatedAtMs = Date.now();
    return { mock: true, ok: true };
  }

  private handleSessionsSend(params: Record<string, unknown>): unknown {
    const id = params.id as string;
    const text = (params.text as string) ?? (params.message as string);
    if (!text) throw new Error("mock sessions.send: requires text or message");
    const session = [...this.sessions.values()].find((s) => s.sessionId === id || s.key === id);
    if (!session) throw new Error(`mock sessions.send: unknown session ${id}`);
    session.messages.push({
      id: randomUUID(),
      role: "user",
      content: text,
      createdAtMs: Date.now(),
    });
    session.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: `[mock reply to: ${text.slice(0, 60)}]`,
      createdAtMs: Date.now() + 1,
    });
    session.updatedAtMs = Date.now();
    return { mock: true, ok: true };
  }

  private handleSessionsAbort(params: Record<string, unknown>): unknown {
    const id = params.id as string;
    const session = [...this.sessions.values()].find((s) => s.sessionId === id || s.key === id);
    if (!session) return { mock: true, ok: false, error: "not found" };
    session.status = "aborted";
    session.updatedAtMs = Date.now();
    return { mock: true, ok: true };
  }

  private handleSessionsReset(params: Record<string, unknown>): unknown {
    const id = params.id as string;
    const session = [...this.sessions.values()].find((s) => s.sessionId === id || s.key === id);
    if (!session) return { mock: true, ok: false, error: "not found" };
    session.messages = [];
    session.status = "running";
    session.updatedAtMs = Date.now();
    return { mock: true, ok: true };
  }

  private handleSessionsDelete(params: Record<string, unknown>): unknown {
    const id = params.id as string;
    let key: string | null = null;
    for (const [k, s] of this.sessions) {
      if (s.sessionId === id || k === id) {
        key = k;
        break;
      }
    }
    if (!key) return { mock: true, ok: false, error: "not found" };
    this.sessions.delete(key);
    return { mock: true, ok: true };
  }

  // cron
  private handleCronAdd(params: Record<string, unknown>): unknown {
    const job = (params.job ?? {}) as Record<string, unknown>;
    const id = (job.id as string | undefined) ?? randomUUID();
    const persisted = {
      ...job,
      id,
      enabled: job.enabled ?? true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };
    this.cronJobs.push(persisted);
    return { mock: true, ok: true, job: persisted };
  }

  private handleCronUpdate(params: Record<string, unknown>): unknown {
    const id = (params.id as string | undefined) ?? (params.jobId as string | undefined);
    if (!id) throw new Error("mock cron.update requires id");
    const idx = this.cronJobs.findIndex((j) => j.id === id);
    if (idx === -1) throw new Error(`mock cron.update: unknown job ${id}`);
    const patch = (params.patch as Record<string, unknown> | undefined) ?? {};
    const existing = this.cronJobs[idx] ?? {};
    this.cronJobs[idx] = { ...existing, ...patch, updatedAtMs: Date.now() };
    return { mock: true, ok: true, job: this.cronJobs[idx] };
  }

  private handleCronRemove(params: Record<string, unknown>): unknown {
    const id = params.id as string;
    this.cronJobs = this.cronJobs.filter((j) => j.id !== id);
    return { mock: true, ok: true };
  }

  private handleCronRun(params: Record<string, unknown>): unknown {
    const id = params.id as string;
    const runs = this.cronRuns.get(id) ?? [];
    const entry = {
      runId: randomUUID(),
      jobId: id,
      runAtMs: Date.now(),
      status: "ok",
      summary: "[mock] dry-run completed",
    };
    runs.unshift(entry);
    this.cronRuns.set(id, runs);
    return { mock: true, ok: true, runId: entry.runId };
  }

  private handleCronRuns(params: Record<string, unknown>): unknown {
    const id = params.id as string;
    return { mock: true, entries: this.cronRuns.get(id) ?? [] };
  }

  // config
  private handleConfigGet(): unknown {
    return {
      mock: true,
      path: "(mock)",
      exists: true,
      raw: JSON.stringify(this.config),
      parsed: this.config,
      baseHash: this.configHash,
    };
  }

  private handleConfigPatch(params: Record<string, unknown>): unknown {
    const raw = params.raw as string | undefined;
    const baseHash = params.baseHash as string | undefined;
    if (!raw || !baseHash) throw new Error("mock config.patch requires {raw, baseHash}");
    if (baseHash !== this.configHash) {
      throw new Error("mock config.patch: config changed since last load; re-run config.get and retry");
    }
    this.config = JSON.parse(raw);
    this.configHash = `mock-hash-${Date.now()}`;
    return { mock: true, ok: true, baseHash: this.configHash };
  }

  // secrets
  private handleSecretsResolve(params: Record<string, unknown>): unknown {
    if (!params.commandName) {
      throw new Error("mock secrets.resolve: requires commandName (verified live)");
    }
    return { mock: true, commandName: params.commandName, value: null };
  }

  // logs
  private handleLogsTail(params: Record<string, unknown>): unknown {
    const limit = (params.limit as number) ?? 50;
    // Real gateway returns `{ lines: string[] }` where each line is JSON-encoded log entry.
    const sample = [
      {
        _meta: { date: new Date(Date.now() - 1000).toISOString(), logLevelName: "INFO" },
        "1": "[mock] heartbeat",
      },
      {
        _meta: { date: new Date().toISOString(), logLevelName: "INFO" },
        "1": "[mock] idle",
      },
    ];
    return {
      mock: true,
      file: "mock.log",
      cursor: 0,
      size: 0,
      lines: sample.slice(0, limit).map((l) => JSON.stringify(l)),
    };
  }

  // helpers
  private getOrCreateSession(key: string): Session {
    let session = this.sessions.get(key);
    if (!session) {
      const sid = randomUUID();
      session = {
        sessionId: sid,
        key,
        agentId: key.split(":")[1] ?? "main",
        status: "running",
        title: `(auto-created from chat.send) ${key}`,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        messages: [],
        inputTokens: 0,
        outputTokens: 0,
      };
      this.sessions.set(key, session);
    }
    return session;
  }
}
