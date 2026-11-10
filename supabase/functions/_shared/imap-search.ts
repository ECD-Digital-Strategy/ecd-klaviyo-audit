// A minimal IMAP client for one job (Outreach, 2026-11-02): ask Emil's Gmail, with
// the same app password the outreach emails are sent with, whether anything came
// back. Read-only (EXAMINE, never SELECT), searching All Mail so a reply he has
// already archived still counts. It counts matches, and (2026-11-02) reads each
// new reply so it can be sorted (BODY.PEEK, so nothing is marked as read).
// 2026-11-10: replies are read from bytes, so a FETCH literal is taken by its {N}
// byte count (a body line that starts with the tag can't end a read early), text
// is decoded only from whole characters, and every read and write has a deadline
// that closes the connection when it passes (a stalled socket can't hang a run).

export type ImapAuth = { user: string; pass: string; host?: string; port?: number };

/** What the session needs from a socket (a TLS connection, or a fake in tests). */
export type ImapConn = {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
};

/** One server response: its text (literals shown as "{N}") and the literals in order. */
export type ImapResponse = { text: string; literals: string[] };

/** "4-Nov-2026", IMAP's date format for SINCE. */
export function imapDate(d: Date): string {
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()}-${m}-${d.getUTCFullYear()}`;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** INTERNALDATE ("10-Nov-2026 14:03:22 +0100") as epoch ms, or null. */
export function parseInternalDate(s: string): number | null {
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})/.exec(s);
  if (!m || MONTHS[m[2].toLowerCase()] === undefined) return null;
  const utc = Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +m[4], +m[5], +m[6]);
  const offset = (m[7] === "-" ? -1 : 1) * (+m[8] * 60 + +m[9]) * 60_000;
  return utc - offset;
}

/** An IMAP quoted string. */
const q = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** UIDs as a compact IMAP set: [1,2,3,7] -> "1:3,7". */
export function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j;
  }
  return parts.join(",");
}

/**
 * The UIDs after the cursor, oldest first, at most cap. "UID n:*" also returns the
 * newest message when nothing is newer than n, so anything at or below the cursor
 * is dropped. more: some are left for the next run.
 */
export function newUids(found: number[], last: number, cap: number): { batch: number[]; more: boolean } {
  const fresh = [...new Set(found)].filter((u) => u > last).sort((a, b) => a - b);
  return { batch: fresh.slice(0, cap), more: fresh.length > cap };
}

/**
 * Where the cursor may move after a run: past every message handled in a row,
 * never past the first one that wasn't (it is read again next run).
 */
export function advanceCursor(last: number, results: Array<{ uid: number; handled: boolean }>): number {
  let cursor = last;
  for (const r of [...results].sort((a, b) => a.uid - b.uid)) {
    if (!r.handled) break;
    if (r.uid > cursor) cursor = r.uid;
  }
  return cursor;
}

/** One FETCH response's parts: message number, UID, INTERNALDATE and its first literal. */
export function parseFetch(r: ImapResponse): { seq: number; uid: number | null; internalDate: number | null; literal: string | null } | null {
  const m = /^\* (\d+) FETCH \(/.exec(r.text);
  if (!m) return null;
  const uid = /[( ]UID (\d+)/.exec(r.text);
  const date = /INTERNALDATE "([^"]+)"/.exec(r.text);
  return {
    seq: Number(m[1]),
    uid: uid ? Number(uid[1]) : null,
    internalDate: date ? parseInternalDate(date[1]) : null,
    literal: r.literals[0] ?? null,
  };
}

const CR = 13;
const LF = 10;

/**
 * Turns the byte stream into whole responses. A line ending in {N} is followed by
 * exactly N bytes of literal, which are never read as lines; literals go through a
 * streaming decoder, and lines are decoded only once complete, so a character split
 * across two reads is never garbled.
 */
export class ImapParser {
  private pending = new Uint8Array(0);
  private parts: string[] = [];
  private literals: string[] = [];
  private litLeft = -1; // -1: reading a line
  private lit = "";
  private litDec = new TextDecoder();
  private lineDec = new TextDecoder();

  push(chunk: Uint8Array): ImapResponse[] {
    const out: ImapResponse[] = [];
    const buf = new Uint8Array(this.pending.length + chunk.length);
    buf.set(this.pending);
    buf.set(chunk, this.pending.length);
    let pos = 0;
    for (;;) {
      if (this.litLeft >= 0) {
        const take = Math.min(this.litLeft, buf.length - pos);
        if (take > 0) this.lit += this.litDec.decode(buf.subarray(pos, pos + take), { stream: true });
        pos += take;
        this.litLeft -= take;
        if (this.litLeft > 0) break;
        this.literals.push(this.lit + this.litDec.decode());
        this.lit = "";
        this.litLeft = -1;
        continue;
      }
      let nl = -1;
      for (let i = buf.indexOf(CR, pos); i !== -1 && i + 1 < buf.length; i = buf.indexOf(CR, i + 1)) {
        if (buf[i + 1] === LF) {
          nl = i;
          break;
        }
      }
      if (nl === -1) break;
      const line = this.lineDec.decode(buf.subarray(pos, nl));
      pos = nl + 2;
      this.parts.push(line);
      const lit = /\{(\d+)\+?\}$/.exec(line);
      if (lit) {
        this.litLeft = Number(lit[1]);
        continue;
      }
      out.push({ text: this.parts.join(""), literals: this.literals });
      this.parts = [];
      this.literals = [];
    }
    this.pending = buf.slice(pos);
    return out;
  }
}

const parseSearch = (rs: ImapResponse[]) =>
  rs
    .filter((r) => r.text.startsWith("* SEARCH"))
    .flatMap((r) => r.text.slice("* SEARCH".length).trim().split(/\s+/).filter(Boolean).map(Number))
    .filter((n) => Number.isFinite(n));

export class ImapSession {
  private conn: ImapConn | null = null;
  private parser = new ImapParser();
  private queue: ImapResponse[] = [];
  private seq = 0;
  private enc = new TextEncoder();
  private dead = false;
  /** Epoch ms no read or write may run past (0: only the per-command timeout). */
  deadline = 0;
  /** From EXAMINE: the mailbox's UIDVALIDITY and UIDNEXT (null if not sent). */
  uidValidity: number | null = null;
  uidNext: number | null = null;

  static async open(auth: ImapAuth, opts: { deadline?: number } = {}): Promise<ImapSession> {
    const s = new ImapSession();
    s.deadline = opts.deadline ?? 0;
    const connecting = Deno.connectTls({ hostname: auth.host ?? "imap.gmail.com", port: auth.port ?? 993 });
    try {
      s.conn = await s.timed(connecting, 20_000);
    } catch (e) {
      // A connection that turns up after the timeout is closed straight away.
      connecting.then((c) => { try { c.close(); } catch { /* already closed */ } }, () => {});
      throw e;
    }
    try {
      await s.greet();
      await s.command(`LOGIN ${q(auth.user)} ${q(auth.pass)}`);
      await s.examine("[Gmail]/All Mail");
    } catch (e) {
      s.abort();
      throw e;
    }
    return s;
  }

  /** A session on an already open socket (tests). */
  static async onConn(conn: ImapConn, opts: { deadline?: number; mailbox?: string } = {}): Promise<ImapSession> {
    const s = new ImapSession();
    s.deadline = opts.deadline ?? 0;
    s.conn = conn;
    await s.greet();
    if (opts.mailbox) await s.examine(opts.mailbox);
    return s;
  }

  private async greet() {
    await this.readUntil((r) => r.text.startsWith("* OK"));
  }

  private async examine(mailbox: string) {
    const rs = await this.commandRaw(`EXAMINE ${q(mailbox)}`);
    for (const r of rs) {
      const v = /\[UIDVALIDITY (\d+)\]/.exec(r.text);
      if (v) this.uidValidity = Number(v[1]);
      const n = /\[UIDNEXT (\d+)\]/.exec(r.text);
      if (n) this.uidNext = Number(n[1]);
    }
  }

  /** Closes the socket; any read still waiting on it fails. */
  private abort() {
    this.dead = true;
    try {
      this.conn?.close();
    } catch {
      // already closed
    }
  }

  /** p, or imap_timeout after ms (and never past the session deadline), closing the connection. */
  private async timed<T>(p: Promise<T>, ms: number): Promise<T> {
    const limit = this.deadline ? Math.min(ms, this.deadline - Date.now()) : ms;
    p.catch(() => {}); // after a timeout nobody waits for it
    if (limit <= 0) {
      this.abort();
      throw new Error("imap_timeout");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("imap_timeout")), limit);
    });
    try {
      return await Promise.race([p, expired]);
    } catch (e) {
      if (e instanceof Error && e.message === "imap_timeout") this.abort();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readUntil(done: (r: ImapResponse) => boolean, timeoutMs = 20_000): Promise<ImapResponse[]> {
    const out: ImapResponse[] = [];
    const until = Date.now() + timeoutMs;
    const chunk = new Uint8Array(16_384);
    for (;;) {
      while (this.queue.length) {
        const r = this.queue.shift()!;
        out.push(r);
        if (done(r)) return out;
      }
      if (this.dead || !this.conn) throw new Error("imap_closed");
      const n = await this.timed(this.conn.read(chunk), until - Date.now());
      if (n === null) {
        this.dead = true;
        throw new Error("imap_closed");
      }
      this.queue.push(...this.parser.push(chunk.subarray(0, n)));
    }
  }

  private async writeAll(bytes: Uint8Array) {
    if (this.dead || !this.conn) throw new Error("imap_closed");
    let off = 0;
    while (off < bytes.length) off += await this.timed(this.conn.write(bytes.subarray(off)), 20_000);
  }

  /** Runs one command; throws on NO/BAD. Returns the untagged responses. */
  async commandRaw(cmd: string, timeoutMs = 20_000): Promise<ImapResponse[]> {
    const tag = `a${++this.seq}`;
    await this.writeAll(this.enc.encode(`${tag} ${cmd}\r\n`));
    const rs = await this.readUntil((r) => r.text.startsWith(`${tag} `), timeoutMs);
    const status = rs[rs.length - 1].text;
    if (!status.startsWith(`${tag} OK`)) throw new Error(`imap: ${status.slice(tag.length + 1, 120)}`);
    return rs.slice(0, -1);
  }

  /** Runs one command; throws on NO/BAD. Returns the untagged lines. */
  async command(cmd: string): Promise<string[]> {
    return (await this.commandRaw(cmd)).map((r) => r.text);
  }

  /** How many messages match an IMAP SEARCH (e.g. `SINCE 1-Nov-2026 FROM "brand.com"`). */
  async count(criteria: string): Promise<number> {
    return (await this.search(criteria)).length;
  }

  /** Message numbers matching an IMAP SEARCH, oldest first. */
  async search(criteria: string): Promise<number[]> {
    return parseSearch(await this.commandRaw(`SEARCH ${criteria}`));
  }

  /** UIDs matching an IMAP SEARCH, oldest first. */
  async uidSearch(criteria: string): Promise<number[]> {
    return parseSearch(await this.commandRaw(`UID SEARCH ${criteria}`)).sort((a, b) => a - b);
  }

  /** The highest UID in the mailbox right now (0 when it is empty). */
  async maxUid(): Promise<number> {
    if (this.uidNext !== null) return Math.max(0, this.uidNext - 1);
    const top = await this.uidSearch("UID *");
    return top.length ? top[top.length - 1] : 0;
  }

  /** The start of one message (headers and body, up to maxBytes), without marking it read. */
  async fetchRaw(seq: number, maxBytes = 30_000): Promise<string> {
    const rs = await this.commandRaw(`FETCH ${seq} (BODY.PEEK[]<0.${maxBytes}>)`);
    for (const r of rs) {
      const f = parseFetch(r);
      if (f && f.seq === seq && f.literal !== null) return f.literal;
    }
    return "";
  }

  /** The same, by UID. "" when the message is not there. */
  async fetchRawUid(uid: number, maxBytes = 30_000): Promise<string> {
    const rs = await this.commandRaw(`UID FETCH ${uid} (UID BODY.PEEK[]<0.${maxBytes}>)`);
    for (const r of rs) {
      const f = parseFetch(r);
      if (f && f.uid === uid && f.literal !== null) return f.literal;
    }
    return "";
  }

  /** Some header fields of many messages in one round trip, by UID. A message that
   * is gone from the mailbox is simply missing from the map. */
  async fetchHeaders(uids: number[], fields: string[]): Promise<Map<number, { header: string; internalDate: number | null }>> {
    const out = new Map<number, { header: string; internalDate: number | null }>();
    if (!uids.length) return out;
    const wanted = new Set(uids);
    const rs = await this.commandRaw(`UID FETCH ${uidSet(uids)} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (${fields.join(" ")})])`, 30_000);
    for (const r of rs) {
      const f = parseFetch(r);
      if (f?.uid != null && wanted.has(f.uid) && f.literal !== null) out.set(f.uid, { header: f.literal, internalDate: f.internalDate });
    }
    return out;
  }

  /** Message numbers from this domain since a date, oldest first. Each new one is
   * read and sorted in turn (fetchRaw), not just the latest (audit 2026-11-10). */
  messagesFrom(domain: string, since: Date): Promise<number[]> {
    return this.search(`SINCE ${imapDate(since)} FROM ${q(domain)}`);
  }

  /** UIDs from this address or domain since a date, up to maxUid, oldest first. */
  replyUids(key: string, since: Date, maxUid: number): Promise<number[]> {
    return maxUid > 0 ? this.uidSearch(`UID 1:${maxUid} SINCE ${imapDate(since)} FROM ${q(key)}`) : Promise.resolve([]);
  }

  /** UIDs of bounce notices that mention this address since a date, up to maxUid. */
  bounceUids(address: string, since: Date, maxUid: number): Promise<number[]> {
    return maxUid > 0
      ? this.uidSearch(`UID 1:${maxUid} SINCE ${imapDate(since)} FROM ${q("mailer-daemon")} TEXT ${q(address)}`)
      : Promise.resolve([]);
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
    if (!this.dead) {
      try {
        await this.command("LOGOUT");
      } catch {
        // closing anyway
      }
    }
    this.abort();
  }
}

export { q as imapQuote };
