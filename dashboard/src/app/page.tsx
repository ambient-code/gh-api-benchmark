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
// COLORS
// ============================================================

const RUN_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c"];

// Step descriptions for tooltips
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

// Step ordering — matches actual workflow sequence
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
        <p className="text-[20px] font-bold text-gray-500 uppercase tracking-wide">{label}</p>
        <p className="text-4xl font-black text-gray-900 mt-1">{value}</p>
        {sub && <p className="text-[20px] font-medium text-gray-400 mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "bg-green-50 text-green-800 border-green-200",
    running: "bg-yellow-50 text-yellow-800 border-yellow-200",
    failed: "bg-red-50 text-red-800 border-red-200",
    stopped: "bg-gray-50 text-gray-800 border-gray-200",
  };
  return (
    <Badge className={`${styles[status] || styles.running} font-bold text-[16px]`}>
      {status}
    </Badge>
  );
}

function ProfileBadge({ profile }: { profile: string }) {
  const colors: Record<string, string> = {
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    amber_opt: "bg-orange-50 text-orange-800 border-orange-200",
    dependabot: "bg-blue-50 text-blue-800 border-blue-200",
    human: "bg-emerald-50 text-emerald-800 border-emerald-200",
    mergify: "bg-violet-50 text-violet-800 border-violet-200",
  };
  return (
    <Badge className={`${colors[profile] || "bg-gray-50 text-gray-800"} font-bold text-[16px]`}>
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
  // Last bucket includes max
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
    count: 0, // marked as sim
  }));
}

// ============================================================
// SEQUENCE DIAGRAM / WATERFALL
// ============================================================

