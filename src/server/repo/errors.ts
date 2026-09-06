/**
 * Conflict signalling shared by the repos. DynamoDB refuses a conditional
 * transaction with `TransactionCanceledException`; MemoryRepo throws an error
 * of the same name, so the service layer handles both stores identically.
 *
 * A refused `HASH#…` item (the same replay already on the board) is reported
 * as `DuplicateReplayError` instead, carrying the owner of the stored copy so
 * the service can tell a thief from a player re-sending their own run.
 */
export const SAVE_CONFLICT = 'TransactionCanceledException';
export const DUPLICATE_REPLAY = 'DuplicateReplayError';
export const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

export class SaveConflictError extends Error {
  constructor(message = 'save-conflict') {
    super(message);
    this.name = SAVE_CONFLICT;
  }
}

export class DuplicateReplayError extends Error {
  constructor(
    /** Run that already carries this replay, when known. */
    public readonly runId?: string,
    /** Its owner, when known. */
    public readonly playerId?: string,
  ) {
    super('duplicate-replay');
    this.name = DUPLICATE_REPLAY;
  }
}

/** True for a conditional-write failure from either repo (concurrent submission of the same player). */
export function isSaveConflict(err: unknown): boolean {
  return err instanceof Error && err.name === SAVE_CONFLICT;
}

export function isDuplicateReplay(err: unknown): err is DuplicateReplayError {
  return err instanceof Error && err.name === DUPLICATE_REPLAY;
}

/** A single-item conditional write refused (DeleteCommand / UpdateCommand with a ConditionExpression). */
export function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === CONDITIONAL_CHECK_FAILED;
}

/** Which TransactItems entries a cancelled DynamoDB transaction blames (`ConditionalCheckFailed`). */
export function cancelledIndices(err: unknown): number[] {
  const reasons = (err as { CancellationReasons?: Array<{ Code?: string } | null> } | null)?.CancellationReasons;
  if (!Array.isArray(reasons)) return [];
  const out: number[] = [];
  reasons.forEach((r, i) => { if (r?.Code === 'ConditionalCheckFailed') out.push(i); });
  return out;
}
