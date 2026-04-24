import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";

export async function POST(req: NextRequest) {
  const body = await req.json();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
    GITHUB_ORG: process.env.GITHUB_ORG || "",
    GITHUB_REPO: process.env.GITHUB_REPO || "",
    TOTAL_CYCLES: String(body.totalCycles || 4),
    SEQUENTIAL_CYCLES: String(body.sequentialCycles || 2),
    MAX_CONCURRENCY: String(body.maxConcurrency || 3),
    PCT_AMBER: String(body.pctAmber ?? 60),
    PCT_AMBER_OPT: String(body.pctAmberOpt ?? 0),
    PCT_HUMAN: String(body.pctHuman ?? 0),
    PCT_DEPENDABOT: String(body.pctDependabot ?? 40),
    PCT_MERGIFY: String(body.pctMergify ?? 0),
    RUN_NAME: body.runName || "",
  };

  if (body.runId) {
    env.RUN_ID = body.runId;
  }

  const benchmarkDir = path.resolve(process.cwd(), "..");

  const child = spawn("uv", ["run", "python", "benchmark.py"], {
    cwd: benchmarkDir,
    env,
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  return NextResponse.json({
    status: "launched",
    pid: child.pid,
    runId: env.RUN_ID || "(auto-generated)",
  });
}
