#!/usr/bin/env python3
"""
GitHub-as-State-Machine Benchmark
==================================

Replays realistic GitHub API traffic based on empirical patterns from the
ambient-code/platform repository. Four traffic profiles are mixed according
to configurable percentages:

  - Amber Agent (31%)  — full issue-to-PR-to-merge automation cycle
  - Human Feature (30%) — branch, multi-commit, PR, bot + human review, merge
  - Dependabot (20%)   — create tiny PR, auto-merge immediately
  - Mergify Queue (10%) — create draft PR, close without merge

Simulated compute steps are logged for sequence completeness but take zero
wall-clock time and are excluded from all latency/rate-limit summaries.

Each API call records:
  - wall-clock latency (ms)
  - HTTP status code
  - rate limit headers (remaining, reset, used)
  - secondary rate limit hits
  - request/response size
  - retry count

Data stored in SQLite for offline analysis.
"""

import asyncio
import base64
import hashlib
import json
import os
import random
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class BenchmarkConfig:
    """All tunables in one place."""

    github_token: str = ""
    github_org: str = ""
    github_repo: str = ""
    base_branch: str = "main"

    # Cycle counts
    total_cycles: int = 10
    sequential_cycles: int = 5
    max_concurrency: int = 5
    ramp_step: int = 1

    # Traffic mix (must sum to 100)
    pct_amber: int = 60
    pct_amber_opt: int = 0
    pct_human: int = 0
    pct_dependabot: int = 40
    pct_mergify: int = 0

    # Simulated compute delays (seconds) — logged but not waited
    compute_delays: dict = field(default_factory=lambda: {
        "ambient_action": 2.0,
        "create_acp_session": 1.5,
        "amber2_workflow": 3.0,
        "spec_kit_flow": 5.0,
        "reproduce_test": 8.0,
        "implement_fix": 12.0,
    })

    # Polling config
    poll_interval_seconds: float = 1.0
    poll_max_attempts: int = 30

    # Database
    db_path: str = "benchmark_results.db"

    # Run metadata
    run_id: str = ""
    run_name: str = ""

    # API
    api_base: str = "https://api.github.com"
    api_version: str = "2022-11-28"

    @classmethod
    def from_env(cls) -> "BenchmarkConfig":
        token = os.environ.get("GITHUB_TOKEN", "")
        org = os.environ.get("GITHUB_ORG", "")
        repo = os.environ.get("GITHUB_REPO", "")

        if not all([token, org, repo]):
            print("ERROR: Set GITHUB_TOKEN, GITHUB_ORG, GITHUB_REPO env vars")
            sys.exit(1)

        run_id = os.environ.get("RUN_ID", "")
        if not run_id:
            run_id = f"run_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{hashlib.md5(str(time.time()).encode()).hexdigest()[:6]}"

        return cls(
            github_token=token,
            github_org=org,
            github_repo=repo,
            total_cycles=int(os.environ.get("TOTAL_CYCLES", "10")),
            sequential_cycles=int(os.environ.get("SEQUENTIAL_CYCLES", "5")),
            max_concurrency=int(os.environ.get("MAX_CONCURRENCY", "5")),
            pct_amber=int(os.environ.get("PCT_AMBER", "60")),
            pct_amber_opt=int(os.environ.get("PCT_AMBER_OPT", "0")),
            pct_human=int(os.environ.get("PCT_HUMAN", "0")),
            pct_dependabot=int(os.environ.get("PCT_DEPENDABOT", "40")),
            pct_mergify=int(os.environ.get("PCT_MERGIFY", "0")),
            run_id=run_id,
            run_name=os.environ.get("RUN_NAME", ""),
        )


# ---------------------------------------------------------------------------
# Data Layer
# ---------------------------------------------------------------------------

@dataclass
class StepResult:
    """One measured API call or simulated step."""

    run_id: str
    cycle_id: str
    profile: str
    step: str
    phase: str  # "sequential" or "parallel"
    concurrency_level: int
    start_ts: float
    end_ts: float
    latency_ms: float
    http_status: int | None
    http_method: str
    endpoint: str
    rate_limit_remaining: int | None
    rate_limit_limit: int | None
    rate_limit_used: int | None
    rate_limit_reset: int | None
    secondary_rate_limit_hit: bool
    retry_count: int
    request_size_bytes: int
    response_size_bytes: int
    error: str | None


