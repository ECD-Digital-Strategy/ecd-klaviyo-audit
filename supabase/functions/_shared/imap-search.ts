// A minimal IMAP client for one job (Outreach, 2026-11-02): ask Emil's Gmail, with
// the same app password the outreach emails are sent with, whether anything came
// back. Read-only (EXAMINE, never SELECT), searching All Mail so a reply he has
// already archived still counts. It counts matches, and (2026-11-02) reads each
// new reply so it can be sorted (BODY.PEEK, so nothing is marked as read).

export type ImapAuth = { user: string; pass: string; host?: string; port?: number };

/** "4-Nov-2026", IMAP's date format for SINCE. */
export function imapDate(d: Date): string {
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()}-${m}-${d.getUTCFullYear()}`;
}

/** An IMAP quoted string. */
const q = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

export class ImapSession {
  private conn!: Deno.TlsConn;
  private buf = "";
  private seq = 0;
  private dec = new TextDecoder();
  private enc = new TextEncoder();

  static async open(auth: ImapAuth): Promise<ImapSession> {
    const s = new ImapSession();
    s.conn = await Deno.connectTls({ hostname: auth.host ?? "imap.gmail.com", port: auth.port ?? 993 });
    await s.readUntil((line) => line.startsWith("* OK"));
    await s.command(`LOGIN ${q(auth.user)} ${q(auth.pass)}`);
    await s.command(`EXAMINE ${q("[Gmail]/All Mail")}`);
    return s;
  }

  private async readUntil(done: (line: string) => boolean, timeoutMs = 20_000): Promise<string[]> {
    const lines: string[] = [];
    const deadline = Date.now() + timeoutMs;
    const chunk = new Uint8Array(16_384);
    for (;;) {
      let nl: number;
      while ((nl = this.buf.indexOf("\r\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 2);
        lines.push(line);
        if (done(line)) return lines;
      }
      if (Date.now() > deadline) throw new Error("imap_timeout");
      const n = await this.conn.read(chunk);
      if (n === null) throw new Error("imap_closed");
      this.buf += this.dec.decode(chunk.subarray(0, n));
    }
  }

  /** Runs one command; throws on NO/BAD. Returns the untagged lines. */
  async command(cmd: string): Promise<string[]> {
    const tag = `a${++this.seq}`;
    await this.conn.write(this.enc.encode(`${tag} ${cmd}\r\n`));
    const lines = await this.readUntil((l) => l.startsWith(`${tag} `));
    const status = lines[lines.length - 1];
    if (!status.startsWith(`${tag} OK`)) throw new Error(`imap: ${status.slice(tag.length + 1, 120)}`);
    return lines.slice(0, -1);
  }

  /** How many messages match an IMAP SEARCH (e.g. `SINCE 1-Nov-2026 FROM "brand.com"`). */
  async count(criteria: string): Promise<number> {
    return (await this.search(criteria)).length;
  }

  /** Message numbers matching an IMAP SEARCH, oldest first. */
  async search(criteria: string): Promise<number[]> {
    const lines = await this.command(`SEARCH ${criteria}`);
    const hit = lines.find((l) => l.startsWith("* SEARCH"));
    return hit ? hit.slice("* SEARCH".length).trim().split(/\s+/).filter(Boolean).map(Number) : [];
  }

  /** The start of one message (headers and body, up to maxBytes), without marking it read. */
  async fetchRaw(seq: number, maxBytes = 30_000): Promise<string> {
    const lines = await this.command(`FETCH ${seq} (BODY.PEEK[]<0.${maxBytes}>)`);
    // "* 12 FETCH (BODY[]<0> {5234}", the message's lines, then ")".
    const start = lines.findIndex((l) => /FETCH \(.*\{\d+\}$/.test(l));
    if (start === -1) return "";
    const body = lines.slice(start + 1);
    // The closing ")" is on its own line, or straight after a cut-off last line.
    if (body.length && body[body.length - 1].trim() === ")") body.pop();
    else if (body.length) body[body.length - 1] = body[body.length - 1].replace(/\)$/, "");
    return body.join("\r\n");
  }

  /** Message numbers from this domain since a date, oldest first. Each new one is
   * read and sorted in turn (fetchRaw), not just the latest (audit 2026-11-10). */
  messagesFrom(domain: string, since: Date): Promise<number[]> {
    return this.search(`SINCE ${imapDate(since)} FROM ${q(domain)}`);
  }

  /** Messages this mailbox sent to an address since a date, oldest first. */
  sentTo(from: string, to: string, since: Date): Promise<number[]> {
    return this.search(`SINCE ${imapDate(since)} FROM ${q(from)} TO ${q(to)}`);
  }

  /** Anything from this domain (a reply, an out-of-office, a "please remove me") since a date. */
  repliesFrom(domain: string, since: Date): Promise<number> {
    return this.count(`SINCE ${imapDate(since)} FROM ${q(domain)}`);
  }

  /** A bounce notice that mentions this address since a date. */
  bouncesFor(address: string, since: Date): Promise<number> {
    return this.count(`SINCE ${imapDate(since)} FROM ${q("mailer-daemon")} TEXT ${q(address)}`);
  }

  async close() {
    try {
      await this.command("LOGOUT");
    } catch {
      // closing anyway
    }
    try {
      this.conn.close();
    } catch {
      // already closed
    }
  }
}

export { q as imapQuote };
