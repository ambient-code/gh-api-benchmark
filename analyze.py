#!/usr/bin/env python3
"""
Benchmark Analysis & Report Generator
======================================

Reads benchmark_results.db and produces:
  1. Per-step latency statistics (p50, p90, p99, mean, stddev)
  2. Sequential vs parallel comparison
  3. Rate limit consumption over time
  4. Event propagation delay analysis (poll steps)
  5. Concurrency scaling curve
  6. "GitHub tax" calculation — time spent waiting on GitHub vs compute
  7. CSV exports for external visualization
"""

import csv
import json
import math
import sqlite3
import sys
from pathlib import Path


def percentile(data: list[float], p: float) -> float:
    """Compute the p-th percentile of a list."""
    if not data:
        return 0.0
    k = (len(data) - 1) * p / 100
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return data[int(k)]
    return data[int(f)] * (c - k) + data[int(c)] * (k - f)


def analyze(db_path: str, output_dir: str = "."):
    """Run all analyses and write reports."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    report_lines: list[str] = []

    def section(title: str):
        report_lines.append(f"\n{'='*70}")
        report_lines.append(f"  {title}")
        report_lines.append(f"{'='*70}\n")

    def line(text: str = ""):
        report_lines.append(text)

    # ── 1. Per-step latency stats ────────────────────────────────────
    section("1. Per-Step Latency Statistics (API calls only)")

    all_latencies = conn.execute("""
        SELECT step, latency_ms FROM step_results
        WHERE http_status IS NOT NULL
        ORDER BY step, latency_ms
    """).fetchall()

    steps_data: dict[str, list[float]] = {}
    for row in all_latencies:
        steps_data.setdefault(row["step"], []).append(row["latency_ms"])

    line(f"{'Step':<35} {'Count':>6} {'Mean':>8} {'P50':>8} {'P90':>8} {'P99':>8} {'StdDev':>8} {'Min':>8} {'Max':>8}")
    line(f"{'-'*35} {'-'*6} {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*8}")

    step_csv_rows = []
    for step_name in sorted(steps_data):
        latencies = steps_data[step_name]
        if not latencies:
            continue
        n = len(latencies)
        mean = sum(latencies) / n
        stddev = math.sqrt(sum((x - mean) ** 2 for x in latencies) / n) if n > 1 else 0
        p50 = percentile(latencies, 50)
        p90 = percentile(latencies, 90)
        p99 = percentile(latencies, 99)

        line(f"{step_name:<35} {n:>6} {mean:>8.1f} {p50:>8.1f} {p90:>8.1f} {p99:>8.1f} {stddev:>8.1f} {min(latencies):>8.1f} {max(latencies):>8.1f}")
        step_csv_rows.append({
            "step": step_name, "count": n, "mean_ms": round(mean, 1),
            "p50_ms": round(p50, 1), "p90_ms": round(p90, 1), "p99_ms": round(p99, 1),
            "stddev_ms": round(stddev, 1), "min_ms": round(min(latencies), 1),
            "max_ms": round(max(latencies), 1),
        })

    # CSV export
    if step_csv_rows:
        with open(out / "step_latency_stats.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=step_csv_rows[0].keys())
            w.writeheader()
            w.writerows(step_csv_rows)

    # ── 2. Sequential vs Parallel comparison ─────────────────────────
    section("2. Sequential vs Parallel Phase Comparison")

    for phase in ["sequential", "parallel"]:
        rows = conn.execute("""
            SELECT total_wall_ms, total_api_ms, total_sim_ms, total_poll_ms,
                   api_call_count, rate_limit_hits, concurrency_level
            FROM cycle_summary WHERE phase=?
        """, (phase,)).fetchall()
        if not rows:
            continue

        line(f"  Phase: {phase.upper()}")
        line(f"  {'─'*60}")
        walls = [r["total_wall_ms"] for r in rows]
        apis = [r["total_api_ms"] for r in rows]
        sims = [r["total_sim_ms"] for r in rows]
        polls = [r["total_poll_ms"] for r in rows]
        api_counts = [r["api_call_count"] for r in rows]

        line(f"  Cycles:          {len(rows)}")
        line(f"  Wall time:       mean={sum(walls)/len(walls):.0f}ms  min={min(walls):.0f}ms  max={max(walls):.0f}ms")
        line(f"  API time:        mean={sum(apis)/len(apis):.0f}ms  min={min(apis):.0f}ms  max={max(apis):.0f}ms")
        line(f"  Sim time:        mean={sum(sims)/len(sims):.0f}ms")
        line(f"  Poll time:       mean={sum(polls)/len(polls):.0f}ms  max={max(polls):.0f}ms")
        line(f"  API calls/cycle: mean={sum(api_counts)/len(api_counts):.1f}")
        line(f"  Rate limit hits: {sum(r['rate_limit_hits'] for r in rows)}")

        if apis and sims:
            gh_tax = sum(apis) / (sum(apis) + sum(sims)) * 100
            line(f"  GitHub tax:      {gh_tax:.1f}% of non-wall time is API latency")
        line()

    # ── 3. Concurrency scaling curve ─────────────────────────────────
    section("3. Concurrency Scaling Curve")

    concurrency_levels = conn.execute("""
        SELECT DISTINCT concurrency_level FROM cycle_summary
        WHERE phase='parallel' ORDER BY concurrency_level
    """).fetchall()

    line(f"{'Concurrency':>12} {'Cycles':>8} {'Mean Wall ms':>14} {'Mean API ms':>14} {'Mean Poll ms':>14} {'RL Hits':>8}")
    line(f"{'-'*12} {'-'*8} {'-'*14} {'-'*14} {'-'*14} {'-'*8}")

    for cl in concurrency_levels:
        level = cl["concurrency_level"]
        rows = conn.execute("""
            SELECT total_wall_ms, total_api_ms, total_poll_ms, rate_limit_hits
            FROM cycle_summary WHERE phase='parallel' AND concurrency_level=?
        """, (level,)).fetchall()
        n = len(rows)
        mean_wall = sum(r["total_wall_ms"] for r in rows) / n
        mean_api = sum(r["total_api_ms"] for r in rows) / n
        mean_poll = sum(r["total_poll_ms"] for r in rows) / n
        rl = sum(r["rate_limit_hits"] for r in rows)
        line(f"{level:>12} {n:>8} {mean_wall:>14.0f} {mean_api:>14.0f} {mean_poll:>14.0f} {rl:>8}")

    # ── 4. Event propagation (PR mergeable polling) ──────────────────
    section("4. Event Propagation Analysis (PR Mergeable Polling)")

    poll_rows = conn.execute("""
        SELECT cycle_id, COUNT(*) as polls, SUM(latency_ms) as total_ms,
               MIN(latency_ms) as min_ms, MAX(latency_ms) as max_ms
        FROM step_results
        WHERE step='M_poll_pr_mergeable'
        GROUP BY cycle_id
    """).fetchall()

    if poll_rows:
        all_polls = [r["polls"] for r in poll_rows]
        all_total = [r["total_ms"] for r in poll_rows]
        line(f"  Cycles measured:    {len(poll_rows)}")
        line(f"  Polls per cycle:    mean={sum(all_polls)/len(all_polls):.1f}  max={max(all_polls)}")
        line(f"  Total poll time:    mean={sum(all_total)/len(all_total):.0f}ms  max={max(all_total):.0f}ms")
        line()
        line(f"  ⚡ This is pure DELAY — time spent waiting for GitHub to compute")
        line(f"     mergeable state. An event-driven approach (webhooks) would")
        line(f"     eliminate this polling loop entirely.")

    # ── 5. GitHub Tax Summary ────────────────────────────────────────
    section("5. GitHub Tax Summary")

    totals = conn.execute("""
        SELECT
            SUM(CASE WHEN http_status IS NOT NULL THEN latency_ms ELSE 0 END) as total_api_ms,
            SUM(CASE WHEN http_status IS NULL AND step LIKE '%sim%' THEN latency_ms ELSE 0 END) as total_sim_ms,
            SUM(CASE WHEN step='M_poll_pr_mergeable' THEN latency_ms ELSE 0 END) as total_poll_ms,
            COUNT(CASE WHEN http_status IS NOT NULL THEN 1 END) as api_count,
            COUNT(CASE WHEN secondary_rate_limit_hit=1 THEN 1 END) as rl_hits
        FROM step_results
    """).fetchone()

    if totals:
        api_ms = totals["total_api_ms"] or 0
        sim_ms = totals["total_sim_ms"] or 0
        poll_ms = totals["total_poll_ms"] or 0
        total = api_ms + sim_ms

        line(f"  Total API time:          {api_ms:>12.0f}ms ({api_ms/1000:.1f}s)")
        line(f"  Total simulated compute: {sim_ms:>12.0f}ms ({sim_ms/1000:.1f}s)")
        line(f"  Total poll/wait time:    {poll_ms:>12.0f}ms ({poll_ms/1000:.1f}s)")
        line(f"  Total API calls:         {totals['api_count']:>12}")
        line(f"  Secondary rate limit hits:{totals['rl_hits']:>11}")
        line()
        if total > 0:
            line(f"  ┌─────────────────────────────────────────────────────┐")
            line(f"  │ GitHub Tax: {api_ms/total*100:.1f}% of cycle time is GitHub API     │")
            line(f"  │ Poll Tax:   {poll_ms/total*100:.1f}% of cycle time is polling/waiting │")
            line(f"  │ Compute:    {sim_ms/total*100:.1f}% of cycle time is actual work      │")
            line(f"  └─────────────────────────────────────────────────────┘")
            line()
            line(f"  Recommendation: An event-driven architecture using GitHub")
            line(f"  webhooks or check-suite events would eliminate the {poll_ms/1000:.1f}s")
            line(f"  of polling overhead per cycle and reduce API calls by")
            line(f"  ~{len(poll_rows) if poll_rows else 0} calls per cycle.")

    # ── 6. Rate limit consumption over time ──────────────────────────
    section("6. Rate Limit Consumption Timeline")

    rl_timeline = conn.execute("""
        SELECT cycle_id, step, start_ts, rate_limit_remaining, rate_limit_used
        FROM step_results
        WHERE rate_limit_remaining IS NOT NULL
        ORDER BY start_ts
    """).fetchall()

    if rl_timeline:
        line(f"  First reading: remaining={rl_timeline[0]['rate_limit_remaining']}")
        line(f"  Last reading:  remaining={rl_timeline[-1]['rate_limit_remaining']}")
        consumed = (rl_timeline[0]["rate_limit_remaining"] or 0) - (rl_timeline[-1]["rate_limit_remaining"] or 0)
        duration_s = rl_timeline[-1]["start_ts"] - rl_timeline[0]["start_ts"]
        if duration_s > 0:
            line(f"  Consumed:      {consumed} in {duration_s:.0f}s ({consumed/duration_s*3600:.0f}/hr rate)")

        # CSV export
        with open(out / "rate_limit_timeline.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["timestamp", "cycle_id", "step", "remaining", "used"])
            for r in rl_timeline:
                w.writerow([r["start_ts"], r["cycle_id"], r["step"],
                            r["rate_limit_remaining"], r["rate_limit_used"]])

    # ── 7. Error summary ─────────────────────────────────────────────
    section("7. Error Summary")

    errors = conn.execute("""
        SELECT step, http_status, COUNT(*) as count, MIN(error) as sample_error
        FROM step_results
        WHERE error IS NOT NULL
        GROUP BY step, http_status
        ORDER BY count DESC
    """).fetchall()

    if errors:
        line(f"{'Step':<35} {'Status':>7} {'Count':>6} {'Sample Error'}")
        line(f"{'-'*35} {'-'*7} {'-'*6} {'-'*40}")
        for e in errors:
            sample = (e["sample_error"] or "")[:60]
            line(f"{e['step']:<35} {e['http_status'] or 'N/A':>7} {e['count']:>6} {sample}")
    else:
        line("  No errors recorded.")

    # ── Write report ─────────────────────────────────────────────────
    report_text = "\n".join(report_lines)
    print(report_text)

    with open(out / "benchmark_report.txt", "w") as f:
        f.write(report_text)

    # ── Export all step results as CSV ────────────────────────────────
    all_steps = conn.execute("SELECT * FROM step_results ORDER BY start_ts").fetchall()
    if all_steps:
        with open(out / "all_step_results.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(all_steps[0].keys())
            for r in all_steps:
                w.writerow(tuple(r))

    conn.close()
    print(f"\n  Reports written to: {out}/")
    print(f"  - benchmark_report.txt")
    print(f"  - step_latency_stats.csv")
    print(f"  - rate_limit_timeline.csv")
    print(f"  - all_step_results.csv")


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else "benchmark_results.db"
    output = sys.argv[2] if len(sys.argv) > 2 else "."
    analyze(db, output)