def init_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running',
            total_cycles INTEGER NOT NULL,
            sequential_cycles INTEGER NOT NULL,
            max_concurrency INTEGER NOT NULL,
            pct_amber INTEGER NOT NULL,
            pct_human INTEGER NOT NULL,
            pct_dependabot INTEGER NOT NULL,
            pct_mergify INTEGER NOT NULL,
            github_org TEXT NOT NULL,
            github_repo TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            error TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS step_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL DEFAULT '',
            cycle_id TEXT NOT NULL,
            profile TEXT NOT NULL DEFAULT '',
            step TEXT NOT NULL,
            phase TEXT NOT NULL,
            concurrency_level INTEGER NOT NULL,
            start_ts REAL NOT NULL,
            end_ts REAL NOT NULL,
            latency_ms REAL NOT NULL,
            http_status INTEGER,
            http_method TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            rate_limit_remaining INTEGER,
            rate_limit_limit INTEGER,
            rate_limit_used INTEGER,
            rate_limit_reset INTEGER,
            secondary_rate_limit_hit INTEGER NOT NULL DEFAULT 0,
            retry_count INTEGER NOT NULL DEFAULT 0,
            request_size_bytes INTEGER NOT NULL DEFAULT 0,
            response_size_bytes INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            inserted_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cycle_summary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL DEFAULT '',
            cycle_id TEXT NOT NULL UNIQUE,
            profile TEXT NOT NULL DEFAULT '',
            phase TEXT NOT NULL,
            concurrency_level INTEGER NOT NULL,
            total_wall_ms REAL NOT NULL,
            total_api_ms REAL NOT NULL,
            total_poll_ms REAL NOT NULL,
            api_call_count INTEGER NOT NULL,
            rate_limit_hits INTEGER NOT NULL DEFAULT 0,
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            core_remaining INTEGER,
            core_limit INTEGER,
            core_reset INTEGER,
            cycle_id TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_step_results_cycle ON step_results(cycle_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_step_results_step ON step_results(step)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_step_results_profile ON step_results(profile)")
    conn.commit()
    return conn


def save_result(conn: sqlite3.Connection, r: StepResult):
    conn.execute(
        """INSERT INTO step_results
           (run_id, cycle_id, profile, step, phase, concurrency_level, start_ts, end_ts,
            latency_ms, http_status, http_method, endpoint,
            rate_limit_remaining, rate_limit_limit, rate_limit_used,
            rate_limit_reset, secondary_rate_limit_hit, retry_count,
            request_size_bytes, response_size_bytes, error)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            r.run_id, r.cycle_id, r.profile, r.step, r.phase, r.concurrency_level,
            r.start_ts, r.end_ts, r.latency_ms, r.http_status,
            r.http_method, r.endpoint,
            r.rate_limit_remaining, r.rate_limit_limit,
            r.rate_limit_used, r.rate_limit_reset,
            int(r.secondary_rate_limit_hit), r.retry_count,
            r.request_size_bytes, r.response_size_bytes, r.error,
        ),
    )


def save_cycle_summary(conn: sqlite3.Connection, run_id: str, cycle_id: str,
                       profile: str, phase: str, concurrency: int,
                       results: list[StepResult],
                       wall_start: float, wall_end: float):
    api_results = [r for r in results if r.http_method != "SIM"]
    api_ms = sum(r.latency_ms for r in api_results)
    poll_ms = sum(r.latency_ms for r in api_results if "poll" in r.step.lower())
    api_count = len(api_results)
    rl_hits = sum(1 for r in api_results if r.secondary_rate_limit_hit)

    conn.execute(
        """INSERT OR REPLACE INTO cycle_summary
           (run_id, cycle_id, profile, phase, concurrency_level, total_wall_ms,
            total_api_ms, total_poll_ms, api_call_count, rate_limit_hits,
            started_at, finished_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            run_id, cycle_id, profile, phase, concurrency,
            (wall_end - wall_start) * 1000, api_ms, poll_ms,
            api_count, rl_hits,
            datetime.fromtimestamp(wall_start, tz=timezone.utc).isoformat(),
            datetime.fromtimestamp(wall_end, tz=timezone.utc).isoformat(),
        ),
    )


# ---------------------------------------------------------------------------
# GitHub API Client with instrumentation
# ---------------------------------------------------------------------------

class GitHubClient:
    """Instrumented GitHub REST API client."""

    def __init__(self, config: BenchmarkConfig):
        self.config = config
        self.client = httpx.AsyncClient(
            base_url=config.api_base,
            headers={
                "Authorization": f"Bearer {config.github_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": config.api_version,
                "User-Agent": "acp-gh-benchmark/1.0",
            },
            timeout=30.0,
        )
        self._owner = config.github_org
        self._repo = config.github_repo

    async def close(self):
        await self.client.aclose()

    def _extract_rate_limits(self, resp: httpx.Response) -> dict:
        def _int_or_none(key: str):
            v = resp.headers.get(key)
            return int(v) if v else None
        return {
            "remaining": _int_or_none("x-ratelimit-remaining"),
            "limit": _int_or_none("x-ratelimit-limit"),
            "used": _int_or_none("x-ratelimit-used"),
            "reset": _int_or_none("x-ratelimit-reset"),
        }

    def _is_secondary_rate_limit(self, resp: httpx.Response) -> bool:
        if resp.status_code in (403, 429):
            try:
                body = resp.json()
                msg = body.get("message", "").lower()
                return "secondary rate limit" in msg or "abuse" in msg
            except Exception:
                pass
            if resp.headers.get("retry-after"):
                return True
        return False

    async def request(
        self,
        method: str,
        path: str,
        run_id: str,
        cycle_id: str,
        profile: str,
        step: str,
        phase: str,
        concurrency: int,
        json_body: dict | None = None,
        max_retries: int = 3,
    ) -> tuple[StepResult, httpx.Response | None]:
        endpoint = f"{method} {path}"
        req_size = len(json.dumps(json_body).encode()) if json_body else 0
        retry_count = 0

        for attempt in range(max_retries + 1):
            start = time.monotonic()
            start_ts = time.time()

            try:
                kwargs: dict[str, Any] = {}
                if json_body is not None:
                    kwargs["json"] = json_body

                resp = await self.client.request(method, path, **kwargs)
                end = time.monotonic()
                end_ts = time.time()
                latency_ms = (end - start) * 1000
                rl = self._extract_rate_limits(resp)
                secondary_hit = self._is_secondary_rate_limit(resp)

                if secondary_hit and attempt < max_retries:
                    retry_after = resp.headers.get("retry-after")
                    wait = int(retry_after) if retry_after else min(60, 2 ** attempt * 5)
                    print(f"  !! Secondary rate limit on {endpoint}, waiting {wait}s (attempt {attempt+1})")
                    retry_count += 1
                    await asyncio.sleep(wait)
                    continue

                if resp.status_code >= 500 and attempt < max_retries:
                    retry_count += 1
                    await asyncio.sleep(2 ** attempt)
                    continue

                return StepResult(
                    run_id=run_id, cycle_id=cycle_id, profile=profile, step=step,
                    phase=phase, concurrency_level=concurrency,
                    start_ts=start_ts, end_ts=end_ts, latency_ms=latency_ms,
                    http_status=resp.status_code, http_method=method,
                    endpoint=endpoint,
                    rate_limit_remaining=rl["remaining"],
                    rate_limit_limit=rl["limit"],
                    rate_limit_used=rl["used"],
                    rate_limit_reset=rl["reset"],
                    secondary_rate_limit_hit=secondary_hit,
                    retry_count=retry_count,
                    request_size_bytes=req_size,
                    response_size_bytes=len(resp.content),
                    error=None if resp.status_code < 400 else resp.text[:500],
                ), resp

            except Exception as e:
                end = time.monotonic()
                end_ts = time.time()
                if attempt < max_retries:
                    retry_count += 1
                    await asyncio.sleep(2 ** attempt)
                    continue

                return StepResult(
                    run_id=run_id, cycle_id=cycle_id, profile=profile, step=step,
                    phase=phase, concurrency_level=concurrency,
                    start_ts=start_ts, end_ts=end_ts,
                    latency_ms=(end - start) * 1000,
                    http_status=None, http_method=method,
                    endpoint=endpoint,
                    rate_limit_remaining=None, rate_limit_limit=None,
                    rate_limit_used=None, rate_limit_reset=None,
                    secondary_rate_limit_hit=False, retry_count=retry_count,
                    request_size_bytes=req_size, response_size_bytes=0,
                    error=str(e),
                ), None

        raise RuntimeError("Exhausted retries without returning")

    def sim_step(self, run_id: str, cycle_id: str, profile: str, step: str,
                 phase: str, concurrency: int, latency_ms: float) -> StepResult:
        now = time.time()
        return StepResult(
            run_id=run_id, cycle_id=cycle_id, profile=profile, step=step,
            phase=phase, concurrency_level=concurrency,
            start_ts=now, end_ts=now,
            latency_ms=latency_ms,
            http_status=None, http_method="SIM",
            endpoint=f"simulated:{step}",
            rate_limit_remaining=None, rate_limit_limit=None,
            rate_limit_used=None, rate_limit_reset=None,
            secondary_rate_limit_hit=False, retry_count=0,
            request_size_bytes=0, response_size_bytes=0,
            error=None,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_head_sha(gh: GitHubClient, owner: str, repo: str, branch: str,
                        run_id: str, cycle_id: str, profile: str,
                        phase: str, concurrency: int) -> str:
    _, resp = await gh.request(
        "GET", f"/repos/{owner}/{repo}/git/ref/heads/{branch}",
        run_id, cycle_id, profile, "get_head_sha", phase, concurrency,
    )
    if resp and resp.status_code == 200:
        return resp.json()["object"]["sha"]
    return ""


def _make_cycle_id(profile: str, phase: str, concurrency: int, cycle_num: int) -> str:
    h = hashlib.md5(str(time.time()).encode()).hexdigest()[:8]
    return f"{profile}_{phase}_{concurrency}c_{cycle_num}_{h}"


class _CycleContext:
    """Shared context for a single cycle execution."""

    def __init__(self, gh: GitHubClient, conn: sqlite3.Connection,
                 config: BenchmarkConfig, cycle_id: str, profile: str,
                 phase: str, concurrency: int):
        self.gh = gh
        self.conn = conn
        self.config = config
        self.run_id = config.run_id
        self.cycle_id = cycle_id
        self.profile = profile
        self.phase = phase
        self.concurrency = concurrency
        self.results: list[StepResult] = []
        self.wall_start = time.time()
        self.owner = config.github_org
        self.repo = config.github_repo

    def save(self, r: StepResult):
        self.results.append(r)
        save_result(self.conn, r)
        if r.http_method == "SIM":
            print(f"  [{self.cycle_id}] {r.step:<30} {r.latency_ms:>8.1f}ms  SIM (not counted)")
        else:
            status = f"HTTP {r.http_status}" if r.http_status else "ERR"
            err = f" ERR: {r.error[:60]}" if r.error else ""
            print(f"  [{self.cycle_id}] {r.step:<30} {r.latency_ms:>8.1f}ms  {status}{err}")

    async def api(self, method: str, path: str, step: str,
                  json_body: dict | None = None) -> tuple[StepResult, httpx.Response | None]:
        r, resp = await self.gh.request(
            method, path, self.run_id, self.cycle_id, self.profile, step,
            self.phase, self.concurrency, json_body=json_body,
        )
        self.save(r)
        return r, resp

    def sim(self, step: str, delay_seconds: float):
        r = self.gh.sim_step(
            self.run_id, self.cycle_id, self.profile, step,
            self.phase, self.concurrency, delay_seconds * 1000,
        )
        self.save(r)

    def finish(self):
        wall_end = time.time()
        save_cycle_summary(
            self.conn, self.run_id, self.cycle_id, self.profile, self.phase,
            self.concurrency, self.results, self.wall_start, wall_end,
        )
        self.conn.commit()
        api_results = [r for r in self.results if r.http_method != "SIM"]
        api_ms = sum(r.latency_ms for r in api_results)
        api_count = len(api_results)
        wall_ms = (wall_end - self.wall_start) * 1000
        print(f"  Done [{self.profile}]: wall={wall_ms:.0f}ms api={api_ms:.0f}ms calls={api_count}")


# ---------------------------------------------------------------------------
# Traffic Profiles
# ---------------------------------------------------------------------------

async def run_amber(ctx: _CycleContext):
    """Amber agent: issue -> label -> dispatch -> sim compute -> status ->
    report -> branch -> push -> PR -> poll -> review -> merge -> close."""

    o, r = ctx.owner, ctx.repo
    delays = ctx.config.compute_delays

    # A: Create issue with label
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/issues", "create_issue", {
        "title": f"[amber-benchmark] {ctx.cycle_id}",
        "body": f"Amber agent benchmark cycle `{ctx.cycle_id}`.",
        "labels": ["amber-autofix"],
    })
    if res.error or not resp:
        ctx.finish()
        return
    issue_number = resp.json()["number"]

    # B: Workflow dispatch
    await ctx.api("POST", f"/repos/{o}/{r}/dispatches", "workflow_dispatch", {
        "event_type": "amber-benchmark",
        "client_payload": {"cycle_id": ctx.cycle_id, "issue_number": issue_number},
    })

    # C-E: Simulated compute (logged, zero wall time)
    ctx.sim("sim_ambient_action", delays["ambient_action"])
    ctx.sim("sim_acp_session", delays["create_acp_session"])
    ctx.sim("sim_amber2_workflow", delays["amber2_workflow"])

    # F: Load context
    await ctx.api("GET", f"/repos/{o}/{r}", "load_repo_context")
    await ctx.api("GET", f"/repos/{o}/{r}/issues/{issue_number}", "load_issue_context")

    # G-I: Simulated compute
    ctx.sim("sim_spec_kit", delays["spec_kit_flow"])
    ctx.sim("sim_reproduce", delays["reproduce_test"])
    ctx.sim("sim_implement", delays["implement_fix"])

    # J: Commit status (pending + success)
    head_sha = await _get_head_sha(ctx.gh, o, r, ctx.config.base_branch,
                                   ctx.run_id, ctx.cycle_id, ctx.profile, ctx.phase, ctx.concurrency)
    await ctx.api("POST", f"/repos/{o}/{r}/statuses/{head_sha}", "create_status", {
        "state": "pending",
        "context": f"amber-benchmark/{ctx.cycle_id}",
        "description": "Running lint/test/coverage...",
    })
    await ctx.api("POST", f"/repos/{o}/{r}/statuses/{head_sha}", "complete_status", {
        "state": "success",
        "context": f"amber-benchmark/{ctx.cycle_id}",
        "description": "Lint ok | Tests ok | Coverage 92%",
    })

    # K: Report comment
    report = json.dumps({"cycle_id": ctx.cycle_id, "status": "success",
                         "lint": "pass", "tests": "42/42", "coverage": "92%"}, indent=2)
    await ctx.api("POST", f"/repos/{o}/{r}/issues/{issue_number}/comments",
                  "emit_report", {"body": f"## Amber Report\n```json\n{report}\n```"})

    # L: Branch + push file
    branch = f"amber/benchmark-{ctx.cycle_id}"
    base_sha = await _get_head_sha(ctx.gh, o, r, ctx.config.base_branch,
                                    ctx.run_id, ctx.cycle_id, ctx.profile, ctx.phase, ctx.concurrency)
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/git/refs", "create_branch", {
        "ref": f"refs/heads/{branch}", "sha": base_sha,
    })
    if res.error:
        await ctx.api("PATCH", f"/repos/{o}/{r}/issues/{issue_number}",
                      "close_issue", {"state": "closed"})
        ctx.finish()
        return

    content = base64.b64encode(f"# Fix for {ctx.cycle_id}\n".encode()).decode()
    await ctx.api("PUT", f"/repos/{o}/{r}/contents/benchmark/{ctx.cycle_id}.md",
                  "push_file", {"message": f"fix: {ctx.cycle_id}", "content": content, "branch": branch})

    # M: Create PR
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/pulls", "create_pr", {
        "title": f"fix: amber {ctx.cycle_id}", "head": branch, "base": ctx.config.base_branch,
        "body": f"Closes #{issue_number}",
    })
    if res.error or not resp:
        await ctx.api("DELETE", f"/repos/{o}/{r}/git/refs/heads/{branch}", "cleanup_branch")
        await ctx.api("PATCH", f"/repos/{o}/{r}/issues/{issue_number}",
                      "close_issue", {"state": "closed"})
        ctx.finish()
        return
    pr_number = resp.json()["number"]

    # M: Poll for mergeable
    for _ in range(ctx.config.poll_max_attempts):
        r_poll, resp_poll = await ctx.api("GET", f"/repos/{o}/{r}/pulls/{pr_number}", "poll_mergeable")
        if resp_poll and resp_poll.json().get("mergeable") is not None:
            break
        await asyncio.sleep(ctx.config.poll_interval_seconds)

    # N: Review (COMMENT — can't self-approve)
    await ctx.api("POST", f"/repos/{o}/{r}/pulls/{pr_number}/reviews",
                  "submit_review", {"event": "COMMENT", "body": "LGTM - benchmark auto-review"})

    # O: Merge
    await ctx.api("PUT", f"/repos/{o}/{r}/pulls/{pr_number}/merge",
                  "merge_pr", {"merge_method": "squash", "commit_title": f"fix: amber {ctx.cycle_id}"})

    # P: Post-merge comment
    await ctx.api("POST", f"/repos/{o}/{r}/issues/{issue_number}/comments",
                  "post_merge_comment", {"body": f"Post-merge learning for `{ctx.cycle_id}`."})

    # Q: Close issue
    await ctx.api("PATCH", f"/repos/{o}/{r}/issues/{issue_number}",
                  "close_issue", {"state": "closed", "labels": ["amber-autofix", "benchmark-complete"]})

    # Z: Cleanup branch
    await ctx.api("DELETE", f"/repos/{o}/{r}/git/refs/heads/{branch}", "cleanup_branch")

    ctx.finish()


