import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, requireAdminUserId, requireStaffUserId } from "../_shared/auth.ts";
import {
  GOOGLE_CLIENT_ID_KEY,
  GOOGLE_CLIENT_SECRET_KEY,
  authorizeUrl,
  completeConnection,
  gmailRedirectUri,
  googleClient,
  mailboxFor,
  sendAsPerson,
  writeSecret,
} from "../_shared/gmail.ts";
import { loadInvoicing } from "../_shared/invoice-delivery.ts";
import { longDate, money, renderInvoiceEmail } from "../_shared/invoice-email.ts";

// Connecting a person's Gmail so invoices can go out as them (2026-11-02; see
// _shared/gmail.ts). POST actions, from Proposal settings:
//  - "status": is Google sign-in set up, whose Gmail is connected (everyone's,
//    for the list on the settings page), and is MINE;
//  - "start": the Google sign-in link for me;
//  - "disconnect": forget my Gmail (admins: anyone's, with user_id);
//  - "test": an example invoice email to myself, from my Gmail;
//  - "save_client" (admins): the Google OAuth client id and secret.
// GET: Google's redirect after sign-in (code + state), which stores the
// connection and sends the browser back to Proposal settings.

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" } });
}

const DEFAULT_RETURN = "https://proposal.ecdigitalstrategy.com/proposals?tab=settings";

/** Back to the page that started it, with the outcome in the query string. */
function backTo(returnTo: string | null, outcome: Record<string, string>) {
  let url: URL;
  try {
    url = new URL(returnTo || DEFAULT_RETURN);
    if (!/(^|\.)ecdigitalstrategy\.com$|^localhost$/.test(url.hostname)) url = new URL(DEFAULT_RETURN);
  } catch {
    url = new URL(DEFAULT_RETURN);
  }
  for (const [k, v] of Object.entries(outcome)) url.searchParams.set(k, v.slice(0, 200));
  return new Response(null, { status: 302, headers: { location: url.toString() } });
}

