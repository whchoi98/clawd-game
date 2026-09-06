/**
 * Conflict signalling shared by the repos. DynamoDB refuses a conditional
 * transaction with `TransactionCanceledException`; MemoryRepo throws an error
 * of the same name, so the service layer handles both stores identically.
 */
export const SAVE_CONFLICT = 'TransactionCanceledException';

export class SaveConflictError extends Error {
  constructor(message = 'save-conflict') {
    super(message);
    this.name = SAVE_CONFLICT;
  }
}

/** True for a conditional-write failure from either repo (concurrent submission of the same player). */
export function isSaveConflict(err: unknown): boolean {
  return err instanceof Error && err.name === SAVE_CONFLICT;
}