async def run_amber_optimized(ctx: _CycleContext):
    """Amber agent (optimized): parallelize GETs, drop self-review, delay-then-poll."""

    o, r = ctx.owner, ctx.repo
    delays = ctx.config.compute_delays

    # A: Create issue with label
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/issues", "create_issue", {
        "title": f"[amber-benchmark] {ctx.cycle_id}",
        "body": f"Amber agent benchmark cycle `{ctx.cycle_id}`.",
        "labels": ["amber-autofix"],
    })
    if res.error or not resp:
        ctx.finish()
        return
    issue_number = resp.json()["number"]

    # B: Workflow dispatch
    await ctx.api("POST", f"/repos/{o}/{r}/dispatches", "workflow_dispatch", {
        "event_type": "amber-benchmark",
        "client_payload": {"cycle_id": ctx.cycle_id, "issue_number": issue_number},
    })

    # C-E: Simulated compute
    ctx.sim("sim_ambient_action", delays["ambient_action"])
    ctx.sim("sim_acp_session", delays["create_acp_session"])
    ctx.sim("sim_amber2_workflow", delays["amber2_workflow"])

    # F: Load context — OPTIMIZED: parallel GETs
    repo_task = ctx.api("GET", f"/repos/{o}/{r}", "load_repo_context")
    issue_task = ctx.api("GET", f"/repos/{o}/{r}/issues/{issue_number}", "load_issue_context")
    await asyncio.gather(repo_task, issue_task)

    # G-I: Simulated compute
    ctx.sim("sim_spec_kit", delays["spec_kit_flow"])
    ctx.sim("sim_reproduce", delays["reproduce_test"])
    ctx.sim("sim_implement", delays["implement_fix"])

    # J: Commit status (pending + success)
    head_sha = await _get_head_sha(ctx.gh, o, r, ctx.config.base_branch,
                                   ctx.run_id, ctx.cycle_id, ctx.profile, ctx.phase, ctx.concurrency)
    await ctx.api("POST", f"/repos/{o}/{r}/statuses/{head_sha}", "create_status", {
        "state": "pending",
        "context": f"amber-benchmark/{ctx.cycle_id}",
        "description": "Running lint/test/coverage...",
    })
    await ctx.api("POST", f"/repos/{o}/{r}/statuses/{head_sha}", "complete_status", {
        "state": "success",
        "context": f"amber-benchmark/{ctx.cycle_id}",
        "description": "Lint ok | Tests ok | Coverage 92%",
    })

    # K: Report comment
    report = json.dumps({"cycle_id": ctx.cycle_id, "status": "success",
                         "lint": "pass", "tests": "42/42", "coverage": "92%"}, indent=2)
    await ctx.api("POST", f"/repos/{o}/{r}/issues/{issue_number}/comments",
                  "emit_report", {"body": f"## Amber Report\n```json\n{report}\n```"})

    # L: Branch + push file
    branch = f"amber/benchmark-{ctx.cycle_id}"
    base_sha = await _get_head_sha(ctx.gh, o, r, ctx.config.base_branch,
                                    ctx.run_id, ctx.cycle_id, ctx.profile, ctx.phase, ctx.concurrency)
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/git/refs", "create_branch", {
        "ref": f"refs/heads/{branch}", "sha": base_sha,
    })
    if res.error:
        await ctx.api("PATCH", f"/repos/{o}/{r}/issues/{issue_number}",
                      "close_issue", {"state": "closed"})
        ctx.finish()
        return

    content = base64.b64encode(f"# Fix for {ctx.cycle_id}\n".encode()).decode()
    await ctx.api("PUT", f"/repos/{o}/{r}/contents/benchmark/{ctx.cycle_id}.md",
                  "push_file", {"message": f"fix: {ctx.cycle_id}", "content": content, "branch": branch})

    # M: Create PR
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/pulls", "create_pr", {
        "title": f"fix: amber {ctx.cycle_id}", "head": branch, "base": ctx.config.base_branch,
        "body": f"Closes #{issue_number}",
    })
    if res.error or not resp:
        await ctx.api("DELETE", f"/repos/{o}/{r}/git/refs/heads/{branch}", "cleanup_branch")
        await ctx.api("PATCH", f"/repos/{o}/{r}/issues/{issue_number}",
                      "close_issue", {"state": "closed"})
        ctx.finish()
        return
    pr_number = resp.json()["number"]

    # M: Poll for mergeable — OPTIMIZED: initial delay then poll
    await asyncio.sleep(0.5)
    for _ in range(ctx.config.poll_max_attempts):
        r_poll, resp_poll = await ctx.api("GET", f"/repos/{o}/{r}/pulls/{pr_number}", "poll_mergeable")
        if resp_poll and resp_poll.json().get("mergeable") is not None:
            break
        await asyncio.sleep(ctx.config.poll_interval_seconds)

    # N: Review — OPTIMIZED: dropped (self-review is a no-op COMMENT)

    # O: Merge
    await ctx.api("PUT", f"/repos/{o}/{r}/pulls/{pr_number}/merge",
                  "merge_pr", {"merge_method": "squash", "commit_title": f"fix: amber {ctx.cycle_id}"})

    # P: Post-merge comment
    await ctx.api("POST", f"/repos/{o}/{r}/issues/{issue_number}/comments",
                  "post_merge_comment", {"body": f"Post-merge learning for `{ctx.cycle_id}`."})

    # Q: Close issue
    await ctx.api("PATCH", f"/repos/{o}/{r}/issues/{issue_number}",
                  "close_issue", {"state": "closed", "labels": ["amber-autofix", "benchmark-complete"]})

    # Z: Cleanup branch
    await ctx.api("DELETE", f"/repos/{o}/{r}/git/refs/heads/{branch}", "cleanup_branch")

    ctx.finish()


