/**
 * The shared OpenAI client, plus how OpenAI errors are explained to users and written to logs.
 * The agent loop, background enrichment and embeddings all get their client from here.
 */
import OpenAI, { APIError, APIUserAbortError } from "openai";
import { config } from "../config.js";

/** The part of the OpenAI client the app calls. Tests pass a fake with this shape. */
export type ResponsesClient = Pick<OpenAI, "responses">;

const MAX_RETRIES = 2;
const TIMEOUT_MS = 90_000;

let client: OpenAI | undefined;

/** The process-wide OpenAI client, created on first use. */
export function getOpenAI(): OpenAI {
  client ??= new OpenAI({ apiKey: config.openaiApiKey, maxRetries: MAX_RETRIES, timeout: TIMEOUT_MS });
  return client;
}

/** An error whose message was written for the user and is safe to show in the UI. */
export class UserFacingError extends Error {}

/** A user-facing message for a failure. Details go to the server log instead. */
export function friendlyError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof APIUserAbortError) return "Request cancelled.";

  if (error instanceof APIError) {
    const status = error.status;
    if (status === 401) return "The OpenAI API key was rejected. Check OPENAI_API_KEY in .env.";
    if (status === 404) {
      return `The model "${config.chatModel}" is not available to this API key. Set OPENAI_MODEL in .env.`;
    }
    if (status === 429) return "OpenAI rate limit or quota reached. Wait a moment and try again.";
    if (status && status >= 500) return "OpenAI is having trouble right now. Please try again.";
    return `OpenAI error: ${error.message}`;
  }

  // Anything else (a database error, a bug) may carry internal details: keep those in the log.
  return "Something went wrong on the server. The server log has the details.";
}

/** One-line log form of an error: HTTP status, message and API request id. Never headers or cookies. */
export function describeErrorForLog(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const details = error as Error & { status?: number; requestID?: string };
  const parts = [
    details.status ? `HTTP ${details.status}` : null,
    details.message,
    details.requestID ? `(request ${details.requestID})` : null,
  ];
  return parts.filter(Boolean).join(" ");
}
