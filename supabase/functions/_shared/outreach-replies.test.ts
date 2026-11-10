import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyReply, pendingReplies, quickVerdict, replyAction, staleClaimDecision, UNSORTED } from "./outreach-replies.ts";

Deno.test("the obvious replies are sorted without a model", () => {
  assertEquals(quickVerdict("No.")?.kind, "not_interested");
  assertEquals(quickVerdict("no thanks")?.kind, "not_interested");
  assertEquals(quickVerdict("Unsubscribe")?.kind, "unsubscribe");
  assertEquals(quickVerdict("I'm away until Monday", "Automatic reply: Your homepage")?.kind, "out_of_office");
  assertEquals(quickVerdict("No, but send me the full audit"), null);
});

Deno.test("an empty reply is unsorted, never a silent pass", async () => {
  const v = await classifyReply("   ", "Re: your homepage");
  assertEquals(v.unsorted, true);
  assertEquals(replyAction(v, false), { action: "stop", alert: true });
  // Even with machine headers: unsorted always stops and alerts.
  assertEquals(replyAction(v, true), { action: "stop", alert: true });
});

Deno.test("only an away message, or a machine 'other', lets the sequence carry on", () => {
  assertEquals(replyAction(UNSORTED, false).action, "stop");
  assertEquals(replyAction({ kind: "out_of_office", summary: "" }, false), { action: "pass", alert: false });
  assertEquals(replyAction({ kind: "other", summary: "" }, false), { action: "stop", alert: true });
  assertEquals(replyAction({ kind: "other", summary: "" }, true), { action: "pass", alert: false });
  assertEquals(replyAction({ kind: "not_interested", summary: "" }, false).action, "suppress");
  assertEquals(replyAction({ kind: "unsubscribe", summary: "" }, true).action, "suppress");
  assertEquals(replyAction({ kind: "interested", summary: "" }, false), { action: "stop", alert: true });
  assertEquals(replyAction({ kind: "not_now", summary: "" }, false), { action: "stop", alert: true });
});

Deno.test("every new message is read, oldest first, capped per run", () => {
  const seqs = [10, 11, 12, 13, 14, 15, 16, 17];
  assertEquals(pendingReplies(seqs, 0, 5), [10, 11, 12, 13, 14]);
  assertEquals(pendingReplies(seqs, 5, 5), [15, 16, 17]);
  assertEquals(pendingReplies(seqs, 8, 5), []);
  assertEquals(pendingReplies([4, 9], 1, 5), [9]);
});

Deno.test("a stale send claim is released only when the mailbox shows nothing", () => {
  assertEquals(staleClaimDecision({ sentLogged: true, inMailbox: null }), "mark_sent");
  assertEquals(staleClaimDecision({ sentLogged: false, inMailbox: true }), "mark_sent");
  assertEquals(staleClaimDecision({ sentLogged: false, inMailbox: false }), "release");
  assertEquals(staleClaimDecision({ sentLogged: false, inMailbox: null }), "wait");
});
