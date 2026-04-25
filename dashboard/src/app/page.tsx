"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, LineChart, Line, ScatterChart, Scatter,
} from "recharts";

// ============================================================
// TYPES
// ============================================================

interface Run {
  run_id: string;
  name: string;
  status: string;
  total_cycles: number;
  sequential_cycles: number;
  max_concurrency: number;
  pct_amber: number;
  pct_human: number;
  pct_dependabot: number;
  pct_mergify: number;
  github_org: string;
  github_repo: string;
  started_at: string;
  finished_at: string | null;
  cycle_count: number;
  total_api_calls: number;
  total_api_ms: number;
  total_rl_hits: number;
}

interface StepStat {
  step: string;
  profile: string;
  count: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
}

interface StepLatency {
  step: string;
  profile: string;
  latency_ms: number;
  http_status: number;
  concurrency_level: number;
  phase: string;
}

interface RateLimitPoint {
  step: string;
  rate_limit_remaining: number;
  rate_limit_used: number;
  start_ts: number;
}

interface CycleSummary {
  cycle_id: string;
  profile: string;
  phase: string;
  concurrency_level: number;
  total_wall_ms: number;
  total_api_ms: number;
  total_poll_ms: number;
  api_call_count: number;
  rate_limit_hits: number;
}

interface ErrorEntry {
  step: string;
  profile: string;
  http_status: number;
  error: string;
  cycle_id: string;
}

interface LiveStats {
  total_api_calls: number;
  total_api_ms: number;
  total_poll_ms: number;
  total_rl_hits: number;
}

interface RunDetail {
  run: Run;
  cycles: CycleSummary[];
  steps: StepStat[];
  stepLatencies: StepLatency[];
  rateLimits: RateLimitPoint[];
  errors: ErrorEntry[];
  liveStats: LiveStats;
}

interface CompareData {
  runs: Run[];
  stepStats: (StepStat & { run_id: string })[];
  cycleSummaries: (CycleSummary & { run_id: string; cycles: number; avg_api_ms: number; avg_wall_ms: number; total_api_calls: number; total_rl_hits: number })[];
}

// ============================================================
// COLORS — Grafana dark palette
// ============================================================

const G = {
  blue: "#7aadff",
  green: "#96d88d",
  red: "#ff6b7f",
  orange: "#ffb347",
  yellow: "#ffe66d",
  purple: "#d4a4f5",
  cyan: "#a8d4ff",
  teal: "#6ddcb2",
  textPrimary: "#eef0f4",
  textSecondary: "#a4a8b2",
  textDisabled: "#7a7e88",
  bgCanvas: "#1a1d24",
  bgPrimary: "#22262e",
  bgSecondary: "#2a2f38",
  border: "#3a3f4a",
};

const RUN_COLORS = [G.blue, G.red, G.green, G.purple, G.orange];

const PROFILE_COLORS: Record<string, { color: string; bg: string }> = {
  amber: { color: G.orange, bg: `${G.orange}20` },
  amber_opt: { color: G.yellow, bg: `${G.yellow}20` },
  dependabot: { color: G.blue, bg: `${G.blue}20` },
  human: { color: G.teal, bg: `${G.teal}20` },
  mergify: { color: G.purple, bg: `${G.purple}20` },
};

const STEP_DESCRIPTIONS: Record<string, string> = {
  create_issue: "POST /repos/{owner}/{repo}/issues — Creates a GitHub issue with amber-autofix label to trigger the workflow",
  workflow_dispatch: "POST /repos/{owner}/{repo}/dispatches — Fires a repository_dispatch event to trigger GitHub Actions",
  sim_ambient_action: "Simulated: ambient-action container boots and processes the event (2s)",
  sim_acp_session: "Simulated: ACP session is created for the agent to work in (1.5s)",
  sim_amber2_workflow: "Simulated: Amber2 workflow orchestrator runs (3s)",
  load_repo_context: "GET /repos/{owner}/{repo} — Fetches repository metadata (default branch, permissions, etc.)",
  load_issue_context: "GET /repos/{owner}/{repo}/issues/{number} — Reads issue body, labels, and current state",
  sim_spec_kit: "Simulated: Spec Kit analyzes the issue and generates a specification (5s)",
  sim_reproduce: "Simulated: Agent attempts to reproduce the bug with a test (8s)",
  sim_implement: "Simulated: Agent implements the fix based on the spec (12s)",
  get_head_sha: "GET /repos/{owner}/{repo}/git/ref/heads/{branch} — Resolves HEAD SHA for branch operations",
  create_status: "POST /repos/{owner}/{repo}/statuses/{sha} — Creates a pending commit status (CI started)",
  complete_status: "POST /repos/{owner}/{repo}/statuses/{sha} — Updates commit status to success (CI passed)",
  emit_report: "POST /repos/{owner}/{repo}/issues/{number}/comments — Posts structured JSON report as issue comment",
  create_branch: "POST /repos/{owner}/{repo}/git/refs — Creates a new branch ref from base SHA",
  push_file: "PUT /repos/{owner}/{repo}/contents/{path} — Commits a file to the branch via Contents API",
  push_file_0: "PUT /repos/{owner}/{repo}/contents/{path} — Commits first file to the branch",
  push_file_1: "PUT /repos/{owner}/{repo}/contents/{path} — Commits second file to the branch",
  create_pr: "POST /repos/{owner}/{repo}/pulls — Opens a pull request from the feature branch",
  create_draft_pr: "POST /repos/{owner}/{repo}/pulls — Opens a draft pull request (merge queue batch)",
  poll_mergeable: "GET /repos/{owner}/{repo}/pulls/{number} — Polls until GitHub computes mergeable state (event propagation delay)",
  submit_review: "POST /repos/{owner}/{repo}/pulls/{number}/reviews — Posts a COMMENT review (can't self-approve)",
  human_review: "POST /repos/{owner}/{repo}/pulls/{number}/reviews — Simulates human reviewer posting a comment",
  bot_review_comment: "POST /repos/{owner}/{repo}/issues/{number}/comments — Bot posts automated review summary (CodeRabbit-style)",
  merge_pr: "PUT /repos/{owner}/{repo}/pulls/{number}/merge — Merges the PR (squash or merge commit)",
  post_merge_comment: "POST /repos/{owner}/{repo}/issues/{number}/comments — Posts post-merge learning summary",
  close_issue: "PATCH /repos/{owner}/{repo}/issues/{number} — Closes the issue and applies benchmark-complete label",
  close_pr: "PATCH /repos/{owner}/{repo}/pulls/{number} — Closes the draft PR without merging",
  queue_status_comment: "POST /repos/{owner}/{repo}/issues/{number}/comments — Mergify posts queue batch status",
  cleanup_branch: "DELETE /repos/{owner}/{repo}/git/refs/heads/{branch} — Deletes the feature branch after merge",
};

