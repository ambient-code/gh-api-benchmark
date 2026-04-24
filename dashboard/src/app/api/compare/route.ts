import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  const runIds = req.nextUrl.searchParams.getAll("run");
  if (runIds.length < 2) {
    return NextResponse.json({ error: "Need at least 2 run IDs" }, { status: 400 });
  }

  try {
    const db = getDb();
    const placeholders = runIds.map(() => "?").join(",");

    const runs = db.prepare(
      `SELECT * FROM runs WHERE run_id IN (${placeholders})`
    ).all(...runIds);

    const stepStats = db.prepare(`
      SELECT run_id, step, profile,
        COUNT(*) as count,
        AVG(latency_ms) as avg_ms,
        MIN(latency_ms) as min_ms,
        MAX(latency_ms) as max_ms
      FROM step_results
      WHERE run_id IN (${placeholders}) AND http_method != 'SIM'
      GROUP BY run_id, step, profile
      ORDER BY run_id, profile, step
    `).all(...runIds);

    const cycleSummaries = db.prepare(`
      SELECT run_id, profile, phase,
        COUNT(*) as cycles,
        AVG(total_api_ms) as avg_api_ms,
        AVG(total_wall_ms) as avg_wall_ms,
        SUM(api_call_count) as total_api_calls,
        SUM(rate_limit_hits) as total_rl_hits
      FROM cycle_summary
      WHERE run_id IN (${placeholders})
      GROUP BY run_id, profile, phase
    `).all(...runIds);

    db.close();
    return NextResponse.json({ runs, stepStats, cycleSummaries });
  } catch {
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }
}
