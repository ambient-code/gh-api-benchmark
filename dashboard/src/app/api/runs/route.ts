import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    const db = getDb();
    const runs = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM cycle_summary WHERE run_id = r.run_id) as cycle_count,
        (SELECT COALESCE(SUM(api_call_count), 0) FROM cycle_summary WHERE run_id = r.run_id) as total_api_calls,
        (SELECT COALESCE(SUM(total_api_ms), 0) FROM cycle_summary WHERE run_id = r.run_id) as total_api_ms,
        (SELECT COALESCE(SUM(rate_limit_hits), 0) FROM cycle_summary WHERE run_id = r.run_id) as total_rl_hits
      FROM runs r ORDER BY r.started_at DESC
    `).all();
    db.close();
    return NextResponse.json(runs);
  } catch {
    return NextResponse.json([]);
  }
}