async def run_human_feature(ctx: _CycleContext):
    """Human feature PR: branch -> multi-file push -> PR -> bot comment
    (CodeRabbit-style) -> human review comment -> merge -> cleanup."""

    o, r = ctx.owner, ctx.repo

    # Get base SHA + create branch
    base_sha = await _get_head_sha(ctx.gh, o, r, ctx.config.base_branch,
                                    ctx.run_id, ctx.cycle_id, ctx.profile, ctx.phase, ctx.concurrency)
    branch = f"feat/benchmark-{ctx.cycle_id}"
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/git/refs", "create_branch", {
        "ref": f"refs/heads/{branch}", "sha": base_sha,
    })
    if res.error:
        ctx.finish()
        return

    # Push 2 files (simulates multi-commit feature work)
    for i in range(2):
        content = base64.b64encode(f"# Feature file {i} for {ctx.cycle_id}\n".encode()).decode()
        await ctx.api("PUT", f"/repos/{o}/{r}/contents/benchmark/feat-{ctx.cycle_id}-{i}.md",
                      f"push_file_{i}", {
                          "message": f"feat: add file {i} for {ctx.cycle_id}",
                          "content": content,
                          "branch": branch,
                      })

    # Create PR
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/pulls", "create_pr", {
        "title": f"feat: benchmark {ctx.cycle_id}", "head": branch, "base": ctx.config.base_branch,
        "body": f"Feature benchmark PR for `{ctx.cycle_id}`.",
    })
    if res.error or not resp:
        await ctx.api("DELETE", f"/repos/{o}/{r}/git/refs/heads/{branch}", "cleanup_branch")
        ctx.finish()
        return
    pr_number = resp.json()["number"]

    # Poll mergeable
    for _ in range(ctx.config.poll_max_attempts):
        r_poll, resp_poll = await ctx.api("GET", f"/repos/{o}/{r}/pulls/{pr_number}", "poll_mergeable")
        if resp_poll and resp_poll.json().get("mergeable") is not None:
            break
        await asyncio.sleep(ctx.config.poll_interval_seconds)

    # Bot review comment (CodeRabbit-style)
    await ctx.api("POST", f"/repos/{o}/{r}/issues/{pr_number}/comments",
                  "bot_review_comment", {
                      "body": ("## CodeRabbit Review\n\n"
                               "**Walkthrough:** Added benchmark feature files.\n"
                               "**Changes:** 2 files added\n"
                               "**Assessment:** LGTM"),
                  })

    # Human review (COMMENT — can't self-approve)
    await ctx.api("POST", f"/repos/{o}/{r}/pulls/{pr_number}/reviews",
                  "human_review", {"event": "COMMENT", "body": "Looks good, ship it."})

    # Merge (merge commit — matching platform repo pattern)
    await ctx.api("PUT", f"/repos/{o}/{r}/pulls/{pr_number}/merge",
                  "merge_pr", {"merge_method": "merge", "commit_title": f"feat: benchmark {ctx.cycle_id}"})

    # Cleanup branch
    await ctx.api("DELETE", f"/repos/{o}/{r}/git/refs/heads/{branch}", "cleanup_branch")

    ctx.finish()


