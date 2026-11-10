import {
  clearAuditGenerationActive,
  fetchAuditPipelineStatus,
  markAuditGenerationActive,
  startServerAuditAnalysis,
  waitForServerAuditAnalysis,
} from './audit-pipeline-status';

const RESUME_LOCK_PREFIX = 'ecd-ai-resume-lock:';

function resumeLockKey(auditId: string) {
  return `${RESUME_LOCK_PREFIX}${auditId}`;
}

export function isAuditAiResumeInFlight(auditId: string): boolean {
  try {
    return sessionStorage.getItem(resumeLockKey(auditId)) === '1';
  } catch {
    return false;
  }
}

function setAuditAiResumeInFlight(auditId: string, inFlight: boolean) {
  try {
    if (inFlight) sessionStorage.setItem(resumeLockKey(auditId), '1');
    else sessionStorage.removeItem(resumeLockKey(auditId));
  } catch {
    // ignore
  }
}

export type ResumeAuditProgress = {
  label: string;
  progress: number;
};

/** Ensures server-side AI analysis runs (safe to call with tab closed after kick-off). */
export async function resumeAuditAnalysis(
  auditId: string,
  onProgress?: (update: ResumeAuditProgress) => void,
): Promise<void> {
  if (isAuditAiResumeInFlight(auditId)) return;

  const pipeline = await fetchAuditPipelineStatus(auditId);
  if (!pipeline.needsAiResume && !pipeline.aiJobFailed && pipeline.phase === 'complete') return;

  setAuditAiResumeInFlight(auditId, true);
  markAuditGenerationActive(auditId);

  try {
    if (pipeline.needsAiResume || pipeline.aiJobFailed) {
      await startServerAuditAnalysis(auditId);
    }

    await waitForServerAuditAnalysis(auditId, {
      onUpdate: (label, progress) => onProgress?.({ label, progress }),
    });
    clearAuditGenerationActive(auditId);
  } finally {
    setAuditAiResumeInFlight(auditId, false);
  }
}