const AMBER_STEP_ORDER = [
  "create_issue", "workflow_dispatch",
  "sim_ambient_action", "sim_acp_session", "sim_amber2_workflow",
  "load_repo_context", "load_issue_context",
  "sim_spec_kit", "sim_reproduce", "sim_implement",
  "get_head_sha", "create_status", "complete_status",
  "emit_report", "create_branch", "push_file",
  "create_pr", "poll_mergeable", "submit_review",
  "merge_pr", "post_merge_comment", "close_issue", "cleanup_branch",
];

const DEPENDABOT_STEP_ORDER = [
  "get_head_sha", "create_branch", "push_file",
  "create_pr", "poll_mergeable", "merge_pr", "cleanup_branch",
];

function sortSteps<T extends { name?: string; step?: string; profile?: string }>(items: T[], profile: string): T[] {
  const order = (profile === "amber" || profile === "amber_opt") ? AMBER_STEP_ORDER : DEPENDABOT_STEP_ORDER;
  return [...items].sort((a, b) => {
    const aName = a.name || a.step || "";
    const bName = b.name || b.step || "";
    const aIdx = order.indexOf(aName);
    const bIdx = order.indexOf(bName);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-[16px] font-medium uppercase tracking-wide" style={{ color: G.textSecondary }}>{label}</p>
        <p className="text-4xl font-light mt-1" style={{ color: G.textPrimary }}>{value}</p>
        {sub && <p className="text-[14px] font-medium mt-1" style={{ color: G.textDisabled }}>{sub}</p>}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { color: string; bg: string }> = {
    completed: { color: G.green, bg: `${G.green}20` },
    running: { color: G.yellow, bg: `${G.yellow}20` },
    failed: { color: G.red, bg: `${G.red}20` },
    stopped: { color: G.textSecondary, bg: `${G.textSecondary}20` },
  };
  const s = styles[status] || styles.running;
  return (
    <Badge className="font-bold text-[14px] border" style={{ color: s.color, backgroundColor: s.bg, borderColor: `${s.color}40` }}>
      {status}
    </Badge>
  );
}

function ProfileBadge({ profile }: { profile: string }) {
  const p = PROFILE_COLORS[profile] || { color: G.textSecondary, bg: `${G.textSecondary}20` };
  return (
    <Badge className="font-bold text-[14px] border" style={{ color: p.color, backgroundColor: p.bg, borderColor: `${p.color}40` }}>
      {profile}
    </Badge>
  );
}

// ============================================================
// HELPERS
// ============================================================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computePercentiles(latencies: StepLatencyExt[], profile: string) {
  const byStep: Record<string, number[]> = {};
  for (const l of latencies) {
    if (l.profile === profile && l.http_method !== "SIM") {
      if (!byStep[l.step]) byStep[l.step] = [];
      byStep[l.step].push(l.latency_ms);
    }
  }

  const order = profile === "amber" ? AMBER_STEP_ORDER : DEPENDABOT_STEP_ORDER;
  return Object.entries(byStep)
    .map(([step, vals]) => {
      const sorted = [...vals].sort((a, b) => a - b);
      return {
        step,
        p50: Math.round(percentile(sorted, 50)),
        p90: Math.round(percentile(sorted, 90)),
        p99: Math.round(percentile(sorted, 99)),
        count: sorted.length,
      };
    })
    .sort((a, b) => {
      const ai = order.indexOf(a.step);
      const bi = order.indexOf(b.step);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
}

function buildHistogram(latencies: StepLatencyExt[], profile: string, bucketCount = 20) {
  const vals = latencies
    .filter((l) => l.profile === profile && l.http_method !== "SIM")
    .map((l) => l.latency_ms);
  if (vals.length === 0) return [];

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const bucketSize = Math.max(1, Math.ceil((max - min) / bucketCount));

  const buckets: { range: string; from: number; count: number }[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const from = min + i * bucketSize;
    const to = from + bucketSize;
    buckets.push({
      range: `${Math.round(from)}`,
      from,
      count: vals.filter((v) => v >= from && v < to).length,
    });
  }
  if (buckets.length > 0) {
    buckets[buckets.length - 1].count += vals.filter((v) => v === max).length;
  }
  return buckets.filter((b) => b.count > 0 || buckets.indexOf(b) === 0);
}

interface StepLatencyExt extends StepLatency {
  http_method?: string;
}

function getSimSteps(stepLatencies: StepLatencyExt[], profile: string) {
  const sims: Record<string, { sum: number; count: number }> = {};
  for (const s of stepLatencies) {
    if (s.http_method === "SIM" && s.profile === profile) {
      if (!sims[s.step]) sims[s.step] = { sum: 0, count: 0 };
      sims[s.step].sum += s.latency_ms;
      sims[s.step].count += 1;
    }
  }
  return Object.entries(sims).map(([step, d]) => ({
    name: step,
    profile,
    avg: Math.round(d.sum / d.count),
    min: Math.round(d.sum / d.count),
    max: Math.round(d.sum / d.count),
    count: 0,
  }));
}

const chartTheme = {
  tooltip: { backgroundColor: G.bgSecondary, border: `1px solid ${G.border}`, color: G.textPrimary },
  grid: G.border,
  text: { fill: G.textSecondary, fontSize: 12 },
};

// ============================================================
// SEQUENCE DIAGRAM / WATERFALL
// ============================================================

function SequenceDiagram({ steps, profile }: { steps: { name: string; avg: number; count: number }[]; profile: string }) {
  const sorted = sortSteps(steps, profile);
  const maxMs = Math.max(...sorted.map((s) => s.avg), 1);
  const pc = PROFILE_COLORS[profile] || { color: G.blue, bg: `${G.blue}30` };

  return (
    <div className="font-mono text-[14px]">
      <div className="flex items-center gap-4 mb-3 px-2">
        <div className="w-[180px] text-right font-bold" style={{ color: G.textSecondary }}>Client</div>
        <div className="w-16 text-center" style={{ color: G.textDisabled }}>|</div>
        <div className="font-bold" style={{ color: G.textSecondary }}>GitHub API</div>
      </div>
      <div style={{ borderTop: `1px solid ${G.border}` }} />

      {sorted.map((step) => {
        const isSim = step.name.startsWith("sim_");
        const barWidth = isSim ? 0 : Math.max(8, (step.avg / maxMs) * 200);

        return (
          <div key={step.name} className="flex items-center gap-4 px-2 py-[6px] g-hover"
            style={{ borderBottom: `1px solid ${G.border}15` }}>
            <div className={`w-[180px] text-right font-semibold truncate ${isSim ? "italic" : ""}`}
              style={{ color: isSim ? G.textDisabled : G.textPrimary }}
              title={STEP_DESCRIPTIONS[step.name] || step.name}>
              {step.name}
            </div>
            <div className="w-16 flex items-center justify-center relative">
              <div className="absolute top-0 bottom-0 left-1/2 w-px" style={{ backgroundColor: G.border, transform: "translateX(-50%)" }} />
              {!isSim && (
                <svg width="40" height="12" className="relative z-10">
                  <line x1="0" y1="6" x2="34" y2="6" stroke={pc.color} strokeWidth="2" />
                  <polygon points="34,2 40,6 34,10" fill={pc.color} />
                </svg>
              )}
              {isSim && <span className="relative z-10 text-[11px]" style={{ color: G.textDisabled }}>---</span>}
            </div>
            <div className="flex items-center gap-2 flex-1">
              {!isSim ? (
                <>
                  <div className="h-5 rounded-r-sm" style={{ width: barWidth, backgroundColor: pc.bg, border: `1px solid ${pc.color}60` }} />
                  <span className="font-bold" style={{ color: G.textPrimary }}>{step.avg}ms</span>
                  {step.count > 1 && <span className="text-[11px]" style={{ color: G.textDisabled }}>x{step.count}</span>}
                </>
              ) : (
                <span className="italic text-[11px]" style={{ color: G.textDisabled }}>simulated ({step.avg}ms)</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// RUNNING STATUS PANEL
// ============================================================

function RunningStatusPanel({ runs }: { runs: Run[] }) {
  const runningRuns = runs.filter((r) => r.status === "running");
  const [expanded, setExpanded] = useState(false);

  if (runningRuns.length === 0) return null;

  return (
    <div className="mb-4 rounded" style={{ backgroundColor: G.bgPrimary, border: `1px solid ${G.border}` }}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={() => setExpanded(!expanded)}>
        <span className="text-[14px] transition-transform duration-200" style={{ color: G.yellow, transform: expanded ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block" }}>
          &#9654;
        </span>
        <span className="text-[16px] font-medium" style={{ color: G.yellow }}>
          {runningRuns.length} run{runningRuns.length > 1 ? "s" : ""} active
        </span>
        <span className="animate-pulse text-[14px]" style={{ color: G.yellow }}>&#9679;</span>
        <span className="flex-1" />
        {runningRuns.map((r) => (
          <span key={r.run_id} className="text-[13px] font-mono" style={{ color: G.textSecondary }}>
            {r.name || r.run_id.slice(0, 20)} — {r.cycle_count}/{r.total_cycles} cycles
          </span>
        ))}
      </button>
      {expanded && (
        <div className="px-4 pb-3 grid gap-2" style={{ borderTop: `1px solid ${G.border}` }}>
          {runningRuns.map((r) => {
            const elapsed = r.started_at ? Math.round((Date.now() - new Date(r.started_at).getTime()) / 1000) : 0;
            const elapsedStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
            return (
              <div key={r.run_id} className="flex items-center gap-4 py-2 text-[13px]">
                <span className="font-bold" style={{ color: G.textPrimary }}>{r.name || r.run_id.slice(0, 20)}</span>
                <span style={{ color: G.textSecondary }}>Cycles: {r.cycle_count}/{r.total_cycles}</span>
                <span style={{ color: G.textSecondary }}>API calls: {r.total_api_calls}</span>
                <span style={{ color: G.textSecondary }}>API time: {(r.total_api_ms / 1000).toFixed(1)}s</span>
                <span style={{ color: G.textSecondary }}>Elapsed: {elapsedStr}</span>
                {r.total_rl_hits > 0 && <span style={{ color: G.red }}>Rate limit hits: {r.total_rl_hits}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// LAUNCH DIALOG
// ============================================================

interface LaunchConfig {
  runName: string;
  totalCycles: number;
  sequentialCycles: number;
  maxConcurrency: number;
  pctAmber: number;
  pctAmberOpt: number;
  pctDependabot: number;
}

const DEFAULT_CONFIG: LaunchConfig = {
  runName: "",
  totalCycles: 4,
  sequentialCycles: 2,
  maxConcurrency: 3,
  pctAmber: 60,
  pctAmberOpt: 0,
  pctDependabot: 40,
};

function LaunchDialog({ onLaunched, externalOpen, onExternalClose, initialConfig }: {
  onLaunched: () => void;
  externalOpen?: boolean;
  onExternalClose?: () => void;
  initialConfig?: LaunchConfig;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = externalOpen ?? internalOpen;
  const setOpen = (v: boolean) => {
    setInternalOpen(v);
    if (!v && onExternalClose) onExternalClose();
  };
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [config, setConfig] = useState<LaunchConfig>(initialConfig || DEFAULT_CONFIG);

  useEffect(() => {
    if (initialConfig) setConfig(initialConfig);
  }, [initialConfig]);

  const launch = async () => {
    setLaunching(true);
    setLaunchError(null);
    try {
      const resp = await fetch("/api/benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setLaunchError(data.error || `Launch failed (HTTP ${resp.status})`);
        return;
      }
      setOpen(false);
      onLaunched();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!onExternalClose && (
        <DialogTrigger className="text-[15px] font-bold h-10 rounded px-4 cursor-pointer"
          style={{ backgroundColor: G.green, color: G.bgCanvas }}>
          Launch Benchmark
        </DialogTrigger>
      )}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold" style={{ color: G.textPrimary }}>Launch Benchmark Run</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5 py-4">
          <p className="text-[16px] font-medium uppercase tracking-wide" style={{ color: G.textSecondary }}>Preset</p>
          <div className="grid grid-cols-2 gap-3">
            {[
              { name: "Amber Baseline", sub: "20 cycles, standard workflow", cfg: { runName: "baseline", totalCycles: 20, sequentialCycles: 10, maxConcurrency: 3, pctAmber: 60, pctAmberOpt: 0, pctDependabot: 40 } },
              { name: "Amber Optimized", sub: "20 cycles, 3 optimizations", cfg: { runName: "optimized", totalCycles: 20, sequentialCycles: 10, maxConcurrency: 3, pctAmber: 0, pctAmberOpt: 60, pctDependabot: 40 } },
              { name: "A/B Test", sub: "20 cycles, both profiles", cfg: { runName: "a-b-test", totalCycles: 20, sequentialCycles: 10, maxConcurrency: 3, pctAmber: 30, pctAmberOpt: 30, pctDependabot: 40 } },
              { name: "Stress Test", sub: "100 cycles, concurrency 5", cfg: { runName: "stress-test", totalCycles: 100, sequentialCycles: 10, maxConcurrency: 5, pctAmber: 60, pctAmberOpt: 0, pctDependabot: 40 } },
            ].map((preset) => (
              <button key={preset.name}
                className="rounded-lg p-3 text-left cursor-pointer g-hover"
                style={{ border: `1px solid ${G.border}` }}
                                onClick={() => setConfig(preset.cfg)}>
                <div className="text-[16px] font-bold" style={{ color: G.textPrimary }}>{preset.name}</div>
                <div className="text-[12px] font-medium mt-0.5" style={{ color: G.textDisabled }}>{preset.sub}</div>
              </button>
            ))}
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <Label className="text-[15px] font-medium" style={{ color: G.textSecondary }}>Run Name</Label>
            <Input placeholder="e.g. baseline-v2" className="text-[15px] font-semibold h-10"
              value={config.runName}
              onChange={(e) => setConfig({ ...config, runName: e.target.value })} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Cycles", key: "totalCycles" as const },
              { label: "Sequential", key: "sequentialCycles" as const },
              { label: "Max Concurrency", key: "maxConcurrency" as const },
            ].map((f) => (
              <div key={f.key} className="flex flex-col gap-1">
                <Label className="text-[12px] font-medium" style={{ color: G.textDisabled }}>{f.label}</Label>
                <Input type="number" className="text-[15px] font-semibold h-10"
                  value={config[f.key]}
                  onChange={(e) => setConfig({ ...config, [f.key]: +e.target.value })} />
              </div>
            ))}
          </div>

          {launchError && (
            <div className="rounded p-3 text-[13px] font-medium"
              style={{ backgroundColor: `${G.red}15`, border: `1px solid ${G.red}40`, color: G.red }}>
              {launchError}
            </div>
          )}

          <Button onClick={launch} disabled={launching}
            className="text-[15px] font-bold h-11 w-full"
            style={{ backgroundColor: G.green, color: G.bgCanvas }}>
            {launching ? "Launching..." : "Start Run"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// RUNS LIST VIEW
// ============================================================

function RunsList({ runs, onSelect, selectedRuns, onToggleCompare, onDelete, onStop, onClone }: {
  runs: Run[];
  onSelect: (id: string) => void;
  selectedRuns: Set<string>;
  onToggleCompare: (id: string) => void;
  onDelete: (id: string) => void;
  onStop: (id: string) => void;
  onClone: (run: Run) => void;
}) {
  if (runs.length === 0) {
    return (
      <Card>
        <CardContent className="pt-8 pb-8 text-center">
          <p className="text-xl font-medium" style={{ color: G.textDisabled }}>No runs yet. Launch a benchmark to get started.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-4" style={{ borderBottom: `1px solid ${G.border}` }}>
        <CardTitle className="text-lg font-bold" style={{ color: G.textPrimary }}>Benchmark Runs</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              {["", "Name", "Status", "Cycles", "Calls", "API Time", "Mix", "Started", "Actions"].map((h) => (
                <TableHead key={h} className={`text-[15px] font-medium ${h === "Cycles" || h === "Calls" || h === "API Time" ? "text-right" : ""}`}
                  style={{ color: G.textSecondary }}>
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.run_id} className="cursor-pointer g-row-hover"
                style={{ borderBottom: `1px solid ${G.border}30` }}
                                onClick={() => onSelect(run.run_id)}>
                <TableCell className="pr-0" onClick={(e) => { e.stopPropagation(); onToggleCompare(run.run_id); }}>
                  <input type="checkbox" checked={selectedRuns.has(run.run_id)}
                    onChange={() => onToggleCompare(run.run_id)}
                    className="w-4 h-4" style={{ accentColor: G.blue }} />
                </TableCell>
                <TableCell className="text-[14px] font-semibold max-w-[200px] truncate" style={{ color: G.textPrimary }}>
                  {run.name || run.run_id}
                </TableCell>
                <TableCell><StatusBadge status={run.status} /></TableCell>
                <TableCell className="text-[14px] font-semibold text-right" style={{ color: G.textPrimary }}>{run.cycle_count}/{run.total_cycles}</TableCell>
                <TableCell className="text-[14px] font-semibold text-right" style={{ color: G.textPrimary }}>{run.total_api_calls}</TableCell>
                <TableCell className="text-[14px] font-semibold text-right" style={{ color: G.textPrimary }}>{(run.total_api_ms / 1000).toFixed(1)}s</TableCell>
                <TableCell>
                  <div className="flex gap-1 flex-wrap">
                    {run.pct_amber > 0 && (
                      <Badge className="font-bold text-[11px] px-1.5 py-0 border"
                        style={{ color: G.orange, backgroundColor: `${G.orange}20`, borderColor: `${G.orange}40` }}>
                        {run.pct_amber}% A
                      </Badge>
                    )}
                    {run.pct_dependabot > 0 && (
                      <Badge className="font-bold text-[11px] px-1.5 py-0 border"
                        style={{ color: G.blue, backgroundColor: `${G.blue}20`, borderColor: `${G.blue}40` }}>
                        {run.pct_dependabot}% D
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-[12px] font-medium whitespace-nowrap" style={{ color: G.textDisabled }}>
                  {new Date(run.started_at).toLocaleDateString()}{" "}
                  {new Date(run.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <div className="flex gap-1.5">
                    <Button variant="outline" size="sm"
                      className="text-[13px] font-bold h-7 px-2"
                      style={run.status === "running"
                        ? { color: G.orange, borderColor: `${G.orange}40` }
                        : { color: G.textDisabled, borderColor: G.border }}
                      disabled={run.status !== "running"}
                      onClick={() => onStop(run.run_id)}>Stop</Button>
                    <Button variant="outline" size="sm"
                      className="text-[13px] font-bold h-7 px-2"
                      style={{ color: G.blue, borderColor: `${G.blue}40` }}
                      onClick={() => onClone(run)}>Clone</Button>
                    <Button variant="outline" size="sm"
                      className="text-[13px] font-bold h-7 px-2"
                      style={{ color: G.red, borderColor: `${G.red}40` }}
                      onClick={() => onDelete(run.run_id)}>Delete</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ============================================================
// RUN DETAIL VIEW
// ============================================================

function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [data, setData] = useState<RunDetail | null>(null);

  const fetchData = useCallback(() => {
    fetch(`/api/runs/${runId}`).then((r) => r.json()).then(setData);
  }, [runId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (!data) return <p className="text-lg font-medium p-8" style={{ color: G.textDisabled }}>Loading...</p>;

  const { run, cycles, steps, stepLatencies, rateLimits, errors, liveStats } = data;

  const allStepChartData = steps.map((s) => ({
    name: s.step, profile: s.profile,
    avg: Math.round(s.avg_ms), min: Math.round(s.min_ms), max: Math.round(s.max_ms), count: s.count,
  }));

  const profiles = [...new Set(allStepChartData.map((s) => s.profile))];
  const stepsByProfile: Record<string, typeof allStepChartData> = {};
  const allStepsByProfile: Record<string, typeof allStepChartData> = {};
  const percentilesByProfile: Record<string, ReturnType<typeof computePercentiles>> = {};
  const histogramByProfile: Record<string, ReturnType<typeof buildHistogram>> = {};

  for (const p of profiles) {
    const pSteps = sortSteps(allStepChartData.filter((s) => s.profile === p), p);
    stepsByProfile[p] = pSteps;
    allStepsByProfile[p] = sortSteps([...pSteps, ...getSimSteps(stepLatencies, p)], p);
    percentilesByProfile[p] = computePercentiles(stepLatencies as StepLatencyExt[], p);
    histogramByProfile[p] = buildHistogram(stepLatencies as StepLatencyExt[], p);
  }

  const hasEnoughData = (stepLatencies?.length || 0) > 20;
  const rlTimeline = rateLimits.map((r, i) => ({ idx: i, remaining: r.rate_limit_remaining, used: r.rate_limit_used, step: r.step }));
  const concurrencyData = stepLatencies.reduce<Record<number, { sum: number; count: number }>>((acc, s) => {
    if (!acc[s.concurrency_level]) acc[s.concurrency_level] = { sum: 0, count: 0 };
    acc[s.concurrency_level].sum += s.latency_ms;
    acc[s.concurrency_level].count += 1;
    return acc;
  }, {});
  const concurrencyChart = Object.entries(concurrencyData).map(([c, d]) => ({ concurrency: +c, avg_ms: Math.round(d.sum / d.count) }));
  const cycleChart = cycles.map((c) => ({
    id: c.cycle_id.slice(0, 20), profile: c.profile,
    api_ms: Math.round(c.total_api_ms), poll_ms: Math.round(c.total_poll_ms),
    wall_ms: Math.round(c.total_wall_ms), calls: c.api_call_count,
  }));

  const totalApiMs = liveStats?.total_api_ms || cycles.reduce((s, c) => s + c.total_api_ms, 0);
  const totalPollMs = liveStats?.total_poll_ms || cycles.reduce((s, c) => s + c.total_poll_ms, 0);
  const totalCalls = liveStats?.total_api_calls || cycles.reduce((s, c) => s + c.api_call_count, 0);
  const totalRlHits = liveStats?.total_rl_hits || cycles.reduce((s, c) => s + c.rate_limit_hits, 0);
  const avgPerCall = totalCalls > 0 ? totalApiMs / totalCalls : 0;
  const pollPct = totalApiMs > 0 ? (totalPollMs / totalApiMs * 100) : 0;

  const cycleProfiles = [...new Set(cycles.map((c) => c.profile))];
  const cyclePercentiles: Record<string, { sorted: number[]; p50: number; p90: number; p99: number }> = {};
  for (const p of cycleProfiles) {
    const sorted = cycles.filter((c) => c.profile === p).map((c) => c.total_api_ms).sort((a, b) => a - b);
    cyclePercentiles[p] = { sorted, p50: percentile(sorted, 50), p90: percentile(sorted, 90), p99: percentile(sorted, 99) };
  }

  const profileColor = (p: string) => PROFILE_COLORS[p]?.color || G.blue;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" onClick={onBack} className="font-bold text-[16px] h-10">Back</Button>
        <h2 className="text-2xl font-bold" style={{ color: G.textPrimary }}>{run.name || run.run_id}</h2>
        <StatusBadge status={run.status} />
        {run.status === "running" && (
          <>
            <span className="text-[14px] font-medium animate-pulse" style={{ color: G.yellow }}>Live — refreshing every 3s</span>
            <Button variant="outline" className="text-[14px] font-bold h-8"
              style={{ color: G.red, borderColor: `${G.red}40` }}
              onClick={async () => {
                await fetch(`/api/runs/${runId}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ status: "stopped" }) });
                fetchData();
              }}>Stop</Button>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Total API Calls" value={totalCalls} />
        <StatCard label="Total API Time" value={`${(totalApiMs / 1000).toFixed(1)}s`} />
        <StatCard label="Avg Per Call" value={`${avgPerCall.toFixed(0)}ms`} />
        <StatCard label="GH Reconciliation Wait" value={`${pollPct.toFixed(1)}%`} sub={`${(totalPollMs / 1000).toFixed(1)}s waiting for GitHub`} />
        <StatCard label="Rate Limit Hits" value={totalRlHits} />
      </div>

      {cycleProfiles.some((p) => cyclePercentiles[p].sorted.length > 1) && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {cycleProfiles.map((p) => {
            const cp = cyclePercentiles[p];
            if (cp.sorted.length <= 1) return null;
            return [
              <StatCard key={`${p}-p50`} label={`${p} p50`} value={`${(cp.p50 / 1000).toFixed(1)}s`} sub={`${cp.sorted.length} cycles`} />,
              <StatCard key={`${p}-p90`} label={`${p} p90`} value={`${(cp.p90 / 1000).toFixed(1)}s`} />,
              <StatCard key={`${p}-p99`} label={`${p} p99`} value={`${(cp.p99 / 1000).toFixed(1)}s`} />,
            ];
          })}
        </div>
      )}

      <Tabs defaultValue="steps">
        <TabsList className="mb-4">
          <TabsTrigger value="steps" className="font-bold">Step Latency</TabsTrigger>
          <TabsTrigger value="cycles" className="font-bold">Cycles</TabsTrigger>
          <TabsTrigger value="ratelimit" className="font-bold">Rate Limits</TabsTrigger>
          <TabsTrigger value="concurrency" className="font-bold">Concurrency</TabsTrigger>
          <TabsTrigger value="errors" className="font-bold">Errors ({errors.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="steps">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {profiles.map((p) => (allStepsByProfile[p]?.length > 0) && (
              <Card key={`seq-${p}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg font-bold flex items-center gap-2">
                    <ProfileBadge profile={p} /> Workflow Sequence
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-2">
                  <SequenceDiagram steps={allStepsByProfile[p]} profile={p} />
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {profiles.map((p) => (stepsByProfile[p]?.length > 0) && (
              <Card key={`bar-${p}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg font-bold flex items-center gap-2">
                    <ProfileBadge profile={p} /> Step Latency (avg ms)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={Math.max(300, stepsByProfile[p].length * 32)}>
                    <BarChart data={stepsByProfile[p]} layout="vertical" margin={{ left: 140 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                      <XAxis type="number" tick={chartTheme.text} />
                      <YAxis dataKey="name" type="category" tick={{ ...chartTheme.text, fontWeight: 600 }} width={140} />
                      <Tooltip contentStyle={chartTheme.tooltip} />
                      <Bar dataKey="avg" fill={profileColor(p)} name="Avg (ms)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            ))}
          </div>

          {hasEnoughData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
              {profiles.map((p) => (percentilesByProfile[p]?.length > 0) && (
                <Card key={`pct-${p}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg font-bold flex items-center gap-2">
                      <ProfileBadge profile={p} /> Percentiles (p50 / p90 / p99)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={Math.max(300, percentilesByProfile[p].length * 36)}>
                      <BarChart data={percentilesByProfile[p]} layout="vertical" margin={{ left: 140 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                        <XAxis type="number" tick={chartTheme.text} />
                        <YAxis dataKey="step" type="category" tick={{ ...chartTheme.text, fontWeight: 600 }} width={140} />
                        <Tooltip contentStyle={chartTheme.tooltip} />
                        <Legend wrapperStyle={{ color: G.textSecondary }} />
                        <Bar dataKey="p50" fill={`${profileColor(p)}80`} name="p50" radius={[0, 2, 2, 0]} />
                        <Bar dataKey="p90" fill={profileColor(p)} name="p90" radius={[0, 2, 2, 0]} />
                        <Bar dataKey="p99" fill={`${profileColor(p)}60`} name="p99" radius={[0, 2, 2, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {hasEnoughData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
              {profiles.map((p) => (histogramByProfile[p]?.length > 0) && (
                <Card key={`hist-${p}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg font-bold flex items-center gap-2">
                      <ProfileBadge profile={p} /> Latency Distribution
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={histogramByProfile[p]}>
                        <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                        <XAxis dataKey="range" tick={chartTheme.text} label={{ ...chartTheme.text, value: "Latency (ms)", position: "bottom", offset: 0 }} />
                        <YAxis tick={chartTheme.text} label={{ ...chartTheme.text, value: "Count", angle: -90, position: "insideLeft" }} />
                        <Tooltip contentStyle={chartTheme.tooltip} labelFormatter={(v) => `${v}ms`} />
                        <Bar dataKey="count" fill={profileColor(p)} name="Calls" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="cycles">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-bold" style={{ color: G.textPrimary }}>Per-Cycle Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={350}>
                <BarChart data={cycleChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                  <XAxis dataKey="id" tick={{ ...chartTheme.text, fontSize: 10 }} />
                  <YAxis tick={chartTheme.text} />
                  <Tooltip contentStyle={chartTheme.tooltip} />
                  <Legend wrapperStyle={{ color: G.textSecondary }} />
                  <Bar dataKey="api_ms" stackId="a" fill={G.blue} name="API (ms)" />
                  <Bar dataKey="poll_ms" stackId="a" fill={G.red} name="Poll (ms)" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card className="mt-4">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    {["Cycle", "Profile", "Phase", "Concurrency", "API Time", "Poll Time", "Wall Time", "Calls"].map((h) => (
                      <TableHead key={h} className="text-[16px] font-medium" style={{ color: G.textSecondary }}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cycles.map((c) => (
                    <TableRow key={c.cycle_id} style={{ borderBottom: `1px solid ${G.border}30` }}>
                      <TableCell className="text-[15px] font-mono font-semibold" style={{ color: G.textPrimary }}>{c.cycle_id.slice(0, 30)}</TableCell>
                      <TableCell><ProfileBadge profile={c.profile} /></TableCell>
                      <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{c.phase}</TableCell>
                      <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{c.concurrency_level}</TableCell>
                      <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{(c.total_api_ms / 1000).toFixed(1)}s</TableCell>
                      <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{(c.total_poll_ms / 1000).toFixed(1)}s</TableCell>
                      <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{(c.total_wall_ms / 1000).toFixed(1)}s</TableCell>
                      <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{c.api_call_count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ratelimit">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-bold" style={{ color: G.textPrimary }}>Rate Limit Remaining Over Time</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={350}>
                <LineChart data={rlTimeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                  <XAxis dataKey="idx" tick={chartTheme.text} label={{ ...chartTheme.text, value: "API Call #", position: "bottom" }} />
                  <YAxis tick={chartTheme.text} />
                  <Tooltip contentStyle={chartTheme.tooltip} labelFormatter={(v) => `Call #${v}`} />
                  <Line type="monotone" dataKey="remaining" stroke={G.green} strokeWidth={2} dot={false} name="remaining" />
                  <Line type="monotone" dataKey="used" stroke={G.red} strokeWidth={2} dot={false} name="used" />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="concurrency">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-bold" style={{ color: G.textPrimary }}>Avg Latency vs Concurrency Level</CardTitle>
            </CardHeader>
            <CardContent>
              {concurrencyChart.length > 1 ? (
                <ResponsiveContainer width="100%" height={350}>
                  <ScatterChart>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                    <XAxis dataKey="concurrency" name="Concurrency" type="number" tick={chartTheme.text} />
                    <YAxis dataKey="avg_ms" name="Avg Latency (ms)" tick={chartTheme.text} />
                    <Tooltip contentStyle={chartTheme.tooltip} cursor={{ strokeDasharray: "3 3" }} />
                    <Scatter data={concurrencyChart} fill={G.blue} />
                  </ScatterChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-[16px] font-medium py-12 text-center" style={{ color: G.textDisabled }}>
                  Need parallel cycles with varying concurrency to show this chart.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="errors">
          <Card>
            <CardContent className="p-0">
              {errors.length === 0 ? (
                <p className="text-[16px] font-bold p-8 text-center" style={{ color: G.green }}>No errors.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {["Step", "Profile", "Status", "Error"].map((h) => (
                        <TableHead key={h} className="text-[16px] font-medium" style={{ color: G.textSecondary }}>{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.map((e, i) => (
                      <TableRow key={`${e.cycle_id}-${e.step}-${i}`} style={{ borderBottom: `1px solid ${G.border}30` }}>
                        <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{e.step}</TableCell>
                        <TableCell><ProfileBadge profile={e.profile} /></TableCell>
                        <TableCell>
                          <Badge className="font-bold border" style={{ color: G.red, backgroundColor: `${G.red}20`, borderColor: `${G.red}40` }}>{e.http_status}</Badge>
                        </TableCell>
                        <TableCell className="text-[15px] font-mono max-w-md truncate" style={{ color: G.textSecondary }}>
                          {e.error?.slice(0, 120)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
// COMPARE VIEW
// ============================================================

function CompareView({ runIds, onBack }: { runIds: string[]; onBack: () => void }) {
  const [data, setData] = useState<CompareData | null>(null);

  useEffect(() => {
    const params = runIds.map((id) => `run=${id}`).join("&");
    fetch(`/api/compare?${params}`).then((r) => r.json()).then(setData);
  }, [runIds]);

  if (!data) return <p className="text-lg font-medium p-8" style={{ color: G.textDisabled }}>Loading...</p>;

  const stepsByRun: Record<string, Record<string, number>> = {};
  for (const s of data.stepStats) {
    if (!stepsByRun[s.step]) stepsByRun[s.step] = {};
    stepsByRun[s.step][s.run_id] = Math.round(s.avg_ms);
  }
  const compareChart = Object.entries(stepsByRun).map(([step, runs]) => ({ step, ...runs }));

  const summaryByRun = data.cycleSummaries.reduce<Record<string, {
    totalApi: number; totalWall: number; calls: number; rlHits: number; cycles: number;
  }>>((acc, c) => {
    if (!acc[c.run_id]) acc[c.run_id] = { totalApi: 0, totalWall: 0, calls: 0, rlHits: 0, cycles: 0 };
    acc[c.run_id].totalApi += c.avg_api_ms * c.cycles;
    acc[c.run_id].totalWall += c.avg_wall_ms * c.cycles;
    acc[c.run_id].calls += c.total_api_calls;
    acc[c.run_id].rlHits += c.total_rl_hits;
    acc[c.run_id].cycles += c.cycles;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" onClick={onBack} className="font-bold text-[16px] h-10">Back</Button>
        <h2 className="text-2xl font-bold" style={{ color: G.textPrimary }}>Compare Runs</h2>
        {runIds.map((id, i) => (
          <Badge key={id} className="font-bold text-[14px] border"
            style={{ backgroundColor: `${RUN_COLORS[i]}20`, color: RUN_COLORS[i], borderColor: RUN_COLORS[i] }}>
            {data.runs.find((r) => r.run_id === id)?.name || id.slice(0, 20)}
          </Badge>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg font-bold" style={{ color: G.textPrimary }}>Summary Comparison</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {["Run", "Cycles", "API Calls", "Total API Time", "Avg/Call", "Rate Limit Hits"].map((h) => (
                  <TableHead key={h} className="text-[16px] font-medium" style={{ color: G.textSecondary }}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {runIds.map((id, i) => {
                const s = summaryByRun[id];
                const run = data.runs.find((r) => r.run_id === id);
                return (
                  <TableRow key={id} style={{ borderBottom: `1px solid ${G.border}30` }}>
                    <TableCell className="text-[16px] font-bold" style={{ color: RUN_COLORS[i] }}>
                      {run?.name || id.slice(0, 20)}
                    </TableCell>
                    <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{s?.cycles || 0}</TableCell>
                    <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{s?.calls || 0}</TableCell>
                    <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{((s?.totalApi || 0) / 1000).toFixed(1)}s</TableCell>
                    <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>
                      {s && s.calls > 0 ? `${(s.totalApi / s.calls).toFixed(0)}ms` : "-"}
                    </TableCell>
                    <TableCell className="text-[16px] font-semibold" style={{ color: G.textPrimary }}>{s?.rlHits || 0}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg font-bold" style={{ color: G.textPrimary }}>Step Latency Comparison (avg ms)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={500}>
            <BarChart data={compareChart} layout="vertical" margin={{ left: 120 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
              <XAxis type="number" tick={chartTheme.text} />
              <YAxis dataKey="step" type="category" tick={{ ...chartTheme.text, fontWeight: 600 }} width={120} />
              <Tooltip contentStyle={chartTheme.tooltip} />
              <Legend wrapperStyle={{ color: G.textSecondary }} />
              {runIds.map((id, i) => (
                <Bar key={id} dataKey={id} fill={RUN_COLORS[i]}
                  name={data.runs.find((r) => r.run_id === id)?.name || id.slice(0, 15)}
                  radius={[0, 4, 4, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export default function DashboardPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [view, setView] = useState<"list" | "detail" | "compare">("list");
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [compareSet, setCompareSet] = useState<Set<string>>(new Set());

  const fetchRuns = useCallback(() => {
    fetch("/api/runs").then((r) => r.json()).then(setRuns);
  }, []);

  useEffect(() => {
    fetchRuns();
    const interval = setInterval(fetchRuns, 5000);
    return () => clearInterval(interval);
  }, [fetchRuns]);

  const handleSelect = (id: string) => { setSelectedRunId(id); setView("detail"); };
  const handleToggleCompare = (id: string) => {
    setCompareSet((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const handleCompare = () => { if (compareSet.size >= 2) setView("compare"); };
  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this run and all its data?")) return;
    await fetch(`/api/runs/${id}`, { method: "DELETE" });
    setCompareSet((prev) => { const next = new Set(prev); next.delete(id); return next; });
    fetchRuns();
  };
  const handleStop = async (id: string) => {
    await fetch(`/api/runs/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "stopped" }) });
    fetchRuns();
  };

  const [cloneConfig, setCloneConfig] = useState<LaunchConfig | undefined>();
  const [cloneOpen, setCloneOpen] = useState(false);
  const handleClone = (run: Run) => {
    setCloneConfig({
      runName: `${run.name || run.run_id}-clone`,
      totalCycles: run.total_cycles, sequentialCycles: run.sequential_cycles,
      maxConcurrency: run.max_concurrency, pctAmber: run.pct_amber,
      pctAmberOpt: 0, pctDependabot: run.pct_dependabot,
    });
    setCloneOpen(true);
  };

  return (
    <div className="flex flex-col min-h-screen" style={{ backgroundColor: G.bgCanvas }}>
      <header className="sticky top-0 z-20 px-4 sm:px-8 h-[64px] flex items-center justify-between"
        style={{ backgroundColor: G.bgPrimary, borderBottom: `1px solid ${G.border}` }}>
        <div className="flex items-center gap-4 cursor-pointer" onClick={() => setView("list")}>
          <div className="text-[26px] font-bold tracking-tight" style={{ color: G.textPrimary }}>
            GH<span style={{ color: G.blue }}>Bench</span>
          </div>
          <Separator orientation="vertical" className="h-6" />
          <span className="text-[16px] font-medium" style={{ color: G.textSecondary }}>GitHub API Benchmark</span>
        </div>
        <div className="flex gap-3 items-center">
          {compareSet.size >= 2 && view === "list" && (
            <Button onClick={handleCompare}
              className="text-[15px] font-bold h-10"
              style={{ backgroundColor: G.blue, color: G.bgCanvas }}>
              Compare ({compareSet.size})
            </Button>
          )}
          <LaunchDialog onLaunched={fetchRuns} />
          <LaunchDialog onLaunched={fetchRuns} externalOpen={cloneOpen}
            onExternalClose={() => setCloneOpen(false)} initialConfig={cloneConfig} />
        </div>
      </header>

      <main className="flex-1 p-4 sm:p-8 max-w-7xl mx-auto w-full">
        <RunningStatusPanel runs={runs} />
        {view === "list" && (
          <RunsList runs={runs} onSelect={handleSelect}
            selectedRuns={compareSet} onToggleCompare={handleToggleCompare}
            onDelete={handleDelete} onStop={handleStop} onClone={handleClone} />
        )}
        {view === "detail" && (
          <RunDetailView runId={selectedRunId} onBack={() => setView("list")} />
        )}
        {view === "compare" && (
          <CompareView runIds={Array.from(compareSet)} onBack={() => setView("list")} />
        )}
      </main>
    </div>
  );
}
