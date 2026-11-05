// The welcome email a client gets after signing (Xiomara, 2026-11-03; Emil,
// 2026-11-04). What Xiomara sends by hand today, in one email from the sender's
// own Gmail:
//  - a brand new client: the invoice, launch call times that fit Isa's and the
//    RS's calendars, the ECD onboarding form, our W-9 and their intake form;
//  - an existing client signing more work: the invoice and the intake form for
//    what they bought.
// Never sent by the app (2026-11-05, Zak + Xiomara): written as a draft in the
// sender's Gmail and the sender Slacked the link, with anything missing (no free
// time, no intake form, a custom deal) listed to check. Settings live in
// platform_settings.proposal_settings.invoicing.welcome; keep the defaults in
// sync with src/lib/proposals-db.ts DEFAULT_WELCOME.

export type WelcomeSettings = {
  /** OFF until turned on. While on it replaces the invoice email for proposals signed since `since`. */
  enabled: boolean;
  /** No longer used (2026-11-05): every welcome email is a Gmail draft for the sender. */
  review_first: boolean;
  /** Only proposals signed on or after this (set when turned on). */
  since: string | null;
  ecd_onboarding_form_url: string;
  w9_url: string;
  new_subject: string;
  new_body: string;
  project_subject: string;
  project_body: string;
  /** Filled into {intro} when it comes from the fallback sender, who the client may not know. */
  intro_line: string;
  /** Whose calendars the launch call has to fit, besides the RS (Isa). */
  call_attendee_emails: string[];
  call_include_rs: boolean;
  /** The sender's own calendar too (Xiomara, 2026-11-04: yes). */
  call_include_sender: boolean;
  call_timezone: string;
  call_day_start: string;
  call_day_end: string;
  call_minutes: number;
  call_first_day: number;
  call_last_day: number;
  call_count: number;
  /** How long to wait for the RS and the intake form before drafting without them. */
  wait_hours: number;
};

export const DEFAULT_WELCOME: WelcomeSettings = {
  enabled: false,
  review_first: false,
  since: null,
  ecd_onboarding_form_url: "https://form.asana.com/?k=WHe6uZM6puiAQKgX-0kZMg&d=1201007545370748",
  w9_url: "https://drive.google.com/file/d/1QKPw9aTEIyR530TmvxiDiT-o8q7EbUVS/view?usp=sharing",
  new_subject: "Welcome to ECD Digital Strategy, {first_name}: next steps",
  new_body: [
    "Hi {first_name},",
    "",
    "{intro}",
    "",
    "Thanks so much for signing! We're excited to get started on {proposal_title}.",
    "",
    "Here's the invoice ({total}, due {due_date}): {pay_link}",
    "",
    "A few things to get us going:",
    "- Our onboarding form: {ecd_onboarding_form}",
    "- Your intake form, for access and brand assets: {client_onboarding_form}",
    "- Our W-9, for your records: {w9_link}",
    "",
    "For the launch call, would any of these work for you?",
    "{launch_call_times}",
    "If none of them suit, reply with a couple of times that do and we'll make it work.",
    "",
    "Talk soon,",
    "{sender_first_name}",
  ].join("\n"),
  project_subject: "Next steps for {proposal_title}",
  project_body: [
    "Hi {first_name},",
    "",
    "{intro}",
    "",
    "Thanks so much for signing {proposal_title}! We're excited to get going.",
    "",
    "Here's the invoice ({total}, due {due_date}): {pay_link}",
    "",
    "To get started, please fill in this short intake form: {client_onboarding_form}",
    "",
    "Talk soon,",
    "{sender_first_name}",
  ].join("\n"),
  intro_line: "I'm {sender_first_name} from ECD Digital Strategy. I look after getting new work started with the team, so you'll hear from me about invoices and kickoff.",
  call_attendee_emails: ["isa@ecdigitalstrategy.com"],
  call_include_rs: true,
  call_include_sender: true,
  call_timezone: "America/New_York",
  call_day_start: "10:00",
  call_day_end: "16:00",
  call_minutes: 45,
  call_first_day: 2,
  call_last_day: 10,
  call_count: 3,
  wait_hours: 24,
};

const emails = (v: unknown, fallback: string[]) =>
  Array.isArray(v) ? v.filter((e): e is string => typeof e === "string" && e.includes("@")).map((e) => e.trim().toLowerCase()) : fallback;
const text = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v : fallback);
const int = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const hhmm = (v: unknown, fallback: string) => (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim() : fallback);

export function mergeWelcome(raw: unknown): WelcomeSettings {
  const v = (raw ?? {}) as Partial<WelcomeSettings>;
  const d = DEFAULT_WELCOME;
  const first = int(v.call_first_day, d.call_first_day, 1, 20);
  return {
    enabled: v.enabled === true,
    review_first: v.review_first === true,
    since: typeof v.since === "string" && v.since ? v.since : null,
    ecd_onboarding_form_url: text(v.ecd_onboarding_form_url, d.ecd_onboarding_form_url).trim(),
    w9_url: text(v.w9_url, d.w9_url).trim(),
    new_subject: text(v.new_subject, d.new_subject),
    new_body: text(v.new_body, d.new_body),
    project_subject: text(v.project_subject, d.project_subject),
    project_body: text(v.project_body, d.project_body),
    intro_line: text(v.intro_line, d.intro_line),
    call_attendee_emails: emails(v.call_attendee_emails, d.call_attendee_emails),
    call_include_rs: v.call_include_rs !== false,
    call_include_sender: v.call_include_sender !== false,
    call_timezone: text(v.call_timezone, d.call_timezone).trim(),
    call_day_start: hhmm(v.call_day_start, d.call_day_start),
    call_day_end: hhmm(v.call_day_end, d.call_day_end),
    call_minutes: int(v.call_minutes, d.call_minutes, 15, 180),
    call_first_day: first,
    call_last_day: Math.max(first, int(v.call_last_day, d.call_last_day, 1, 30)),
    call_count: int(v.call_count, d.call_count, 1, 6),
    wait_hours: int(v.wait_hours, d.wait_hours, 0, 168),
  };
}

