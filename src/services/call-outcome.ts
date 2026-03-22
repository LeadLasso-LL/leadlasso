/**
 * Pure rules for whether an inbound LeadLasso voice leg should trigger missed-call follow-up.
 * Decisions use only Twilio terminal callback fields (CallStatus, CallDuration, AnsweredBy).
 */

/** Status values where Twilio will not send further updates for this leg. */
export const TERMINAL_CALL_STATUSES = new Set([
  'completed',
  'no-answer',
  'busy',
  'failed',
  'canceled',
]);

export function isTerminalCallStatus(callStatus: string | undefined | null): boolean {
  if (!callStatus) return false;
  return TERMINAL_CALL_STATUSES.has(String(callStatus).trim().toLowerCase());
}

export function parseCallDurationSeconds(raw: unknown): number {
  const n = parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Twilio AMD: machine_*, fax → treat as voicemail / not meaningfully handled live. */
export function answeredByIndicatesMachine(answeredBy: string | undefined | null): boolean {
  if (answeredBy == null || typeof answeredBy !== 'string') return false;
  const a = answeredBy.trim().toLowerCase();
  if (a === 'fax') return true;
  return a.startsWith('machine');
}

export type MissedCallFollowUpEvaluation =
  | { action: 'follow-up'; reason: 'no-answer/busy/failed/canceled' | 'short completed call <10s' | 'machine/voicemail' }
  | { action: 'handled' }
  | { action: 'ignore' };

/**
 * Apply product rules (terminal states only — caller must gate on isTerminalCallStatus).
 */
export function evaluateMissedCallFollowUp(params: {
  callStatus: string;
  callDurationSeconds: number;
  answeredBy?: string | null;
}): MissedCallFollowUpEvaluation {
  const s = String(params.callStatus || '').trim().toLowerCase();

  if (s === 'no-answer' || s === 'busy' || s === 'failed' || s === 'canceled') {
    return { action: 'follow-up', reason: 'no-answer/busy/failed/canceled' };
  }

  if (s === 'completed') {
    if (answeredByIndicatesMachine(params.answeredBy)) {
      return { action: 'follow-up', reason: 'machine/voicemail' };
    }
    if (params.callDurationSeconds >= 10) {
      return { action: 'handled' };
    }
    return { action: 'follow-up', reason: 'short completed call <10s' };
  }

  return { action: 'ignore' };
}
