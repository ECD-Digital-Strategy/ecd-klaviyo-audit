// Outreach in HubSpot (Emil, 2026-11-02): once a prospect has been emailed they
// are a real lead, so they go into HubSpot like any other: the company (by
// domain), the contact (associated to it, owned by Emil), and every email both
// ways on the contact's timeline. The contact's lead status follows the reply:
// emailed = Attempted to contact, interested = Connected, later = Bad timing,
// no = Unqualified.
// hubspot_sync then links the company to the prospect's is_outreach client row by
// domain, so no second client appears. Screening skips anything already in
// HubSpot, which now includes these, so nobody is screened twice.
// All best effort: a HubSpot failure never stops an email, it is recorded on the
// prospect (hubspot_error) and shown on its card.

const API = "https://api.hubapi.com";

export type HubLeadStatus = "ATTEMPTED_TO_CONTACT" | "CONNECTED" | "IN_PROGRESS" | "BAD_TIMING" | "UNQUALIFIED";

/** Scopes the private app needs for this (Settings shows which are missing). */
export const OUTREACH_HUBSPOT_SCOPES = [
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.owners.read",
];

export class HubSpot {
  private ownerIdCache: string | null | undefined;
  constructor(private readonly token: string) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {
        // keep the raw text
      }
      throw new Error(`HubSpot ${res.status}: ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** The scopes this token has, or null if HubSpot will not say. */
  async scopes(): Promise<string[] | null> {
    try {
      const r = await this.req<{ scopes?: string[] }>("/oauth/v2/private-apps/get/access-token-info", {
        method: "POST",
        body: JSON.stringify({ tokenKey: this.token }),
      });
      return r.scopes ?? null;
    } catch {
      return null;
    }
  }

  private async findOne(object: "companies" | "contacts", property: string, value: string): Promise<string | null> {
    const r = await this.req<{ results?: Array<{ id: string }> }>(`/crm/v3/objects/${object}/search`, {
      method: "POST",
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }], limit: 1 }),
    });
    return r.results?.[0]?.id ?? null;
  }

  /** The contact with this exact email, or null. Throws when HubSpot can't be read. */
  findContactByEmail(email: string): Promise<string | null> {
    return this.findOne("contacts", "email", email.trim().toLowerCase());
  }

  /** The company with this domain, or null. Throws when HubSpot can't be read. */
  findCompanyByDomain(domain: string): Promise<string | null> {
    return this.findOne("companies", "domain", domain);
  }

  /** Emil's HubSpot owner id, so the leads are his. */
  async ownerId(email: string): Promise<string | null> {
    if (this.ownerIdCache !== undefined) return this.ownerIdCache;
    try {
      const r = await this.req<{ results?: Array<{ id: string }> }>(`/crm/v3/owners?email=${encodeURIComponent(email)}&limit=1`);
      this.ownerIdCache = r.results?.[0]?.id ?? null;
    } catch {
      this.ownerIdCache = null;
    }
    return this.ownerIdCache;
  }

  /** created=false: the company was already there, so Outreach does not own it. */
  async upsertCompany(domain: string, name: string, ownerId: string | null): Promise<{ id: string; created: boolean }> {
    const found = await this.findOne("companies", "domain", domain);
    if (found) return { id: found, created: false };
    const r = await this.req<{ id: string }>("/crm/v3/objects/companies", {
      method: "POST",
      body: JSON.stringify({ properties: { name, domain, lifecyclestage: "lead", ...(ownerId ? { hubspot_owner_id: ownerId } : {}) } }),
    });
    return { id: r.id, created: true };
  }

  /**
   * created=false: the contact was already in HubSpot (not made by Outreach). It
   * is left as it is (no association, no lead status); only emails are logged.
   */
  async upsertContact(
    c: { email: string; name: string | null; title: string | null; domain: string },
    companyId: string,
    ownerId: string | null,
  ): Promise<{ id: string; created: boolean }> {
    const found = await this.findOne("contacts", "email", c.email);
    if (found) return { id: found, created: false };
    let id: string;
    {
      const [first, ...rest] = (c.name ?? "").trim().split(/\s+/).filter(Boolean);
      const r = await this.req<{ id: string }>("/crm/v3/objects/contacts", {
        method: "POST",
        body: JSON.stringify({
          properties: {
            email: c.email,
            ...(first ? { firstname: first } : {}),
            ...(rest.length ? { lastname: rest.join(" ") } : {}),
            ...(c.title ? { jobtitle: c.title } : {}),
            website: `https://${c.domain}`,
            lifecyclestage: "lead",
            hs_lead_status: "ATTEMPTED_TO_CONTACT",
            ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
          },
        }),
      });
      id = r.id;
    }
    await this.req(`/crm/v4/objects/contacts/${id}/associations/default/companies/${companyId}`, { method: "PUT" });
    return { id, created: true };
  }

  /** Only for a contact Outreach created: never on one that was already in HubSpot. */
  async setLeadStatus(contactId: string, status: HubLeadStatus) {
    await this.req(`/crm/v3/objects/contacts/${contactId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { hs_lead_status: status } }),
    });
  }

  /** An email on the contact's (and company's) timeline. */
  async logEmail(e: {
    contactId: string;
    companyId: string | null;
    direction: "out" | "in";
    subject: string;
    text: string;
    from: string;
    to: string;
    at?: Date;
    ownerId: string | null;
  }) {
    const associations = [
      { to: { id: e.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 198 }] },
      ...(e.companyId ? [{ to: { id: e.companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 186 }] }] : []),
    ];
    await this.req("/crm/v3/objects/emails", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          hs_timestamp: (e.at ?? new Date()).toISOString(),
          hs_email_direction: e.direction === "out" ? "EMAIL" : "INCOMING_EMAIL",
          hs_email_status: "SENT",
          hs_email_subject: e.subject.slice(0, 500),
          hs_email_text: e.text.slice(0, 60_000),
          hs_email_headers: JSON.stringify({ from: { email: e.from }, to: [{ email: e.to }] }),
          ...(e.ownerId ? { hubspot_owner_id: e.ownerId } : {}),
        },
        associations,
      }),
    });
  }
}
