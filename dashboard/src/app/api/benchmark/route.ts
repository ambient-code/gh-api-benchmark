import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import path from "path";

const benchmarkDir = path.resolve(process.cwd(), "..");

// Load .env from project root once at module init
try {
  const content = readFileSync(path.join(benchmarkDir, ".env"), "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — rely on process env
}

export async function POST(req: NextRequest) {
  const missing = ["GITHUB_TOKEN", "GITHUB_ORG", "GITHUB_REPO"].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing server environment variables: ${missing.join(", ")}. Start the dashboard with these set.` },
      { status: 400 }
    );
  }

  const body = await req.json();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
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

  const child = spawn("uv", ["run", "python", "benchmark.py"], {
    cwd: benchmarkDir,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });

  const result = await new Promise<{ ok: boolean; error?: string; pid?: number }>((resolve) => {
    let stderr = "";
    let resolved = false;
    const done = (r: { ok: boolean; error?: string; pid?: number }) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      done({ ok: false, error: err.message });
    });

    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        done({ ok: false, error: stderr || `Process exited with code ${code}` });
      }
    });

    setTimeout(() => {
      child.stderr!.destroy();
      child.unref();
      done({ ok: true, pid: child.pid });
    }, 2000);
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    status: "launched",
    pid: result.pid,
    runId: env.RUN_ID || "(auto-generated)",
  });
}