function SequenceDiagram({ steps, profile }: { steps: { name: string; avg: number; count: number }[]; profile: string }) {
  const sorted = sortSteps(steps, profile);
  const maxMs = Math.max(...sorted.map((s) => s.avg), 1);
  const color = profile === "amber" ? "#f59e0b" : "#3b82f6";
  const bgColor = profile === "amber" ? "#fef3c7" : "#dbeafe";

  return (
    <div className="font-mono text-[18px]">
      {/* Header */}
      <div className="flex items-center gap-4 mb-3 px-2">
        <div className="w-[180px] text-right font-bold text-gray-500">Client</div>
        <div className="w-16 text-center text-gray-300">|</div>
        <div className="font-bold text-gray-500">GitHub API</div>
      </div>
      <div className="border-t border-gray-200" />

      {sorted.map((step, i) => {
        const isSim = step.name.startsWith("sim_");
        const barWidth = isSim ? 0 : Math.max(8, (step.avg / maxMs) * 200);

        return (
          <div key={step.name} className="flex items-center gap-4 px-2 py-[6px] hover:bg-gray-50 border-b border-gray-50">
            {/* Step name */}
            <div className={`w-[180px] text-right font-semibold truncate ${isSim ? "text-gray-300 italic" : "text-gray-700"}`}
              title={STEP_DESCRIPTIONS[step.name] || step.name}>
              {step.name}
            </div>

            {/* Arrow line */}
            <div className="w-16 flex items-center justify-center relative">
              <div className="absolute top-0 bottom-0 left-1/2 w-px bg-gray-200" style={{ transform: "translateX(-50%)" }} />
              {!isSim && (
                <svg width="40" height="12" className="relative z-10">
                  <line x1="0" y1="6" x2="34" y2="6" stroke={color} strokeWidth="2" />
                  <polygon points="34,2 40,6 34,10" fill={color} />
                </svg>
              )}
              {isSim && (
                <span className="relative z-10 text-gray-300 text-[11px]">---</span>
              )}
            </div>

            {/* Latency bar + value */}
            <div className="flex items-center gap-2 flex-1">
              {!isSim ? (
                <>
                  <div
                    className="h-5 rounded-r-sm"
                    style={{ width: barWidth, backgroundColor: bgColor, border: `1px solid ${color}` }}
                  />
                  <span className="font-bold text-gray-700">{step.avg}ms</span>
                  {step.count > 1 && (
                    <span className="text-gray-400 text-[11px]">x{step.count}</span>
                  )}
                </>
              ) : (
                <span className="text-gray-300 italic text-[11px]">simulated ({step.avg}ms)</span>
              )}
            </div>
          </div>
        );
      })}
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
  const [config, setConfig] = useState<LaunchConfig>(initialConfig || DEFAULT_CONFIG);

  // Update config when initialConfig changes (clone)
  useEffect(() => {
    if (initialConfig) setConfig(initialConfig);
  }, [initialConfig]);

  const launch = async () => {
    setLaunching(true);
    try {
      await fetch("/api/benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      setOpen(false);
      onLaunched();
    } finally {
      setLaunching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!onExternalClose && (
        <DialogTrigger className="text-lg font-bold bg-green-600 hover:bg-green-700 text-white h-12 rounded-md px-4 cursor-pointer">
          Launch Benchmark
        </DialogTrigger>
      )}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl font-black">Launch Benchmark Run</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5 py-4">
          {/* Preset buttons */}
          <p className="text-[14px] font-bold text-gray-500 uppercase tracking-wide">Preset</p>
          <div className="grid grid-cols-2 gap-3">
            {[
              { name: "Amber Baseline", sub: "20 cycles, standard workflow", cfg: { runName: "baseline", totalCycles: 20, sequentialCycles: 10, maxConcurrency: 3, pctAmber: 60, pctAmberOpt: 0, pctDependabot: 40 } },
              { name: "Amber Optimized", sub: "20 cycles, 3 optimizations", cfg: { runName: "optimized", totalCycles: 20, sequentialCycles: 10, maxConcurrency: 3, pctAmber: 0, pctAmberOpt: 60, pctDependabot: 40 } },
              { name: "A/B Test", sub: "20 cycles, both profiles", cfg: { runName: "a-b-test", totalCycles: 20, sequentialCycles: 10, maxConcurrency: 3, pctAmber: 30, pctAmberOpt: 30, pctDependabot: 40 } },
              { name: "Stress Test", sub: "100 cycles, concurrency 5", cfg: { runName: "stress-test", totalCycles: 100, sequentialCycles: 10, maxConcurrency: 5, pctAmber: 60, pctAmberOpt: 0, pctDependabot: 40 } },
            ].map((preset) => (
              <button key={preset.name}
                className="border-2 border-gray-200 rounded-lg p-3 text-left hover:bg-gray-50 cursor-pointer"
                onClick={() => setConfig(preset.cfg)}>
                <div className="text-[15px] font-bold text-gray-900">{preset.name}</div>
                <div className="text-[12px] font-medium text-gray-400 mt-0.5">{preset.sub}</div>
              </button>
            ))}
          </div>

          <Separator />

          {/* Editable fields */}
          <div className="flex flex-col gap-2">
            <Label className="text-[14px] font-bold text-gray-700">Run Name</Label>
            <Input
              placeholder="e.g. baseline-v2"
              className="text-[16px] font-semibold border-2 h-10"
              value={config.runName}
              onChange={(e) => setConfig({ ...config, runName: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-[13px] font-bold text-gray-500">Cycles</Label>
              <Input type="number" className="text-[15px] font-semibold border-2 h-10"
                value={config.totalCycles}
                onChange={(e) => setConfig({ ...config, totalCycles: +e.target.value })} />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[13px] font-bold text-gray-500">Sequential</Label>
              <Input type="number" className="text-[15px] font-semibold border-2 h-10"
                value={config.sequentialCycles}
                onChange={(e) => setConfig({ ...config, sequentialCycles: +e.target.value })} />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[13px] font-bold text-gray-500">Max Concurrency</Label>
              <Input type="number" className="text-[15px] font-semibold border-2 h-10"
                value={config.maxConcurrency}
                onChange={(e) => setConfig({ ...config, maxConcurrency: +e.target.value })} />
            </div>
          </div>

          <Button onClick={launch} disabled={launching}
            className="text-lg font-bold bg-green-600 hover:bg-green-700 text-white h-12 w-full">
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
          <p className="text-xl font-bold text-gray-400">No runs yet. Launch a benchmark to get started.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-4 border-b border-gray-100">
        <CardTitle className="text-xl font-black text-gray-900">Benchmark Runs</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[14px] font-bold text-gray-600 w-8"></TableHead>
              <TableHead className="text-[14px] font-bold text-gray-600">Name</TableHead>
              <TableHead className="text-[14px] font-bold text-gray-600">Status</TableHead>
              <TableHead className="text-[14px] font-bold text-gray-600 text-right">Cycles</TableHead>
              <TableHead className="text-[14px] font-bold text-gray-600 text-right">Calls</TableHead>
              <TableHead className="text-[14px] font-bold text-gray-600 text-right">API Time</TableHead>
              <TableHead className="text-[14px] font-bold text-gray-600">Mix</TableHead>
              <TableHead className="text-[14px] font-bold text-gray-600">Started</TableHead>
              <TableHead className="text-[14px] font-bold text-gray-600">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.run_id} className="cursor-pointer hover:bg-gray-50"
                onClick={() => onSelect(run.run_id)}>
                <TableCell className="pr-0" onClick={(e) => { e.stopPropagation(); onToggleCompare(run.run_id); }}>
                  <input type="checkbox" checked={selectedRuns.has(run.run_id)}
                    onChange={() => onToggleCompare(run.run_id)}
                    className="w-4 h-4 accent-blue-600" />
                </TableCell>
                <TableCell className="text-[15px] font-semibold text-gray-900 max-w-[200px] truncate">
                  {run.name || run.run_id}
                </TableCell>
                <TableCell><StatusBadge status={run.status} /></TableCell>
                <TableCell className="text-[15px] font-semibold text-right">{run.cycle_count}/{run.total_cycles}</TableCell>
                <TableCell className="text-[15px] font-semibold text-right">{run.total_api_calls}</TableCell>
                <TableCell className="text-[15px] font-semibold text-right">{(run.total_api_ms / 1000).toFixed(1)}s</TableCell>
                <TableCell>
                  <div className="flex gap-1 flex-wrap">
                    {run.pct_amber > 0 && (
                      <Badge className="bg-amber-50 text-amber-800 border-amber-200 font-bold text-[12px] px-1.5 py-0">
                        {run.pct_amber}% A
                      </Badge>
                    )}
                    {run.pct_dependabot > 0 && (
                      <Badge className="bg-blue-50 text-blue-800 border-blue-200 font-bold text-[12px] px-1.5 py-0">
                        {run.pct_dependabot}% D
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-[13px] font-medium text-gray-500 whitespace-nowrap">
                  {new Date(run.started_at).toLocaleDateString()}{" "}
                  {new Date(run.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <div className="flex gap-1.5">
                    <Button variant="outline" size="sm"
                      className={`text-[12px] font-bold h-7 px-2 ${
                        run.status === "running"
                          ? "text-yellow-700 border-yellow-300 hover:bg-yellow-50"
                          : "text-gray-300 border-gray-200 cursor-default"
                      }`}
                      disabled={run.status !== "running"}
                      onClick={() => onStop(run.run_id)}>
                      Stop
                    </Button>
                    <Button variant="outline" size="sm"
                      className="text-[12px] font-bold h-7 px-2 text-blue-600 border-blue-200 hover:bg-blue-50"
                      onClick={() => onClone(run)}>
                      Clone
                    </Button>
                    <Button variant="outline" size="sm"
                      className="text-[12px] font-bold h-7 px-2 text-red-600 border-red-200 hover:bg-red-50"
                      onClick={() => onDelete(run.run_id)}>
                      Delete
                    </Button>
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
    // Live refresh while running
    const interval = setInterval(() => {
      fetchData();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (!data) return <p className="text-xl font-medium text-gray-400 p-8">Loading...</p>;

  const { run, cycles, steps, stepLatencies, rateLimits, errors, liveStats } = data;

  // Include sim steps from step_results for the sequence diagram
  const allStepChartData = steps.map((s) => ({
    name: s.step,
    profile: s.profile,
    avg: Math.round(s.avg_ms),
    min: Math.round(s.min_ms),
    max: Math.round(s.max_ms),
    count: s.count,
  }));

  // Detect which profiles are present
  const profiles = [...new Set(allStepChartData.map((s) => s.profile))];

  // For bar chart — API steps only, sorted by sequence
  const stepsByProfile: Record<string, typeof allStepChartData> = {};
  const allStepsByProfile: Record<string, typeof allStepChartData> = {};
  const percentilesByProfile: Record<string, ReturnType<typeof computePercentiles>> = {};
  const histogramByProfile: Record<string, ReturnType<typeof buildHistogram>> = {};

  for (const p of profiles) {
    const pSteps = sortSteps(allStepChartData.filter((s) => s.profile === p), p);
    stepsByProfile[p] = pSteps;
    allStepsByProfile[p] = sortSteps(
      [...pSteps, ...getSimSteps(stepLatencies, p)], p
    );
    percentilesByProfile[p] = computePercentiles(stepLatencies as StepLatencyExt[], p);
    histogramByProfile[p] = buildHistogram(stepLatencies as StepLatencyExt[], p);
  }

  const hasEnoughData = (stepLatencies?.length || 0) > 20;

  const rlTimeline = rateLimits.map((r, i) => ({
    idx: i,
    remaining: r.rate_limit_remaining,
    used: r.rate_limit_used,
    step: r.step,
  }));

  const concurrencyData = stepLatencies.reduce<Record<number, { sum: number; count: number }>>((acc, s) => {
    if (!acc[s.concurrency_level]) acc[s.concurrency_level] = { sum: 0, count: 0 };
    acc[s.concurrency_level].sum += s.latency_ms;
    acc[s.concurrency_level].count += 1;
    return acc;
  }, {});
  const concurrencyChart = Object.entries(concurrencyData).map(([c, d]) => ({
    concurrency: +c,
    avg_ms: Math.round(d.sum / d.count),
  }));

  const cycleChart = cycles.map((c) => ({
    id: c.cycle_id.slice(0, 20),
    profile: c.profile,
    api_ms: Math.round(c.total_api_ms),
    poll_ms: Math.round(c.total_poll_ms),
    wall_ms: Math.round(c.total_wall_ms),
    calls: c.api_call_count,
  }));

  // Use liveStats (from step_results) which works even mid-run
  const totalApiMs = liveStats?.total_api_ms || cycles.reduce((s, c) => s + c.total_api_ms, 0);
  const totalPollMs = liveStats?.total_poll_ms || cycles.reduce((s, c) => s + c.total_poll_ms, 0);
  const totalCalls = liveStats?.total_api_calls || cycles.reduce((s, c) => s + c.api_call_count, 0);
  const totalRlHits = liveStats?.total_rl_hits || cycles.reduce((s, c) => s + c.rate_limit_hits, 0);
  const avgPerCall = totalCalls > 0 ? totalApiMs / totalCalls : 0;
  const pollPct = totalApiMs > 0 ? (totalPollMs / totalApiMs * 100) : 0;

  // Per-profile workflow p50/p90/p99 (end-to-end cycle time)
  const cycleProfiles = [...new Set(cycles.map((c) => c.profile))];
  const cyclePercentiles: Record<string, { sorted: number[]; p50: number; p90: number; p99: number }> = {};
  for (const p of cycleProfiles) {
    const sorted = cycles.filter((c) => c.profile === p).map((c) => c.total_api_ms).sort((a, b) => a - b);
    cyclePercentiles[p] = { sorted, p50: percentile(sorted, 50), p90: percentile(sorted, 90), p99: percentile(sorted, 99) };
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" onClick={onBack} className="font-bold text-[20px] h-10">
          Back
        </Button>
        <h2 className="text-2xl font-black text-gray-900">{run.name || run.run_id}</h2>
        <StatusBadge status={run.status} />
        {run.status === "running" && (
          <>
            <span className="text-[16px] font-medium text-gray-400 animate-pulse">
              Live — refreshing every 3s
            </span>
            <Button variant="outline" className="text-[16px] font-bold h-8 text-red-600 border-red-200 hover:bg-red-50"
              onClick={async () => {
                await fetch(`/api/runs/${runId}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ status: "stopped" }) });
                fetchData();
              }}>
              Stop
            </Button>
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

      {/* Workflow-level percentiles */}
      {cycleProfiles.some((p) => cyclePercentiles[p].sorted.length > 1) && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {cycleProfiles.map((p) => {
            const cp = cyclePercentiles[p];
            if (cp.sorted.length <= 1) return null;
            return [
              <StatCard key={`${p}-p50`} label={`${p} p50`} value={`${(cp.p50 / 1000).toFixed(1)}s`}
                sub={`${cp.sorted.length} cycles`} />,
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
          {/* Sequence diagrams */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {profiles.map((p) => (allStepsByProfile[p]?.length > 0) && (
              <Card key={`seq-${p}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg font-black flex items-center gap-2">
                    <ProfileBadge profile={p} /> Workflow Sequence
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-2">
                  <SequenceDiagram steps={allStepsByProfile[p]} profile={p} />
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Bar charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {profiles.map((p) => (stepsByProfile[p]?.length > 0) && (
              <Card key={`bar-${p}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg font-black flex items-center gap-2">
                    <ProfileBadge profile={p} /> Step Latency (avg ms)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={Math.max(300, stepsByProfile[p].length * 32)}>
                    <BarChart data={stepsByProfile[p]} layout="vertical" margin={{ left: 140 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" />
                      <YAxis dataKey="name" type="category" tick={{ fontSize: 12, fontWeight: 600 }} width={140} />
                      <Tooltip />
                      <Bar dataKey="avg" fill={p.startsWith("amber") ? "#f59e0b" : "#3b82f6"} name="Avg (ms)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Percentile charts */}
          {hasEnoughData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
              {profiles.map((p) => (percentilesByProfile[p]?.length > 0) && (
                <Card key={`pct-${p}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg font-black flex items-center gap-2">
                      <ProfileBadge profile={p} /> Percentiles (p50 / p90 / p99)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={Math.max(300, percentilesByProfile[p].length * 36)}>
                      <BarChart data={percentilesByProfile[p]} layout="vertical" margin={{ left: 140 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis type="number" />
                        <YAxis dataKey="step" type="category" tick={{ fontSize: 12, fontWeight: 600 }} width={140} />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="p50" fill={p.startsWith("amber") ? "#fbbf24" : "#93c5fd"} name="p50" radius={[0, 2, 2, 0]} />
                        <Bar dataKey="p90" fill={p.startsWith("amber") ? "#f59e0b" : "#3b82f6"} name="p90" radius={[0, 2, 2, 0]} />
                        <Bar dataKey="p99" fill={p.startsWith("amber") ? "#d97706" : "#1d4ed8"} name="p99" radius={[0, 2, 2, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Latency distribution histograms */}
          {hasEnoughData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
              {profiles.map((p) => (histogramByProfile[p]?.length > 0) && (
                <Card key={`hist-${p}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg font-black flex items-center gap-2">
                      <ProfileBadge profile={p} /> Latency Distribution
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={histogramByProfile[p]}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="range" tick={{ fontSize: 11 }}
                          label={{ value: "Latency (ms)", position: "bottom", offset: 0 }} />
                        <YAxis label={{ value: "Count", angle: -90, position: "insideLeft" }} />
                        <Tooltip labelFormatter={(v) => `${v}ms`} />
                        <Bar dataKey="count" fill={p.startsWith("amber") ? "#f59e0b" : "#3b82f6"} name="Calls" radius={[4, 4, 0, 0]} />
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
              <CardTitle className="text-lg font-black">Per-Cycle Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={350}>
                <BarChart data={cycleChart}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="id" tick={{ fontSize: 10 }} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="api_ms" stackId="a" fill="#2563eb" name="API (ms)" />
                  <Bar dataKey="poll_ms" stackId="a" fill="#dc2626" name="Poll (ms)" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card className="mt-4">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[18px] font-bold text-gray-600">Cycle</TableHead>
                    <TableHead className="text-[18px] font-bold text-gray-600">Profile</TableHead>
                    <TableHead className="text-[18px] font-bold text-gray-600">Phase</TableHead>
                    <TableHead className="text-[18px] font-bold text-gray-600">Concurrency</TableHead>
                    <TableHead className="text-[18px] font-bold text-gray-600">API Time</TableHead>
                    <TableHead className="text-[18px] font-bold text-gray-600">Poll Time</TableHead>
                    <TableHead className="text-[18px] font-bold text-gray-600">Wall Time</TableHead>
                    <TableHead className="text-[18px] font-bold text-gray-600">Calls</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cycles.map((c) => (
                    <TableRow key={c.cycle_id}>
                      <TableCell className="text-[16px] font-mono font-semibold">{c.cycle_id.slice(0, 30)}</TableCell>
                      <TableCell><ProfileBadge profile={c.profile} /></TableCell>
                      <TableCell className="text-[18px] font-semibold">{c.phase}</TableCell>
                      <TableCell className="text-[18px] font-semibold">{c.concurrency_level}</TableCell>
                      <TableCell className="text-[18px] font-semibold">{(c.total_api_ms / 1000).toFixed(1)}s</TableCell>
                      <TableCell className="text-[18px] font-semibold">{(c.total_poll_ms / 1000).toFixed(1)}s</TableCell>
                      <TableCell className="text-[18px] font-semibold">{(c.total_wall_ms / 1000).toFixed(1)}s</TableCell>
                      <TableCell className="text-[18px] font-semibold">{c.api_call_count}</TableCell>
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
              <CardTitle className="text-lg font-black">Rate Limit Remaining Over Time</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={350}>
                <LineChart data={rlTimeline}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="idx" label={{ value: "API Call #", position: "bottom" }} />
                  <YAxis />
                  <Tooltip labelFormatter={(v) => `Call #${v}`} />
                  <Line type="monotone" dataKey="remaining" stroke="#16a34a" strokeWidth={2} dot={false} name="remaining" />
                  <Line type="monotone" dataKey="used" stroke="#dc2626" strokeWidth={2} dot={false} name="used" />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="concurrency">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-black">Avg Latency vs Concurrency Level</CardTitle>
            </CardHeader>
            <CardContent>
              {concurrencyChart.length > 1 ? (
                <ResponsiveContainer width="100%" height={350}>
                  <ScatterChart>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="concurrency" name="Concurrency" type="number" />
                    <YAxis dataKey="avg_ms" name="Avg Latency (ms)" />
                    <Tooltip cursor={{ strokeDasharray: "3 3" }} />
                    <Scatter data={concurrencyChart} fill="#2563eb" />
                  </ScatterChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-[20px] font-medium text-gray-400 py-12 text-center">
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
                <p className="text-[20px] font-bold text-green-600 p-8 text-center">No errors.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[18px] font-bold text-gray-600">Step</TableHead>
                      <TableHead className="text-[18px] font-bold text-gray-600">Profile</TableHead>
                      <TableHead className="text-[18px] font-bold text-gray-600">Status</TableHead>
                      <TableHead className="text-[18px] font-bold text-gray-600">Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.map((e, i) => (
                      <TableRow key={`${e.cycle_id}-${e.step}-${i}`}>
                        <TableCell className="text-[18px] font-semibold">{e.step}</TableCell>
                        <TableCell><ProfileBadge profile={e.profile} /></TableCell>
                        <TableCell>
                          <Badge className="bg-red-50 text-red-800 font-bold">{e.http_status}</Badge>
                        </TableCell>
                        <TableCell className="text-[16px] font-mono text-gray-600 max-w-md truncate">
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

  if (!data) return <p className="text-xl font-medium text-gray-400 p-8">Loading...</p>;

  const stepsByRun: Record<string, Record<string, number>> = {};
  for (const s of data.stepStats) {
    if (!stepsByRun[s.step]) stepsByRun[s.step] = {};
    stepsByRun[s.step][s.run_id] = Math.round(s.avg_ms);
  }

  const compareChart = Object.entries(stepsByRun).map(([step, runs]) => ({
    step,
    ...runs,
  }));

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
        <Button variant="outline" onClick={onBack} className="font-bold text-[20px] h-10">
          Back
        </Button>
        <h2 className="text-2xl font-black text-gray-900">Compare Runs</h2>
        {runIds.map((id, i) => (
          <Badge key={id} style={{ backgroundColor: `${RUN_COLORS[i]}20`, color: RUN_COLORS[i], borderColor: RUN_COLORS[i] }}
            className="font-bold text-[16px] border">
            {data.runs.find((r) => r.run_id === id)?.name || id.slice(0, 20)}
          </Badge>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg font-black">Summary Comparison</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-[18px] font-bold text-gray-600">Run</TableHead>
                <TableHead className="text-[18px] font-bold text-gray-600">Cycles</TableHead>
                <TableHead className="text-[18px] font-bold text-gray-600">API Calls</TableHead>
                <TableHead className="text-[18px] font-bold text-gray-600">Total API Time</TableHead>
                <TableHead className="text-[18px] font-bold text-gray-600">Avg/Call</TableHead>
                <TableHead className="text-[18px] font-bold text-gray-600">Rate Limit Hits</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runIds.map((id, i) => {
                const s = summaryByRun[id];
                const run = data.runs.find((r) => r.run_id === id);
                return (
                  <TableRow key={id}>
                    <TableCell className="text-[18px] font-bold" style={{ color: RUN_COLORS[i] }}>
                      {run?.name || id.slice(0, 20)}
                    </TableCell>
                    <TableCell className="text-[18px] font-semibold">{s?.cycles || 0}</TableCell>
                    <TableCell className="text-[18px] font-semibold">{s?.calls || 0}</TableCell>
                    <TableCell className="text-[18px] font-semibold">{((s?.totalApi || 0) / 1000).toFixed(1)}s</TableCell>
                    <TableCell className="text-[18px] font-semibold">
                      {s && s.calls > 0 ? `${(s.totalApi / s.calls).toFixed(0)}ms` : "-"}
                    </TableCell>
                    <TableCell className="text-[18px] font-semibold">{s?.rlHits || 0}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg font-black">Step Latency Comparison (avg ms)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={500}>
            <BarChart data={compareChart} layout="vertical" margin={{ left: 120 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" />
              <YAxis dataKey="step" type="category" tick={{ fontSize: 11, fontWeight: 600 }} width={120} />
              <Tooltip />
              <Legend />
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

  const handleSelect = (id: string) => {
    setSelectedRunId(id);
    setView("detail");
  };

  const handleToggleCompare = (id: string) => {
    setCompareSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCompare = () => {
    if (compareSet.size >= 2) setView("compare");
  };

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
      totalCycles: run.total_cycles,
      sequentialCycles: run.sequential_cycles,
      maxConcurrency: run.max_concurrency,
      pctAmber: run.pct_amber,
      pctAmberOpt: 0,
      pctDependabot: run.pct_dependabot,
    });
    setCloneOpen(true);
  };

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 bg-white border-b-2 border-gray-200 px-4 sm:px-8 h-[72px] flex items-center justify-between">
        <div className="flex items-center gap-4 cursor-pointer" onClick={() => setView("list")}>
          <div className="text-[30px] font-black text-gray-900 tracking-tight">
            GH<span className="text-blue-600">Bench</span>
          </div>
          <Separator orientation="vertical" className="h-7" />
          <span className="text-[20px] font-bold text-gray-500">GitHub API Benchmark</span>
        </div>
        <div className="flex gap-3 items-center">
          {compareSet.size >= 2 && view === "list" && (
            <Button onClick={handleCompare}
              className="text-[20px] font-bold bg-blue-600 hover:bg-blue-700 text-white h-10">
              Compare ({compareSet.size})
            </Button>
          )}
          <LaunchDialog onLaunched={fetchRuns} />
          <LaunchDialog onLaunched={fetchRuns} externalOpen={cloneOpen}
            onExternalClose={() => setCloneOpen(false)} initialConfig={cloneConfig} />
        </div>
      </header>

      <main className="flex-1 p-4 sm:p-8 max-w-7xl mx-auto w-full">
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