async def run_dependabot(ctx: _CycleContext):
    """Dependabot: create tiny PR -> auto-merge immediately -> cleanup."""

    o, r = ctx.owner, ctx.repo

    # Create branch + push a tiny change
    base_sha = await _get_head_sha(ctx.gh, o, r, ctx.config.base_branch,
                                    ctx.run_id, ctx.cycle_id, ctx.profile, ctx.phase, ctx.concurrency)
    branch = f"dependabot/benchmark-{ctx.cycle_id}"
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/git/refs", "create_branch", {
        "ref": f"refs/heads/{branch}", "sha": base_sha,
    })
    if res.error:
        ctx.finish()
        return

    content = base64.b64encode(f"version bump {ctx.cycle_id}\n".encode()).decode()
    await ctx.api("PUT", f"/repos/{o}/{r}/contents/benchmark/deps-{ctx.cycle_id}.txt",
                  "push_file", {
                      "message": f"chore(deps): bump for {ctx.cycle_id}",
                      "content": content,
                      "branch": branch,
                  })

    # Create PR
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/pulls", "create_pr", {
        "title": f"chore(deps): bump {ctx.cycle_id}", "head": branch, "base": ctx.config.base_branch,
        "body": "Automated dependency update.",
        "labels": ["dependencies"],
    })
    if res.error or not resp:
        await ctx.api("DELETE", f"/repos/{o}/{r}/git/refs/heads/{branch}", "cleanup_branch")
        ctx.finish()
        return
    pr_number = resp.json()["number"]

    # Immediate merge (auto-merge pattern — no review)
    # Brief poll for mergeable state
    for _ in range(5):
        r_poll, resp_poll = await ctx.api("GET", f"/repos/{o}/{r}/pulls/{pr_number}", "poll_mergeable")
        if resp_poll and resp_poll.json().get("mergeable") is not None:
            break
        await asyncio.sleep(0.5)

    await ctx.api("PUT", f"/repos/{o}/{r}/pulls/{pr_number}/merge",
                  "merge_pr", {"merge_method": "squash", "commit_title": f"chore(deps): {ctx.cycle_id}"})

    # Cleanup
    await ctx.api("DELETE", f"/repos/{o}/{r}/git/refs/heads/{branch}", "cleanup_branch")

    ctx.finish()


