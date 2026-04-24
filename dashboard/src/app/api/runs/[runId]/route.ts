import { NextResponse } from "next/server";
import { getDb, getDbWrite } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  try {
    const db = getDb();

    const run = db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    if (!run) {
      db.close();
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const cycles = db.prepare(
      "SELECT * FROM cycle_summary WHERE run_id = ? ORDER BY started_at"
    ).all(runId);

    // Live stats from step_results (works even before cycle_summary is written)
    const liveStats = db.prepare(`
      SELECT
        COUNT(*) as total_api_calls,
        COALESCE(SUM(latency_ms), 0) as total_api_ms,
        COALESCE(SUM(CASE WHEN step LIKE '%poll%' THEN latency_ms ELSE 0 END), 0) as total_poll_ms,
        COALESCE(SUM(secondary_rate_limit_hit), 0) as total_rl_hits
      FROM step_results
      WHERE run_id = ? AND http_method != 'SIM'
    `).get(runId);

    const steps = db.prepare(`
      SELECT step, profile, http_method,
        COUNT(*) as count,
        AVG(latency_ms) as avg_ms,
        MIN(latency_ms) as min_ms,
        MAX(latency_ms) as max_ms,
        AVG(CASE WHEN http_method != 'SIM' THEN latency_ms END) as avg_api_ms
      FROM step_results
      WHERE run_id = ? AND http_method != 'SIM'
      GROUP BY step, profile
      ORDER BY profile, step
    `).all(runId);

    const stepLatencies = db.prepare(`
      SELECT step, profile, latency_ms, http_status, concurrency_level, phase, http_method
      FROM step_results
      WHERE run_id = ?
      ORDER BY start_ts
    `).all(runId);

    const rateLimits = db.prepare(`
      SELECT step, rate_limit_remaining, rate_limit_used, start_ts
      FROM step_results
      WHERE run_id = ? AND rate_limit_remaining IS NOT NULL
      ORDER BY start_ts
    `).all(runId);

    const errors = db.prepare(`
      SELECT step, profile, http_status, error, cycle_id
      FROM step_results
      WHERE run_id = ? AND error IS NOT NULL AND http_method != 'SIM'
      ORDER BY start_ts
    `).all(runId);

    db.close();
    return NextResponse.json({ run, cycles, steps, stepLatencies, rateLimits, errors, liveStats });
  } catch {
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  try {
    const db = getDbWrite();
    db.prepare("DELETE FROM step_results WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM cycle_summary WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
    db.close();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const body = await req.json();

  try {
    const db = getDbWrite();
    if (body.status) {
      db.prepare("UPDATE runs SET status = ?, finished_at = datetime('now') WHERE run_id = ?")
        .run(body.status, runId);
    }
    db.close();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }
}
