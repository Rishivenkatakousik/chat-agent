/**
 * The app's single SQLite database (built-in `node:sqlite`, one file, no server).
 *
 *   const db = openDatabase(":memory:");
 *   db.conversations.create({ timezone: "UTC" });
 *   db.messages.append({ ... });
 *   db.facts.search(...);
 *
 * Each table has its own store class; this file only opens the connection and wires them up.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { ConversationStore } from "./conversations.js";
import { FactStore } from "./facts.js";
import { MessageStore } from "./messages.js";
import { createSchema } from "./schema.js";
import { runInTransaction } from "./sql.js";

const IN_MEMORY = ":memory:";

export class Database {
  /** The raw connection, for the rare query no store covers (tests use it to inspect tables). */
  readonly connection: DatabaseSync;
  readonly conversations: ConversationStore;
  readonly messages: MessageStore;
  readonly facts: FactStore;

  constructor(path: string) {
    if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });

    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    createSchema(this.connection);

    this.conversations = new ConversationStore(this.connection);
    this.messages = new MessageStore(this.connection);
    this.facts = new FactStore(this.connection);
  }

  /** Runs `work` atomically. Store methods called inside join the same transaction. */
  transaction<T>(work: () => T): T {
    return runInTransaction(this.connection, work);
  }

  close(): void {
    this.connection.close();
  }
}

/** Opens (and creates, if needed) a database file. Pass ":memory:" for a throwaway one in tests. */
export function openDatabase(path: string = config.dbPath): Database {
  return new Database(path);
}

let shared: Database | undefined;

/** The process-wide database at `config.dbPath`, opened on first use. */
export function getDatabase(): Database {
  shared ??= openDatabase();
  return shared;
}