async def run_mergify_queue(ctx: _CycleContext):
    """Mergify queue: create draft PR -> close without merge -> cleanup."""

    o, r = ctx.owner, ctx.repo

    # Create branch
    base_sha = await _get_head_sha(ctx.gh, o, r, ctx.config.base_branch,
                                    ctx.run_id, ctx.cycle_id, ctx.profile, ctx.phase, ctx.concurrency)
    branch = f"mergify/queue-{ctx.cycle_id}"
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/git/refs", "create_branch", {
        "ref": f"refs/heads/{branch}", "sha": base_sha,
    })
    if res.error:
        ctx.finish()
        return

    # Push a trivial file so the branch differs from base
    content = base64.b64encode(f"queue batch {ctx.cycle_id}\n".encode()).decode()
    await ctx.api("PUT", f"/repos/{o}/{r}/contents/benchmark/queue-{ctx.cycle_id}.txt",
                  "push_file", {
                      "message": f"merge queue: {ctx.cycle_id}",
                      "content": content,
                      "branch": branch,
                  })

    # Create draft PR
    res, resp = await ctx.api("POST", f"/repos/{o}/{r}/pulls", "create_draft_pr", {
        "title": f"merge queue: {ctx.cycle_id}", "head": branch, "base": ctx.config.base_branch,
        "body": "Mergify merge queue batch.", "draft": True,
    })
    if res.error or not resp:
        await ctx.api("DELETE", f"/repos/{o}/{r}/git/refs/heads/{branch}", "cleanup_branch")
        ctx.finish()
        return
    pr_number = resp.json()["number"]

    # Mergify status comment
    await ctx.api("POST", f"/repos/{o}/{r}/issues/{pr_number}/comments",
                  "queue_status_comment", {"body": "Merge queue: batch processed."})

    # Close PR without merging
    await ctx.api("PATCH", f"/repos/{o}/{r}/pulls/{pr_number}",
                  "close_pr", {"state": "closed"})

    # Cleanup branch
    await ctx.api("DELETE", f"/repos/{o}/{r}/git/refs/heads/{branch}", "cleanup_branch")

    ctx.finish()