/** drafted: in the sender's Gmail as a draft (2026-11-05). draft: held on the proposal page because it couldn't go into Gmail. */
export type WelcomeStatus = "waiting" | "sending" | "draft" | "drafted" | "sent" | "skipped";

/** Whether the welcome email covers a proposal: on, and signed since it was turned on. */
export function welcomeCovers(w: WelcomeSettings, signedAt: string | null | undefined): boolean {
  return Boolean(w.enabled && w.since && signedAt && signedAt >= w.since);
}

/** Whether the invoice waits for the welcome email instead of going on its own. */
export function holdsInvoice(
  w: WelcomeSettings,
  p: { client_signed_at: string | null; welcome_email: { status?: WelcomeStatus } | null },
): boolean {
  if (!welcomeCovers(w, p.client_signed_at)) return false;
  const st = p.welcome_email?.status;
  // drafted: the invoice is in the welcome draft in Gmail, so it must not be drafted again on its own.
  return !st || st === "waiting" || st === "sending" || st === "draft" || st === "drafted";
}

export type WelcomeVars = {
  first_name: string;
  company: string;
  proposal_title: string;
  invoice_number: string;
  total: string;
  due_date: string;
  pay_link: string;
  sender_first_name: string;
  intro: string;
  ecd_onboarding_form: string;
  w9_link: string;
  client_onboarding_form: string;
};

export const WELCOME_PLACEHOLDERS = [
  "first_name",
  "company",
  "proposal_title",
  "invoice_number",
  "total",
  "due_date",
  "pay_link",
  "sender_first_name",
  "intro",
  "ecd_onboarding_form",
  "client_onboarding_form",
  "w9_link",
  "launch_call_times",
] as const;

/** The words a link shows as in the HTML email. */
export const LINK_LABELS: Record<string, string> = {
  pay_link: "View and pay the invoice",
  ecd_onboarding_form: "Fill in the onboarding form",
  client_onboarding_form: "Open your intake form",
  w9_link: "Download our W-9",
};

const fillLine = (line: string, vars: Record<string, string>) =>
  line.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));

/**
 * Fills the template. A line whose placeholder has nothing to fill (no invoice,
 * no intake form, no free times) is left out, and so is a paragraph left with
 * nothing to say: the email reads naturally whatever is missing. {launch_call_times}
 * becomes one "- time" line per time. Unknown placeholders stay as typed, so a typo
 * is visible.
 */
export function fillWelcome(template: string, vars: WelcomeVars, times: string[]): string {
  const values: Record<string, string> = { ...vars };
  const paragraphs = template.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const kept: string[] = [];
  for (const para of paragraphs) {
    const out: string[] = [];
    let hadFields = false;
    let keptFields = false;
    for (const line of para.split("\n")) {
      const keys = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => k in values || k === "launch_call_times");
      if (keys.length === 0) {
        out.push(line);
        continue;
      }
      hadFields = true;
      if (keys.includes("launch_call_times")) {
        if (!times.length) continue;
        keptFields = true;
        const rest = line.replace(/\{launch_call_times\}/g, "").trim();
        if (rest) out.push(fillLine(rest, values));
        for (const t of times) out.push(`- ${t}`);
        continue;
      }
      if (keys.some((k) => !String(values[k] ?? "").trim())) continue;
      keptFields = true;
      out.push(fillLine(line, values));
    }
    if (hadFields && !keptFields) continue;
    const textPara = out.join("\n").trim();
    if (textPara) kept.push(textPara);
  }
  return kept.join("\n\n");
}

export const fillSubject = (template: string, vars: WelcomeVars) =>
  fillLine(template, { ...vars })
    .replace(/\s+/g, " ")
    .replace(/\s+([,:.!?])/g, "$1")
    // ", :" left by an empty name
    .replace(/[,:]\s*([,:.!?])/g, "$1")
    .trim();

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Plain text to simple HTML: known links as words ("View and pay the invoice"),
 * any other web address clickable, "- " lines as bullets.
 */
export function welcomeHtml(text: string, links: Record<string, string>): string {
  const byUrl = new Map(Object.entries(links).filter(([url]) => url));
  const html = text
    .split("\n")
    .map((line) => {
      const bullet = /^\s*-\s+/.test(line);
      const body = (bullet ? line.replace(/^\s*-\s+/, "") : line)
        .split(/(https?:\/\/[^\s<>"]+)/g)
        .map((part, i) => {
          if (i % 2 === 0) return esc(part);
          const label = byUrl.get(part) ?? part;
          return `<a href="${esc(part)}">${esc(label)}</a>`;
        })
        .join("");
      return bullet ? `&nbsp;&nbsp;&bull;&nbsp;${body}` : body;
    })
    .join("<br>");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">${html}</div>`;
}
