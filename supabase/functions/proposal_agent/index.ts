import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, requireStaffUserId } from "../_shared/auth.ts";
import { hubStaffUserId } from "../_shared/hub-caller.ts";
import { createLlmClient, type LlmMessage } from "../_shared/llm-adapter.ts";
import { attachmentTurn } from "../_shared/chat-attachments.ts";
import { fetchGoogleDoc } from "../_shared/fetch-google-doc.ts";
import { fetchFirefliesTranscript } from "../_shared/fetch-fireflies-transcript.ts";
import { buildSystemPrompt, type AgentSnapshot } from "./prompt.ts";
import { AGENT_TOOLS, TERMINAL_TOOLS } from "./tools.ts";
import {
  deepSanitize,
  isEmptyEditSet,
  sanitizeCopy,
  stripInternalNotes,
  validateDraft,
  validateEditSet,
  validateQuestion,
} from "./validate.ts";
import { buildClientDossier, fetchClientHistory } from "./dossier.ts";
import { applyContractEdits, type ContractEdit } from "../_shared/contract-edits.ts";
import { readMemory, readVoiceProfile, scheduleMemoryUpdate } from "../_shared/agent-memory.ts";

const MAX_TOOL_ITERATIONS = 6;
// The edge runtime kills an invocation at 150s and the browser sees only "non-2xx
// status code". One model turn can take up to 110s, so past this point we stop
// starting new turns and say so, which is a better answer than a 504.
const TURN_BUDGET_MS = 100_000;
const HISTORY_LIMIT = 30;
const DOC_CONTENT_CHAR_CAP = 24_000;

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
    ...init,
  });
}

type AgentAttachment = { url: string; name: string; media_type: string; size?: number };

type RequestBody = {
  conversation_id?: string;
  proposal_id?: string;
  client_id?: string;
  message?: string;
  attachments?: AgentAttachment[];
  snapshot?: AgentSnapshot;
  provider?: string;
};

type MessageRow = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  payload: any;
  payload_kind: string | null;
  actor_user_id: string | null;
  attachments: AgentAttachment[] | null;
  created_at: string;
};

const ATTACH_FALLBACK_TEXT = "Please review the attached file(s) and use them as source material.";

