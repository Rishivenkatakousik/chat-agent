/**
 * Reads and writes the `facts` table: structured, checkable claims taken from past answers
 * ("Neon · Launch plan price · $19/mo · observed 3 Nov"), so "has it changed?" can compare
 * field by field. Facts are written by background enrichment and read by memory recall.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Fact, FactInput, RankedFact, TimeWindow } from "../types.js";
import { nullableString, placeholders, queryAll, runInTransaction, windowClause, type Row } from "./sql.js";

export interface NewFacts {
  conversationId: string;
  /** The answer the facts were taken from. */
  messageId: number | null;
  observedAt?: number;
  facts: FactInput[];
}

function toFact(row: Row): Fact {
  return {
    id: Number(row.id),
    conversation_id: String(row.conversation_id),
    message_id: row.message_id == null ? null : Number(row.message_id),
    entity: String(row.entity),
    attribute: String(row.attribute),
    value: String(row.value),
    source_url: nullableString(row.source_url),
    observed_at: Number(row.observed_at),
  };
}

export class FactStore {
  private readonly connection: DatabaseSync;

  constructor(connection: DatabaseSync) {
    this.connection = connection;
  }

  /** Stores the facts in one transaction. Returns how many were stored. */
  insert(input: NewFacts): number {
    if (input.facts.length === 0) return 0;

    const observedAt = input.observedAt ?? Date.now();
    const statement = this.connection.prepare(
      `INSERT INTO facts (conversation_id, message_id, entity, attribute, value, source_url, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    return runInTransaction(this.connection, () => {
      for (const fact of input.facts) {
        statement.run(
          input.conversationId,
          input.messageId,
          fact.entity,
          fact.attribute,
          fact.value,
          fact.source_url ?? null,
          observedAt,
        );
      }
      return input.facts.length;
    });
  }

  /** Facts recorded with these answers, oldest first. */
  listForMessages(messageIds: readonly number[]): Fact[] {
    if (messageIds.length === 0) return [];
    const rows = queryAll(
      this.connection,
      `SELECT * FROM facts
       WHERE message_id IN (${placeholders(messageIds.length)})
       ORDER BY observed_at, id`,
      ...messageIds,
    );
    return rows.map(toFact);
  }

  /** BM25 full-text search over entity, attribute and value, optionally inside a time window. */
  search(match: string, window?: TimeWindow, limit = 30): RankedFact[] {
    const timeFilter = windowClause("f.observed_at", window);
    const rows = queryAll(
      this.connection,
      `SELECT f.*, bm25(facts_fts) AS rank
       FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
       WHERE facts_fts MATCH ?${timeFilter.sql}
       ORDER BY rank
       LIMIT ?`,
      match,
      ...timeFilter.params,
      limit,
    );
    return rows.map((row) => ({ ...toFact(row), rank: Number(row.rank) }));
  }
}