# ---------------------------------------------------------------------------
# Profile selection
# ---------------------------------------------------------------------------

PROFILES = {
    "amber": run_amber,
    "amber_opt": run_amber_optimized,
    "human": run_human_feature,
    "dependabot": run_dependabot,
    "mergify": run_mergify_queue,
}


def build_cycle_schedule(config: BenchmarkConfig) -> list[str]:
    """Build a list of profile names for each cycle based on configured percentages."""
    total = config.total_cycles
    # Normalize percentages (they might not sum to 100 if user only sets some)
    pct_sum = config.pct_amber + config.pct_amber_opt + config.pct_human + config.pct_dependabot + config.pct_mergify
    if pct_sum == 0:
        pct_sum = 100

    counts = {
        "amber": round(total * config.pct_amber / pct_sum),
        "amber_opt": round(total * config.pct_amber_opt / pct_sum),
        "human": round(total * config.pct_human / pct_sum),
        "dependabot": round(total * config.pct_dependabot / pct_sum),
        "mergify": round(total * config.pct_mergify / pct_sum),
    }

    # Fix rounding to match total exactly
    diff = total - sum(counts.values())
    if diff > 0:
        counts["amber"] += diff
    elif diff < 0:
        for k in ["mergify", "dependabot", "human", "amber_opt", "amber"]:
            if counts[k] + diff >= 0:
                counts[k] += diff
                break

    schedule = []
    for profile, count in counts.items():
        schedule.extend([profile] * count)
    random.shuffle(schedule)
    return schedule


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

