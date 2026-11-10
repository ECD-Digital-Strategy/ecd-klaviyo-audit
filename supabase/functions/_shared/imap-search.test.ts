import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  advanceCursor,
  type ImapConn,
  ImapParser,
  ImapSession,
  newUids,
  parseFetch,
  parseInternalDate,
  uidSet,
} from "./imap-search.ts";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

Deno.test("a FETCH literal is read by its byte count, even when a body line starts with the tag", () => {
  const body = "Subject: hi\r\n\r\na3 OK this line looks like the end\r\n)\r\nmore";
  const n = enc.encode(body).length;
  const p = new ImapParser();
  const rs = p.push(bytes(`* 7 FETCH (UID 42 BODY[]<0> {${n}}\r\n${body})\r\na3 OK FETCH done\r\n`));
  assertEquals(rs.length, 2);
  assertEquals(rs[0].text, `* 7 FETCH (UID 42 BODY[]<0> {${n}})`);
  assertEquals(rs[0].literals, [body]);
  assertEquals(rs[1].text, "a3 OK FETCH done");
  const f = parseFetch(rs[0])!;
  assertEquals([f.seq, f.uid, f.literal], [7, 42, body]);
});

Deno.test("a multi-byte character split across reads is not garbled", () => {
  const body = "Zdravo Emil, cześć, 日本 ok";
  const all = bytes(`* 1 FETCH (UID 5 BODY[]<0> {${enc.encode(body).length}}\r\n${body})\r\n* OK 日本\r\na1 OK\r\n`);
  // Every split point, including inside each character, in the literal and in a line.
  for (let cut = 1; cut < all.length; cut++) {
    const p = new ImapParser();
    const rs = [...p.push(all.subarray(0, cut)), ...p.push(all.subarray(cut))];
    assertEquals(rs.map((r) => r.literals[0] ?? r.text), [body, "* OK 日本", "a1 OK"]);
  }
  // One byte at a time.
  const p = new ImapParser();
  const rs = [];
  for (let i = 0; i < all.length; i++) rs.push(...p.push(all.subarray(i, i + 1)));
  assertEquals(rs[0].literals, [body]);
});

Deno.test("several header literals in one FETCH response stream", () => {
  const h1 = "From: a@brand.com\r\n\r\n";
  const h2 = "From: b@other.com\r\nIn-Reply-To: <x@y>\r\n\r\n";
  const p = new ImapParser();
  const rs = p.push(bytes(
    `* 3 FETCH (UID 10 INTERNALDATE "10-Nov-2026 14:03:22 +0100" BODY[HEADER.FIELDS (FROM IN-REPLY-TO)] {${h1.length}}\r\n${h1})\r\n` +
      `* 4 FETCH (UID 11 INTERNALDATE "10-Nov-2026 14:05:00 +0000" BODY[HEADER.FIELDS (FROM IN-REPLY-TO)] {${h2.length}}\r\n${h2})\r\n` +
      `* 4 FETCH (FLAGS (\\Seen))\r\n`,
  ));
  const f = rs.map(parseFetch);
  assertEquals(f.map((x) => x?.uid), [10, 11, null]);
  assertEquals(f[0]!.literal, h1);
  assertEquals(f[0]!.internalDate, Date.UTC(2026, 10, 10, 13, 3, 22));
  assertEquals(f[2]!.literal, null);
});

Deno.test("INTERNALDATE parsing", () => {
  assertEquals(parseInternalDate(" 1-Dec-2026 00:00:00 -0500"), Date.UTC(2026, 11, 1, 5));
  assertEquals(parseInternalDate("garbage"), null);
});

