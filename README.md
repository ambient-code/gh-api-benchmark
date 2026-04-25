# GitHub-as-State-Machine Benchmark

Measures the latency cost of using GitHub's REST API as a state coordination
mechanism in the [Amber issue-handler workflow](https://ambient-code.ai).

## Thesis

Using GitHub (issues, PRs, labels, checks) as the state machine for agentic
workflows introduces measurable overhead. This benchmark quantifies:

1. **Per-step API latency** — how long each GitHub REST call takes
2. **Polling tax** — time wasted waiting for GitHub to compute state (e.g. PR
   mergeable)
3. **Rate limit pressure** — how fast you burn through 5,000 req/hr under
   concurrent agents
4. **Concurrency degradation** — how latency changes as parallel agents increase
5. **Event propagation delay** — the gap between "state changed" and "state
   visible via API"

The goal is to prove that **timer-based polling should be replaced with
event-driven webhooks** and that GitHub's API is a bottleneck worth measuring.

## Workflow Mapping

```
Mermaid Step              → GitHub API Call                    → Type
─────────────────────────────────────────────────────────────────────
A: Issue + label          → POST /issues + POST /labels       → WRITE
B: Workflow dispatch      → POST /dispatches                  → WRITE
C: ambient-action         → (simulated delay)                 → COMPUTE
D: ACP session            → (simulated delay)                 → COMPUTE
E: Amber2 workflow        → (simulated delay)                 → COMPUTE
F: Load context           → GET /repos + GET /issues          → READ
G: Spec Kit               → (simulated delay)                 → COMPUTE
H: Reproduce              → (simulated delay)                 → COMPUTE
I: Implement fix          → (simulated delay)                 → COMPUTE
J: Lint/test/coverage     → POST + PATCH /check-runs          → WRITE
K: Emit report            → POST /issues/comments             → WRITE
L: Push branch            → POST /git/refs + PUT /contents    → WRITE
M: Create PR              → POST /pulls                       → WRITE
M: Poll mergeable         → GET /pulls (repeated)             → POLL ← event gap
N: Review                 → POST /pulls/reviews               → WRITE
O: Merge                  → PUT /pulls/merge                  → WRITE
P: Post-merge learning    → POST /issues/comments             → WRITE
Q: Close issue            → PATCH /issues                     → WRITE
Z: Cleanup                → DELETE /git/refs                  → WRITE
```

Each WRITE call costs 5 points against the secondary rate limit (900 pts/min).
A single cycle makes ~14 write calls = 70 points. At 900 pts/min, you hit the
secondary rate limit at ~12 concurrent cycles/minute.

## Quick Start

```bash
# Install
uv sync

# Set up test repo (creates repo, labels, workflow)
GITHUB_TOKEN=ghp_xxx GITHUB_ORG=your-test-org \
  uv run python setup_repo.py

# Run benchmark (sequential then parallel ramp)
GITHUB_TOKEN=ghp_xxx GITHUB_ORG=your-test-org GITHUB_REPO=gh-api-benchmark \
  uv run python benchmark.py

# Analyze results
uv run python analyze.py benchmark_results.db ./reports/
```

## Configuration

Environment variables:

| Variable            | Default              | Description                    |
|---------------------|----------------------|--------------------------------|
| `GITHUB_TOKEN`      | (required)           | PAT with repo+workflow+checks  |
| `GITHUB_ORG`        | (required)           | Test org or username           |
| `GITHUB_REPO`       | `gh-api-benchmark`   | Test repo name                 |
| `SEQUENTIAL_CYCLES` | `5`                  | Baseline cycles (no concurrency) |
| `PARALLEL_CYCLES`   | `20`                 | Total parallel cycles          |
| `MAX_CONCURRENCY`   | `5`                  | Max simultaneous cycles        |

## Required PAT Scopes

- `repo` — full control of private repos
- `workflow` — update GitHub Action workflows
- `write:checks` — create and update check runs

## Output

SQLite database (`benchmark_results.db`) with three tables:

- **`step_results`** — every individual API call or simulated step
- **`cycle_summary`** — per-cycle aggregates (wall time, API time, sim time)
- **`rate_limit_snapshots`** — periodic rate limit state

Analysis script produces:
- `benchmark_report.txt` — human-readable summary
- `step_latency_stats.csv` — per-step p50/p90/p99
- `rate_limit_timeline.csv` — rate limit consumption over time
- `all_step_results.csv` — raw data for external tools

## Key Metrics to Watch

1. **Poll Tax %** — what fraction of cycle time is spent polling for state
2. **GitHub Tax %** — what fraction of non-compute time is API calls
3. **P99 latency per step** — tail latency tells the real story
4. **Rate limit burn rate** — projected req/hr extrapolated from the run
5. **Concurrency knee** — at what parallelism level does latency spike

## Dashboard

A Next.js app for launching runs, monitoring progress, and comparing results.

```bash
cd dashboard
npm install

# Required: pass the same GitHub credentials
GITHUB_TOKEN=ghp_xxx GITHUB_ORG=your-test-org GITHUB_REPO=gh-api-benchmark \
  npx next dev -p 3001
```

See `dashboard/.env.example` for required variables. The dashboard reads from
the same `benchmark_results.db` in the project root.

Features:
- **Launch** benchmark runs with preset or custom configurations
- **Live monitoring** — polls every 3s while a run is active
- **Run detail** — per-step latency charts, percentile distributions, rate limit timeline
- **Compare** — side-by-side metrics across multiple runs

## Architecture

```
benchmark.py          — orchestrator + instrumented GitHub client
├── Phase 1           — sequential baseline (N cycles, 1 at a time)
├── Phase 2           — parallel ramp (1→MAX_CONCURRENCY workers)
└── SQLite writer     — WAL mode, commit-per-cycle for crash safety

analyze.py            — reads SQLite, produces stats + CSVs
setup_repo.py         — one-time test repo initialization

dashboard/            — Next.js app for visualization and run management
├── src/app/api/      — API routes (runs CRUD, benchmark launcher, compare)
└── src/app/page.tsx  — single-page app with runs list, detail, and compare views
```
