// Which Xero revenue account an invoice line belongs in.
//
// Two things decide it together: the service family, and whether the money is
// one-time or recurring. The same Klaviyo engagement splits across two accounts,
// implementation to the Klaviyo sales account and the ongoing retainer to the MRR
// account, so a single account per service would be wrong.
//
// Kept as pure functions with no Supabase or Xero dependency so the rules can be
// tested directly. Everything is data-driven: no account code is hardcoded.

export type RevenueAccountRow = {
  service_key: string;
  name: string;
  one_time_account_code: string | null;
  monthly_account_code: string | null;
};

export type AccountDefaults = {
  /** Recurring lines land here unless the service overrides it. */
  mrrAccountCode: string | null;
  /** Last-resort account for one-time lines with no per-service code. */
  salesAccountCode: string | null;
};

export type FeeKind = "one_time" | "monthly";

export type ResolveInput = {
  /** Line label, used only to name the offending line in an error. */
  label: string;
  serviceKey: string | null;
  kind: FeeKind;
};

export type Resolved =
  | { ok: true; accountCode: string; serviceName: string | null }
  | {
    ok: false;
    reason: "no_service" | "no_account";
    label: string;
    serviceName: string | null;
    serviceKey: string | null;
    kind: FeeKind;
  };

function fail(
  reason: "no_service" | "no_account",
  input: ResolveInput,
  serviceName: string | null,
): Extract<Resolved, { ok: false }> {
  return { ok: false, reason, label: input.label, serviceName, serviceKey: input.serviceKey, kind: input.kind };
}

/** The family a line's stored key belongs to. Lines on signed proposals cannot
 * be changed, so the four categories used before Zak's three families (Oct 19,
 * 2026) are folded in here rather than in the data. */
export function familyKey(key: string | null): string | null {
  if (!key) return null;
  if (key === "klaviyo" || key === "sms" || key === "ai_agents") return "retention";
  if (key === "web_cro") return "website";
  return key;
}

export function resolveAccountCode(
  input: ResolveInput,
  mapping: RevenueAccountRow[],
  defaults: AccountDefaults,
): Resolved {
  const key = familyKey(input.serviceKey);
  const row = key ? mapping.find((m) => m.service_key === key) ?? null : null;

  if (input.kind === "monthly") {
    // Recurring is the one case with a sane global default: every retainer goes
    // to the MRR account, so a line with no service still resolves as long as
    // that account is configured.
    const code = (row?.monthly_account_code || defaults.mrrAccountCode || "").trim();
    if (code) return { ok: true, accountCode: code, serviceName: row?.name ?? null };
    return { ...fail("no_account", input, row?.name ?? null) };
  }

  // One-time revenue is per service, so an unknown service cannot be guessed.
  if (!input.serviceKey) return fail("no_service", input, null);
  const code = (row?.one_time_account_code || defaults.salesAccountCode || "").trim();
  if (code) return { ok: true, accountCode: code, serviceName: row?.name ?? null };
  return fail("no_account", input, row?.name ?? null);
}

/** Human-readable reason an invoice was blocked, naming the specific lines so
 * whoever sees it in the app knows exactly what to fix. */
export function describeUnmapped(failures: Extract<Resolved, { ok: false }>[]): string {
  const noService = failures.filter((f) => f.reason === "no_service").map((f) => f.label);
  const noAccount = failures.filter((f) => f.reason === "no_account");
  const parts: string[] = [];
  if (noService.length > 0) {
    parts.push(
      `No service selected for: ${noService.join("; ")}. Pick a revenue category on ${
        noService.length === 1 ? "that line" : "those lines"
      } in the proposal.`,
    );
  }
  if (noAccount.length > 0) {
    // Name what is actually unconfigured: the service (by name, or by its raw key
    // when the mapping row is gone), or the MRR account for a recurring line.
    const names = [...new Set(noAccount.map((f) =>
      f.serviceName ?? f.serviceKey ?? (f.kind === "monthly" ? "recurring revenue (MRR account)" : "one-time revenue")
    ))];
    parts.push(
      `No Xero account configured for: ${names.join("; ")}. Set the codes under Settings > API Connection > Xero.`,
    );
  }
  return parts.join(" ");
}