function historyToLlmMessages(rows: MessageRow[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      const atts = Array.isArray(row.attachments) ? row.attachments : [];
      out.push(...attachmentTurn(row.content, atts, ATTACH_FALLBACK_TEXT));
    } else if (row.role === "assistant") {
      // Use only the stored assistant text. Do NOT append bracketed recaps of
      // the question/draft/edits payload: the model was echoing those notes
      // verbatim into its replies and imitating them by asking questions in
      // prose instead of calling the ask_user tool (which renders the chips).
      const text = (row.content || "").trim();
      if (text) out.push({ role: "assistant", text });
    } else if (row.role === "tool") {
      // Keep fetched document / transcript content available across turns; keep catalog results compact.
      if (row.payload_kind === "doc_fetch" && row.payload?.ok && row.payload?.content) {
        out.push({
          role: "user",
          text: `[Source content fetched earlier in this conversation]\n${row.payload.content}`,
        });
      }
    }
  }
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  let uid: string;
  try {
    // Athena's ECD Hub connector calls for a signed-in staff member by email
    // (_shared/hub-caller.ts); everyone else signs in here as before. Past this
    // line both run the same assistant, rules and all.
    uid = (await hubStaffUserId(req, "proposals")) ?? (await requireStaffUserId(req, "proposals"));
  } catch (e) {
    return json(
      { ok: false, error: { code: "unauthorized", message: e instanceof Error ? e.message : "Unauthorized" } },
      { status: 200 },
    );
  }

  try {
    const body = (await req.json()) as RequestBody;
    const message = (body.message ?? "").trim();
    const attachments = (Array.isArray(body.attachments) ? body.attachments : []).filter(
      (a) => a && typeof a.url === "string" && a.url,
    );
    if (!message && attachments.length === 0) {
      return json({ ok: false, error: { code: "bad_request", message: "Missing message" } }, { status: 200 });
    }

    const sb = assertServiceRoleClient();

    // --- Load or create the conversation -----------------------------------
    let conversationId = body.conversation_id ?? null;
    let conversationWasCreated = false;
    if (!conversationId && body.proposal_id) {
      const { data } = await sb
        .from("proposal_agent_conversations")
        .select("id")
        .eq("proposal_id", body.proposal_id)
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      conversationId = data?.id ?? null;
    }
    if (!conversationId) {
      const { data, error } = await sb
        .from("proposal_agent_conversations")
        .insert({
          proposal_id: body.proposal_id ?? null,
          client_id: body.client_id ?? null,
          title: (message || attachments[0]?.name || "New proposal chat").slice(0, 80),
          created_by: uid,
        })
        .select("id")
        .single();
      if (error) throw error;
      conversationId = data.id as string;
      conversationWasCreated = true;
    }

    // --- Persist the user message + load history ---------------------------
    const { error: userInsertErr } = await sb.from("proposal_agent_messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: message,
      actor_user_id: uid,
      attachments,
    });
    if (userInsertErr) throw userInsertErr;

    const { data: historyRows, error: historyErr } = await sb
      .from("proposal_agent_messages")
      .select("id, role, content, payload, payload_kind, actor_user_id, attachments, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (historyErr) throw historyErr;
    const rows = ((historyRows ?? []) as MessageRow[]).reverse();

    // --- Context: contracts list + mode -------------------------------------
    // Content is included so the assistant can rewrite a contract for a single
    // proposal (override_contract) rather than only attach or detach it.
    const { data: contractRows } = await sb
      .from("contract_documents")
      .select("slug, name, content")
      .eq("is_active", true)
      .order("display_order", { ascending: true });
    const contracts = (contractRows ?? []) as Array<{ slug: string; name: string; content?: string }>;

    const snapshot = body.snapshot ?? null;
    const mode: "draft" | "edit" = snapshot ? "edit" : "draft";
    const clientId = body.client_id ?? null;

    let clientCompanyName: string | null = null;
    if (!snapshot && clientId) {
      const { data: c } = await sb.from("clients").select("company_name").eq("id", clientId).maybeSingle();
      clientCompanyName = c?.company_name ?? null;
    }

    // Memory: live client dossier (structured data), the durable learned memory
    // for this client, and the house voice profile. All best-effort.
    const memoryScopeKey = clientId ? `proposal:client:${clientId}` : null;
    const [voiceProfile, dossier, clientMemory] = await Promise.all([
      readVoiceProfile(sb, "proposal_settings").catch(() => ""),
      clientId ? buildClientDossier(sb, clientId).catch(() => null) : Promise.resolve(null),
      readMemory(sb, memoryScopeKey).catch(() => ""),
    ]);

    const system = buildSystemPrompt({
      mode,
      snapshot,
      contracts,
      clientCompanyName,
      voiceProfile,
      dossier,
      memory: clientMemory,
    });
    const tools = AGENT_TOOLS.filter((t) => {
      if (t.name === "get_clients") return mode === "draft" && !clientId;
      if (t.name === "get_client_history") return Boolean(clientId);
      if (t.name === "propose_edits") return mode === "edit";
      return true;
    });

    const llm = createLlmClient(body.provider);
    // Build history from every prior row, then append the fresh user turn
    // explicitly so its attachments always reach the model (independent of the
    // select ordering / truncation). The last row is the message we just
    // inserted, so drop it before rendering history to avoid a duplicate.
    const priorRows =
      rows.length > 0 && rows[rows.length - 1].role === "user" ? rows.slice(0, -1) : rows;
    const messages: LlmMessage[] = historyToLlmMessages(priorRows);
    messages.push(...attachmentTurn(message, attachments, ATTACH_FALLBACK_TEXT));

    // --- Agent loop ----------------------------------------------------------
    let assistantText = "";
    let question: unknown = null;
    let draft: unknown = null;
    let edits: unknown = null;
    let retriedValidation = false;

    const loopStartedAt = Date.now();
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (i > 0 && Date.now() - loopStartedAt > TURN_BUDGET_MS) {
        assistantText =
          "That took longer than I am allowed in one go, so I stopped before making changes. Please send the request again, or split it into smaller steps.";
        break;
      }
      const turn = await llm.runTurn({ system, messages, tools });

      if (turn.kind === "text") {
        assistantText = stripInternalNotes(sanitizeCopy(turn.text));
        break;
      }

      if (!TERMINAL_TOOLS.has(turn.name)) {
        // Server-executed tool.
        let result: unknown;
        let payloadKind: string = "catalog";
        if (turn.name === "fetch_google_doc") {
          payloadKind = "doc_fetch";
          const url = (turn.input as { url?: string })?.url ?? "";
          const fetched = await fetchGoogleDoc(url);
          if (fetched.ok && fetched.content.length > DOC_CONTENT_CHAR_CAP) {
            result = { ...fetched, content: fetched.content.slice(0, DOC_CONTENT_CHAR_CAP), truncated: true };
          } else {
            result = fetched;
          }
        } else if (turn.name === "fetch_fireflies_transcript") {
          payloadKind = "doc_fetch";
          const url = (turn.input as { url?: string })?.url ?? "";
          const fetched = await fetchFirefliesTranscript(url);
          if (fetched.ok && fetched.content.length > DOC_CONTENT_CHAR_CAP) {
            result = { ...fetched, content: fetched.content.slice(0, DOC_CONTENT_CHAR_CAP), truncated: true };
          } else {
            result = fetched;
          }
        } else if (turn.name === "get_templates") {
          const { data } = await sb
            .from("proposal_templates")
            .select("name, content_blocks, default_line_items")
            .eq("is_active", true)
            .order("display_order", { ascending: true });
          result = (data ?? []).map((t: any) => ({
            name: t.name,
            section_titles: Array.isArray(t.content_blocks) ? t.content_blocks.map((b: any) => b?.title) : [],
            default_line_items: Array.isArray(t.default_line_items)
              ? t.default_line_items.map((li: any) => ({
                  name: li?.name,
                  description: li?.description,
                  one_time_price: li?.one_time_price ?? null,
                  one_time_label: li?.one_time_label ?? null,
                  monthly_price: li?.monthly_price ?? null,
                  monthly_label: li?.monthly_label ?? null,
                  content: typeof li?.content === "string" ? li.content.slice(0, 1500) : "",
                }))
              : [],
          }));
        } else if (turn.name === "search_proposals") {
          const q = String((turn.input as { query?: string })?.query ?? "").trim();
          const { data } = await sb
            .from("proposals")
            .select("id, title, status, created_at, proposal_number, client:clients(company_name)")
            .order("created_at", { ascending: false })
            .limit(200);
          const full = q.toLowerCase();
          const tokens = full.split(/\s+/).filter((t) => t.length > 1);
          const matches = (data ?? [])
            .map((p: any) => {
              const hay = `${p.title ?? ""} ${p.client?.company_name ?? ""}`.toLowerCase();
              let score = full && hay.includes(full) ? 100 : 0;
              for (const t of tokens) if (hay.includes(t)) score += 1;
              return { p, score };
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 8)
            .map((x) => ({
              id: x.p.id,
              title: x.p.title,
              client_company: x.p.client?.company_name ?? null,
              status: x.p.status,
              created_at: x.p.created_at,
            }));
          result = { matches };
        } else if (turn.name === "get_proposal") {
          const id = String((turn.input as { id?: string })?.id ?? "").trim();
          const { data: p } = await sb
            .from("proposals")
            .select(
              "id, title, status, content_blocks, include_contracts, contract_overrides, discount_type, discount_value, discount_applies_to, discount_label, client:clients(company_name), line_items:proposal_line_items(name, description, content, one_time_price, one_time_label, monthly_price, monthly_label, display_order)",
            )
            .eq("id", id)
            .maybeSingle();
          if (!p) {
            result = { error: "proposal_not_found" };
          } else {
            const blocks = Array.isArray((p as any).content_blocks) ? (p as any).content_blocks : [];
            const items = Array.isArray((p as any).line_items) ? [...(p as any).line_items] : [];
            items.sort((a: any, b: any) => (a?.display_order ?? 0) - (b?.display_order ?? 0));
            result = {
              title: (p as any).title,
              client_company: (p as any).client?.company_name ?? null,
              status: (p as any).status,
              content_blocks: blocks.map((b: any) => ({
                title: b?.title ?? "",
                content: typeof b?.content === "string" ? b.content.slice(0, 2500) : "",
              })),
              line_items: items.map((li: any) => ({
                name: li?.name,
                description: li?.description,
                content: typeof li?.content === "string" ? li.content.slice(0, 1500) : "",
                one_time_price: li?.one_time_price ?? null,
                one_time_label: li?.one_time_label ?? null,
                monthly_price: li?.monthly_price ?? null,
                monthly_label: li?.monthly_label ?? null,
              })),
              discount: {
                type: (p as any).discount_type,
                value: (p as any).discount_value,
                applies_to: (p as any).discount_applies_to,
                label: (p as any).discount_label ?? null,
              },
              include_contracts: Array.isArray((p as any).include_contracts) ? (p as any).include_contracts : [],
              // Which contracts already have wording tailored for this proposal,
              // so the assistant edits the current text instead of the catalog copy.
              contracts_overridden: Object.keys((p as any).contract_overrides ?? {}),
              contract_overrides: (p as any).contract_overrides ?? {},
            };
          }
        } else if (turn.name === "get_client_history") {
          result = clientId ? await fetchClientHistory(sb, clientId) : { error: "no_client" };
        } else if (turn.name === "get_contracts") {
          result = contracts;
        } else if (turn.name === "get_clients") {
          const { data, error } = await sb
            .from("clients")
            .select("id, company_name, name, website_url, email")
            .order("company_name", { ascending: true });
          if (error) throw error;
          result = (data ?? []).map((c: any) => ({
            id: c.id,
            company_name: c.company_name,
            contact_name: c.name ?? null,
            website_url: c.website_url ?? null,
            email: c.email ?? null,
          }));
        } else {
          result = { error: `Unknown tool ${turn.name}` };
        }

        const resultStr = JSON.stringify(result);
        await sb.from("proposal_agent_messages").insert({
          conversation_id: conversationId,
          role: "tool",
          content: turn.name,
          payload: result,
          payload_kind: payloadKind,
        });
        messages.push({ role: "assistant_tool_call", id: turn.id, name: turn.name, input: turn.input, text: turn.text, raw: turn.raw });
        messages.push({ role: "tool_result", id: turn.id, name: turn.name, result: resultStr });
        continue;
      }

      // Terminal tool: validate, sanitize, finish.
      let validation:
        | { ok: true; value: unknown }
        | { ok: false; error: string };
      if (turn.name === "ask_user") {
        validation = validateQuestion(turn.input);
      } else if (turn.name === "propose_draft") {
        validation = validateDraft(turn.input);
      } else {
        validation = validateEditSet(turn.input, {
          blockKeys: new Set((snapshot?.proposal.content_blocks ?? []).map((b) => b.key)),
          itemIds: new Set((snapshot?.line_items ?? []).map((li) => li.id)),
          contractSlugs: new Set(contracts.map((c) => c.slug)),
        });
      }

      if (!validation.ok) {
        if (retriedValidation) {
          // An edit set with no operations means the assistant concluded nothing
          // should change, which is a fair answer to "no, don't add it". Erroring
          // on it threw away a perfectly good reply and blocked the user, so when
          // there is something to say, say it and make no edits.
          if (turn.name === "propose_edits" && isEmptyEditSet(turn.input)) {
            const spoken = stripInternalNotes(sanitizeCopy(turn.text ?? "")).trim();
            if (spoken) {
              assistantText = spoken;
              break;
            }
          }
          // Keep the payload that failed twice: without it, diagnosing this meant
          // inferring from the error string alone.
          console.error(
            `proposal_agent: ${turn.name} failed validation twice (${validation.error}); payload=${
              JSON.stringify(turn.input ?? null).slice(0, 1500)
            }`,
          );
          return json(
            { ok: false, error: { code: "bad_response", message: `The assistant produced an invalid ${turn.name} payload: ${validation.error}` } },
            { status: 200 },
          );
        }
        retriedValidation = true;
        messages.push({ role: "assistant_tool_call", id: turn.id, name: turn.name, input: turn.input, text: turn.text, raw: turn.raw });
        messages.push({
          role: "tool_result",
          id: turn.id,
          name: turn.name,
          result: JSON.stringify({ error: `Invalid input: ${validation.error}. Fix the payload and call ${turn.name} again.` }),
        });
        continue;
      }

      // Redlines become the full contract text here, so the app keeps receiving
      // the one shape it knows (contract_content). A quote the model got wrong
      // goes back to it as a validation error rather than silently mis-editing
      // a legal document.
      if (turn.name === "propose_edits") {
        const ops = ((validation.value as { operations?: Array<Record<string, unknown>> }).operations ?? []);
        // The stored overrides are the authority for what a redline edits: a
        // contract already tailored for this proposal must be edited from that
        // text, not from the shared version, or the earlier changes vanish.
        let overrides: Record<string, string> = {};
        if (body.proposal_id) {
          const { data: pRow } = await sb.from("proposals").select("contract_overrides").eq("id", body.proposal_id).maybeSingle();
          overrides = ((pRow as { contract_overrides?: Record<string, string> } | null)?.contract_overrides) ?? {};
        }
        let redlineError: string | null = null;
        for (const op of ops) {
          if (op.op !== "override_contract" || !Array.isArray(op.contract_edits)) continue;
          const slug = String(op.slug);
          const base = overrides[slug] ?? contracts.find((c) => c.slug === slug)?.content ?? "";
          if (!base.trim()) { redlineError = `the ${slug} contract has no text to edit`; break; }
          const applied = applyContractEdits(base, op.contract_edits as ContractEdit[]);
          if (!applied.ok) { redlineError = applied.error; break; }
          op.contract_content = applied.content;
          delete op.contract_edits;
        }
        if (redlineError) {
          if (retriedValidation) {
            console.error(`proposal_agent: contract redlines failed twice (${redlineError})`);
            return json(
              { ok: false, error: { code: "bad_response", message: `I could not apply the contract redlines: ${redlineError}` } },
              { status: 200 },
            );
          }
          retriedValidation = true;
          messages.push({ role: "assistant_tool_call", id: turn.id, name: turn.name, input: turn.input, text: turn.text, raw: turn.raw });
          messages.push({
            role: "tool_result",
            id: turn.id,
            name: turn.name,
            result: JSON.stringify({ error: `Invalid contract_edits: ${redlineError}. Quote the passage exactly as get_contracts returns it and call propose_edits again.` }),
          });
          continue;
        }
      }

      assistantText = stripInternalNotes(sanitizeCopy(turn.text ?? ""));
      const clean = deepSanitize(validation.value);
      if (turn.name === "ask_user") question = clean;
      else if (turn.name === "propose_draft") draft = clean;
      else edits = clean;
      break;
    }

    if (!assistantText && !question && !draft && !edits) {
      return json(
        { ok: false, error: { code: "no_response", message: "The assistant did not produce a response. Try rephrasing." } },
        { status: 200 },
      );
    }

    const payloadKind = question ? "question" : draft ? "draft" : edits ? "edits" : null;
    const { data: assistantRow, error: assistantErr } = await sb
      .from("proposal_agent_messages")
      .insert({
        conversation_id: conversationId,
        role: "assistant",
        content: assistantText,
        payload: question ?? draft ?? edits ?? null,
        payload_kind: payloadKind,
      })
      .select("id, created_at")
      .single();
    if (assistantErr) throw assistantErr;

    await sb
      .from("proposal_agent_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    // On the first turn, generate a concise AI title for the chat. Runs in the
    // background so it does not delay the response; falls back to the message
    // snippet already stored if it fails.
    if (conversationWasCreated) {
      const convId = conversationId;
      const summary =
        (draft as { summary?: string })?.summary ??
        (edits as { summary?: string })?.summary ??
        assistantText;
      const titleTask = (async () => {
        try {
          const titleTurn = await llm.runTurn({
            system:
              "You generate a very short title (3 to 6 words, Title Case, no surrounding quotes, no trailing punctuation) that summarizes what a client proposal chat is about. Reply with ONLY the title.",
            messages: [
              {
                role: "user",
                text: `First message: ${message}${summary ? `\nAssistant summary: ${summary}` : ""}`,
              },
            ],
            tools: [],
          });
          if (titleTurn.kind === "text") {
            const title = sanitizeCopy(titleTurn.text)
              .replace(/^[\s"'#]+|[\s"']+$/g, "")
              .slice(0, 80)
              .trim();
            if (title) {
              await sb.from("proposal_agent_conversations").update({ title }).eq("id", convId);
            }
          }
        } catch {
          // Keep the fallback message-snippet title.
        }
      })();
      const runtime = globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } };
      if (runtime.EdgeRuntime?.waitUntil) runtime.EdgeRuntime.waitUntil(titleTask);
      else await titleTask;
    }

    // Update the durable per-client memory in the background when the turn
    // produced a draft or edits (a real decision worth remembering).
    if (memoryScopeKey && (draft || edits)) {
      const producedSummary =
        (draft as { summary?: string })?.summary ??
        (edits as { summary?: string })?.summary ??
        assistantText;
      scheduleMemoryUpdate({
        sb,
        llm,
        scopeKey: memoryScopeKey,
        subject: clientCompanyName ? `the client ${clientCompanyName}` : "this client",
        priorMemory: clientMemory,
        userMessage: message,
        producedSummary,
      });
    }

    return json({
      ok: true,
      conversation_id: conversationId,
      assistant_message_id: assistantRow.id,
      assistant_text: assistantText,
      question: question ?? undefined,
      draft: draft ?? undefined,
      edits: edits ?? undefined,
    });
  } catch (e) {
    return json(
      { ok: false, error: { code: "request_failed", message: e instanceof Error ? e.message : "Unknown error" } },
      { status: 200 },
    );
  }
});