Deno.test("cursor: moves past handled messages, stops before the first unhandled one", () => {
  assertEquals(advanceCursor(100, []), 100);
  assertEquals(advanceCursor(100, [{ uid: 101, handled: true }, { uid: 105, handled: true }]), 105);
  assertEquals(advanceCursor(100, [{ uid: 101, handled: true }, { uid: 102, handled: false }, { uid: 103, handled: true }]), 101);
  assertEquals(advanceCursor(100, [{ uid: 101, handled: false }, { uid: 102, handled: true }]), 100);
  // Order of the results doesn't matter, UID order does.
  assertEquals(advanceCursor(100, [{ uid: 103, handled: true }, { uid: 102, handled: false }, { uid: 101, handled: true }]), 101);
});

Deno.test("new UIDs: past the cursor only (UID n:* returns the newest one anyway), oldest first, capped", () => {
  assertEquals(newUids([100], 100, 50), { batch: [], more: false });
  assertEquals(newUids([104, 101, 103, 101], 100, 50), { batch: [101, 103, 104], more: false });
  assertEquals(newUids([101, 102, 103], 100, 2), { batch: [101, 102], more: true });
});

Deno.test("UID sets are compact", () => {
  assertEquals(uidSet([7, 1, 2, 3, 9, 10]), "1:3,7,9:10");
  assertEquals(uidSet([5]), "5");
});

/** A socket that answers from a script, and can stall. */
function fakeConn(script: (cmd: string) => string | null, greeting = "* OK ready\r\n") {
  const out: Uint8Array[] = [bytes(greeting)];
  let wake: (() => void) | null = null;
  let closed = false;
  const conn: ImapConn & { closed: () => boolean } = {
    async read(p) {
      while (!out.length) {
        if (closed) throw new Error("closed");
        await new Promise<void>((r) => (wake = r));
      }
      const next = out.shift()!;
      const n = Math.min(p.length, next.length);
      p.set(next.subarray(0, n));
      if (n < next.length) out.unshift(next.subarray(n));
      return n;
    },
    write(p) {
      const reply = script(new TextDecoder().decode(p).trim());
      if (reply !== null) {
        out.push(bytes(reply));
        wake?.();
      }
      return Promise.resolve(p.length);
    },
    close() {
      closed = true;
      wake?.();
    },
    closed: () => closed,
  };
  return conn;
}

Deno.test("a stalled connection times out at the deadline and is closed", async () => {
  const conn = fakeConn((cmd) => (cmd.startsWith("a1 ") ? null : `${cmd.split(" ")[0]} OK\r\n`));
  const s = await ImapSession.onConn(conn, { deadline: Date.now() + 200 });
  const started = Date.now();
  await assertRejects(() => s.search("ALL"), Error, "imap_timeout");
  assertEquals(conn.closed(), true);
  assertEquals(Date.now() - started < 2_000, true);
});

Deno.test("EXAMINE gives UIDVALIDITY and UIDNEXT; UID FETCH by literal", async () => {
  const body = "From: jane@brand.com\r\n\r\nHello\r\na3 OK fake\r\n";
  const conn = fakeConn((cmd) => {
    const tag = cmd.split(" ")[0];
    if (cmd.includes("EXAMINE")) return `* 12 EXISTS\r\n* OK [UIDVALIDITY 3857529045] ok\r\n* OK [UIDNEXT 901] ok\r\n${tag} OK [READ-ONLY]\r\n`;
    if (cmd.includes("UID SEARCH")) return `* SEARCH 900 899\r\n${tag} OK\r\n`;
    if (cmd.includes("UID FETCH")) return `* 12 FETCH (UID 900 BODY[]<0> {${enc.encode(body).length}}\r\n${body})\r\n${tag} OK\r\n`;
    return `${tag} OK\r\n`;
  });
  const s = await ImapSession.onConn(conn, { mailbox: "[Gmail]/All Mail" });
  assertEquals([s.uidValidity, s.uidNext, await s.maxUid()], [3857529045, 901, 900]);
  assertEquals(await s.uidSearch("UID 899:*"), [899, 900]);
  assertEquals(await s.fetchRawUid(900), body);
  await s.close();
});
