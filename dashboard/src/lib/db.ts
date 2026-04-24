import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.resolve(
  process.env.BENCHMARK_DB_PATH || path.join(process.cwd(), "..", "benchmark_results.db")
);

export function getDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true });
}

export function getDbWrite(): Database.Database {
  return new Database(DB_PATH);
}