async def run_benchmark(config: BenchmarkConfig):
    conn = init_db(config.db_path)
    conn.execute("PRAGMA busy_timeout=5000")
    gh = GitHubClient(config)

    schedule = build_cycle_schedule(config)
    parallel_cycles = max(0, config.total_cycles - config.sequential_cycles)

    # Create run record
    conn.execute(
        """INSERT INTO runs (run_id, name, status, total_cycles, sequential_cycles,
           max_concurrency, pct_amber, pct_human, pct_dependabot, pct_mergify,
           github_org, github_repo, started_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (config.run_id, config.run_name or config.run_id, "running",
         config.total_cycles, config.sequential_cycles, config.max_concurrency,
         config.pct_amber, config.pct_human, config.pct_dependabot, config.pct_mergify,
         config.github_org, config.github_repo,
         datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()

    profile_counts = {p: schedule.count(p) for p in PROFILES}
    print(f"\n{'#'*70}")
    print(f"# GitHub-as-State-Machine Benchmark")
    print(f"# Run: {config.run_id}")
    print(f"# Org: {config.github_org}  Repo: {config.github_repo}")
    print(f"# Total cycles: {config.total_cycles}  "
          f"(sequential={config.sequential_cycles}, parallel={parallel_cycles})")
    print(f"# Mix: amber={profile_counts.get('amber',0)} "
          f"human={profile_counts.get('human',0)} "
          f"dependabot={profile_counts.get('dependabot',0)} "
          f"mergify={profile_counts.get('mergify',0)}")
    print(f"# Max concurrency: {config.max_concurrency}")
    print(f"# DB: {config.db_path}")
    print(f"{'#'*70}")

    # Phase 1: Sequential baseline
    seq_count = min(config.sequential_cycles, len(schedule))
    if seq_count > 0:
        print(f"\n{'---'*23}")
        print(f"PHASE 1: Sequential baseline ({seq_count} cycles)")
        print(f"{'---'*23}")
        for i in range(seq_count):
            profile = schedule[i]
            cycle_id = _make_cycle_id(profile, "sequential", 1, i)
            print(f"\n{'='*70}")
            print(f"Cycle {cycle_id} | profile={profile} phase=sequential concurrency=1")
            print(f"{'='*70}")
            ctx = _CycleContext(gh, conn, config, cycle_id, profile, "sequential", 1)
            await PROFILES[profile](ctx)

    # Phase 2: Parallel ramp
    parallel_schedule = schedule[seq_count:]
    if parallel_schedule:
        print(f"\n{'---'*23}")
        print(f"PHASE 2: Parallel ramp ({len(parallel_schedule)} cycles, "
              f"up to {config.max_concurrency} concurrent)")
        print(f"{'---'*23}")

        idx = 0
        concurrency = 1
        cycle_counter = 0

        while idx < len(parallel_schedule) and concurrency <= config.max_concurrency:
            batch_size = min(concurrency, len(parallel_schedule) - idx)
            batch = parallel_schedule[idx:idx + batch_size]
            print(f"\n  -> Batch: {batch_size} concurrent ({', '.join(batch)}) concurrency={concurrency}")

            tasks = []
            for j, profile in enumerate(batch):
                cycle_id = _make_cycle_id(profile, "parallel", concurrency, cycle_counter + j)
                print(f"\n{'='*70}")
                print(f"Cycle {cycle_id} | profile={profile} phase=parallel concurrency={concurrency}")
                print(f"{'='*70}")
                ctx = _CycleContext(gh, conn, config, cycle_id, profile, "parallel", concurrency)
                tasks.append(PROFILES[profile](ctx))

            await asyncio.gather(*tasks)

            idx += batch_size
            cycle_counter += batch_size
            if cycle_counter % config.ramp_step == 0 and concurrency < config.max_concurrency:
                concurrency += 1

    # Snapshot final rate limits
    resp = await gh.client.request("GET", "/rate_limit")
    if resp.status_code == 200:
        rl = resp.json().get("resources", {}).get("core", {})
        conn.execute(
            "INSERT INTO rate_limit_snapshots (ts, core_remaining, core_limit, core_reset) VALUES (?,?,?,?)",
            (time.time(), rl.get("remaining"), rl.get("limit"), rl.get("reset")),
        )
        conn.commit()
        print(f"\n  Rate limit snapshot: {rl.get('remaining')}/{rl.get('limit')} remaining")

    # Mark run as complete
    conn.execute(
        "UPDATE runs SET status='completed', finished_at=? WHERE run_id=?",
        (datetime.now(timezone.utc).isoformat(), config.run_id),
    )
    conn.commit()

    await gh.close()
    conn.close()

    print(f"\n{'#'*70}")
    print(f"# Benchmark complete. Run: {config.run_id}")
    print(f"# Results in: {config.db_path}")
    print(f"{'#'*70}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    config = BenchmarkConfig.from_env()
    asyncio.run(run_benchmark(config))


if __name__ == "__main__":
    main()