async function callback(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const sb = assertServiceRoleClient();
  const { data: row } = state
    ? await sb.from("gmail_oauth_states").select("state, user_id, return_to, created_at").eq("state", state).maybeSingle()
    : { data: null };
  if (!row) return backTo(null, { gmail: "error", gmail_detail: "This connection link has expired. Start again." });
  // Single use, and only for 15 minutes: a replayed or forged callback cannot attach a mailbox to someone.
  await sb.from("gmail_oauth_states").delete().eq("state", state);
  const returnTo = (row.return_to as string | null) ?? null;
  if (url.searchParams.get("error")) return backTo(returnTo, { gmail: "error", gmail_detail: url.searchParams.get("error")! });
  if (!code || Date.now() - Date.parse(row.created_at as string) > 15 * 60_000) {
    return backTo(returnTo, { gmail: "error", gmail_detail: "This connection link has expired. Start again." });
  }
  try {
    const email = await completeConnection(sb, row.user_id as string, code);
    return backTo(returnTo, { gmail: "connected", gmail_email: email });
  } catch (e) {
    return backTo(returnTo, { gmail: "error", gmail_detail: e instanceof Error ? e.message : "Could not connect Gmail" });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method === "GET") return await callback(req);
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let userId: string;
  try {
    userId = await requireStaffUserId(req);
  } catch {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string; return_to?: string; client_id?: string; client_secret?: string; user_id?: string; template?: string; subject?: string; email_body?: string };
  const sb = assertServiceRoleClient();

  try {
    if (body.action === "status") {
      // In parallel, and the role from the profile directly rather than a second
      // sign-in check: this loads every time the settings page opens.
      const [client, { data: rows }, { data: meProfile }] = await Promise.all([
        googleClient(sb),
        sb.from("mailbox_connections").select("user_id, email, connected_at, last_used_at, last_error").order("connected_at", { ascending: true }),
        sb.from("profiles").select("role").eq("id", userId).maybeSingle(),
      ]);
      const ids = (rows ?? []).map((r) => r.user_id as string);
      const { data: profs } = ids.length ? await sb.from("profiles").select("id, name").in("id", ids) : { data: [] };
      const names = new Map((profs ?? []).map((p) => [p.id as string, String(p.name ?? "").trim()]));
      // Everyone connected, so the team can see whose Gmail invoices can come from.
      // Addresses and dates only: tokens never leave the server.
      const connections = (rows ?? []).map((r) => ({
        user_id: r.user_id as string,
        name: names.get(r.user_id as string) || (r.email as string),
        email: r.email as string,
        connected_at: r.connected_at as string,
        last_used_at: (r.last_used_at as string | null) ?? null,
        last_error: (r.last_error as string | null) ?? null,
        is_me: r.user_id === userId,
      }));
      const isAdmin = (meProfile as { role?: string } | null)?.role === "admin";
      return json({
        ok: true,
        configured: Boolean(client),
        // Enough to recognise which Google client is saved, never the secret.
        client_id_hint: client && isAdmin ? `${client.clientId.slice(0, 12)}…${client.clientId.slice(-28)}` : null,
        redirect_uri: gmailRedirectUri(),
        is_admin: isAdmin,
        me: userId,
        mine: connections.find((c) => c.is_me) ?? null,
        connections,
      });
    }

    if (body.action === "save_client") {
      try {
        await requireAdminUserId(req);
      } catch {
        return json({ ok: false, error: "Only admins can set up Google sign-in." }, 403);
      }
      const id = String(body.client_id ?? "").trim();
      const secret = String(body.client_secret ?? "").trim();
      if (!/\.apps\.googleusercontent\.com$/.test(id) || secret.length < 10) {
        return json({ ok: false, error: "Paste the client ID (ends in .apps.googleusercontent.com) and its secret." }, 400);
      }
      await writeSecret(sb, GOOGLE_CLIENT_ID_KEY, id);
      await writeSecret(sb, GOOGLE_CLIENT_SECRET_KEY, secret);
      return json({ ok: true });
    }

    if (body.action === "start") {
      const client = await googleClient(sb);
      if (!client) return json({ ok: false, error: "Google sign-in is not set up yet. An admin adds it in Proposal settings." }, 409);
      const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await sb.from("gmail_oauth_states").delete().lt("created_at", new Date(Date.now() - 3_600_000).toISOString());
      const { error } = await sb.from("gmail_oauth_states").insert({ state, user_id: userId, return_to: body.return_to ?? null });
      if (error) throw error;
      const { data: prof } = await sb.from("profiles").select("email").eq("id", userId).maybeSingle();
      return json({ ok: true, url: authorizeUrl(client.clientId, state, (prof as { email?: string } | null)?.email ?? undefined) });
    }

    if (body.action === "disconnect") {
      // Your own Gmail, or (admins) anyone's, e.g. when someone leaves.
      const target = body.user_id && body.user_id !== userId ? body.user_id : userId;
      if (target !== userId) {
        try {
          await requireAdminUserId(req);
        } catch {
          return json({ ok: false, error: "Only admins can disconnect someone else's Gmail." }, 403);
        }
      }
      await sb.from("mailbox_connections").delete().eq("user_id", target);
      return json({ ok: true });
    }

    if (body.action === "test") {
      // An example email to myself, so the wording and the sender can be checked.
      // template: which one (usual, intro, reminder); subject/email_body: the text as
      // it stands in the settings form, so unsaved edits can be tried before saving.
      const box = await mailboxFor(sb, userId);
      if (!box) return json({ ok: false, error: "Connect your Gmail first." }, 409);
      const s = await loadInvoicing(sb);
      const saved = body.template === "intro"
        ? { subject: s.intro_subject, body: s.intro_body }
        : body.template === "reminder"
          ? { subject: s.reminder_subject, body: s.reminder_body }
          : { subject: s.subject, body: s.body };
      const draft = {
        subject: typeof body.subject === "string" && body.subject.trim() ? body.subject.slice(0, 300) : saved.subject,
        body: typeof body.email_body === "string" && body.email_body.trim() ? body.email_body.slice(0, 10_000) : saved.body,
      };
      const { data: prof } = await sb.from("profiles").select("name").eq("id", userId).maybeSingle();
      const name = String((prof as { name?: string } | null)?.name ?? "").trim();
      const email = renderInvoiceEmail(draft, {
        first_name: name.split(/\s+/)[0] || "there",
        company: "Example Brand",
        proposal_title: "Website retainer",
        invoice_number: "INV-0000",
        total: money(700),
        due_date: longDate(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)),
        pay_link: "https://in.xero.com/example",
        sender_first_name: name.split(/\s+/)[0] || "ECD Digital Strategy",
      });
      const sent = await sendAsPerson(sb, box, { fromName: name || null, to: [box.email], subject: `[Test${body.template === "intro" ? ", intro" : body.template === "reminder" ? ", client reminder" : ""}] ${email.subject}`, html: email.html, text: email.text });
      return json({ ok: true, to: box.email, signature: sent.signature });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
