/**
 * Small helpers shared by the stores: running queries, transactions, and building safe SQL
 * fragments (time-window filters and FTS5 search expressions).
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { TimeWindow } from "../types.js";

/** One result row as SQLite returns it; the stores map rows to typed objects. */
export type Row = Record<string, unknown>;

export function queryAll(connection: DatabaseSync, sql: string, ...params: SQLInputValue[]): Row[] {
  return connection.prepare(sql).all(...params) as Row[];
}

export function queryOne(connection: DatabaseSync, sql: string, ...params: SQLInputValue[]): Row | undefined {
  return connection.prepare(sql).get(...params) as Row | undefined;
}

/** Runs `work` atomically. Reentrant: a nested call joins the outer transaction. */
export function runInTransaction<T>(connection: DatabaseSync, work: () => T): T {
  if (connection.isTransaction) return work();

  connection.exec("BEGIN");
  try {
    const result = work();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

/** "?, ?, ?" for an `IN (...)` list of `count` values. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** SQL fragment + params that restrict a time column to an optional window. */
export function windowClause(column: string, window?: TimeWindow): { sql: string; params: SQLInputValue[] } {
  if (!window) return { sql: "", params: [] };
  return { sql: ` AND ${column} >= ? AND ${column} < ?`, params: [window.start, window.end] };
}

/**
 * Builds a safe FTS5 MATCH expression: each term is quoted (so punctuation and keywords like
 * AND/NEAR can't break the syntax) and the terms are OR-ed together.
 * Returns null when there is nothing to search for.
 */
export function toFtsQuery(terms: readonly string[]): string | null {
  const quoted = terms
    .map((term) => term.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((term) => `"${term}"`);
  return quoted.length > 0 ? quoted.join(" OR ") : null;
}

/** A nullable TEXT column as `string | null`. */
export function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
