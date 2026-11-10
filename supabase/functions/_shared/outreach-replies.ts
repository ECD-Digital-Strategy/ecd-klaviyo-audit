import { createLlmClient } from "./llm-adapter.ts";

// What a prospect's reply means (Outreach, 2026-11-02), so the autopilot can act
// on it: alert Emil to the ones worth answering, stop and remember the ones that
// said no, and let an out-of-office pass without ending the sequence.

export const REPLY_KINDS = [
  "interested", // wants to talk, asks for a call or the full audit
  "question", // asks something (price, who we are, how it works)
  "referral", // "talk to my colleague X", or forwards it on
  "not_now", // maybe later, busy season, already have an agency for now
  "not_interested", // no thanks, the "no" the P.S. asks for, or angry
  "unsubscribe", // remove me, stop emailing
  "out_of_office", // an automatic away reply
  "other", // anything else (a receipt, a support autoresponder)
] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

/** Replies that end contact for good: the domain goes on the do-not-contact list. */
export const SUPPRESSING: ReadonlySet<ReplyKind> = new Set(["not_interested", "unsubscribe"]);
/** Replies Emil should see straight away. */
export const ALERTING: ReadonlySet<ReplyKind> = new Set(["interested", "question", "referral", "not_now"]);
/** Replies that are not a person answering, so the sequence carries on. Only an
 * away message: anything else stops the sequence (fail safe, audit 2026-11-10). */
export const PASSING: ReadonlySet<ReplyKind> = new Set(["out_of_office"]);

/** unsorted: no verdict could be reached (empty, model silent, unknown kind). */
export type ReplyVerdict = { kind: ReplyKind; summary: string; unsorted?: boolean };

export const UNSORTED: ReplyVerdict = { kind: "other", summary: "Could not be sorted automatically; read it in Gmail.", unsorted: true };

/** What to do with one new message. */
export type ReplyAction = { action: "pass" | "stop" | "suppress"; alert: boolean };

/**
 * The decision for a verdict. Only an away message, or a model-chosen "other"
 * that carries auto-reply headers, lets the sequence carry on. Unsorted mail
 * stops it and alerts Emil.
 */
export function replyAction(v: ReplyVerdict, autoReply: boolean): ReplyAction {
  if (v.unsorted) return { action: "stop", alert: true };
  if (PASSING.has(v.kind)) return { action: "pass", alert: false };
  if (v.kind === "other") return autoReply ? { action: "pass", alert: false } : { action: "stop", alert: true };
  if (SUPPRESSING.has(v.kind)) return { action: "suppress", alert: false };
  return { action: "stop", alert: ALERTING.has(v.kind) };
}

/** Message numbers still to read: past the ones already seen, oldest first, at most cap. */
export function pendingReplies(seqs: number[], seen: number, cap: number): number[] {
  return seqs.slice(Math.max(0, seen), Math.max(0, seen) + cap);
}

/**
 * A first email claimed (sent_at set) by a run that died before marking it sent.
 * Sent if the send log or the mailbox shows it went; released only when the
 * mailbox was read and shows nothing; otherwise left for the next run.
 */
export function staleClaimDecision(c: { sentLogged: boolean; inMailbox: boolean | null }): "mark_sent" | "release" | "wait" {
  if (c.sentLogged || c.inMailbox === true) return "mark_sent";
  return c.inMailbox === false ? "release" : "wait";
}

const SYSTEM = [
  "You sort replies to a short cold email. Emil, from an ecommerce agency, emailed a Shopify brand a free preview",
  "of an audit of their website and offered a 20-minute walkthrough. The email ended: P.S. Not relevant? Just",
  "reply \"no\" and I won't email again.",
  "Pick the one kind that fits the reply best, and write a one-sentence summary for Emil in plain words",
  "(no dashes). A bare \"no\", \"no thanks\" or \"not interested\" is not_interested. \"Remove me\", \"stop\" or",
  "\"unsubscribe\" is unsubscribe. An automatic away message is out_of_office even when it names someone else",
  "to contact. A support desk autoresponder or ticket receipt is other.",
].join(" ");

/** Cheap rules first: the obvious ones need no model. */
export function quickVerdict(text: string, subject = ""): ReplyVerdict | null {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/g, "");
  if (/^(no|nope|no thanks?|no thank you|not interested|pass)$/.test(t)) return { kind: "not_interested", summary: "Said no." };
  if (/^(unsubscribe|remove me|stop|please remove me)$/.test(t)) return { kind: "unsubscribe", summary: "Asked to be removed." };
  if (/^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office)/i.test(subject.trim())) {
    return { kind: "out_of_office", summary: "Automatic away reply." };
  }
  return null;
}

export async function classifyReply(text: string, subject: string): Promise<ReplyVerdict> {
  const quick = quickVerdict(text, subject);
  if (quick) return quick;
  if (!text.trim()) return { ...UNSORTED, summary: "An empty reply, or one that could not be read; read it in Gmail." };
  const llm = createLlmClient("anthropic", { model: "claude-sonnet-5-5" });
  const turn = await llm.runTurn({
    system: SYSTEM,
    messages: [{ role: "user", text: `Subject: ${subject}\n\n${text.slice(0, 4000)}` }],
    tools: [{
      name: "verdict",
      description: "What the reply means.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...REPLY_KINDS] },
          summary: { type: "string", description: "One sentence for Emil." },
        },
        required: ["kind", "summary"],
      },
    }],
    toolChoice: { type: "tool", name: "verdict" },
  });
  if (turn.kind !== "tool_call") return UNSORTED;
  const input = turn.input as { kind?: string; summary?: string };
  if (!(REPLY_KINDS as readonly string[]).includes(String(input.kind))) return UNSORTED;
  return { kind: input.kind as ReplyKind, summary: String(input.summary ?? "").replace(/\s*[–—]\s*/g, ", ").slice(0, 300) };
}
