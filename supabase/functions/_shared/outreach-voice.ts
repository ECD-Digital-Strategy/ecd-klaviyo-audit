// What makes a cold email read like a template or like AI (Emil, 2026-11-23: "for it to not sound like gibberish or
// AI slop"). Research summary: recipients spot generic, not AI. Stock openers, compliments, filler transitions and a
// sentence that is the same in every email give it away in two lines. outreach_draft checks every draft against
// this list and rewrites once when something slips through. Pure, tested.

const BANNED: Array<[RegExp, string]> = [
  [/\bhope (this|you('| a)re|you are|all is)\b/i, "\"I hope this finds you well\" style opener"],
  [/\b(came|stumbled) across\b/i, "\"I came across your brand\""],
  [/\bi('| a)m reaching out\b|\breaching out\b/i, "\"reaching out\""],
  [/\b(love|loved|admire|impressed by|big fan of)\b/i, "a compliment"],
  [/\b(amazing|awesome|incredible|stunning|beautiful|fantastic|great job)\b/i, "flattery"],
  [/\bquick question\b/i, "\"quick question\""],
  [/\b(just )?(bumping|circling back|following up|checking in|touching base)\b/i, "a \"just following up\" line"],
  [/\b(leverage|synergy|game[- ]changer|unlock|elevate|supercharge|seamless(ly)?|robust|cutting[- ]edge|delve|tapestry|in today's)\b/i, "marketing buzzword"],
  [/\b(boost|skyrocket|drive|maximi[sz]e) (your )?(conversions|sales|revenue|growth)\b/i, "a vague growth promise"],
  [/\bwe('| ha)ve helped\b|\bbrands like yours\b|\bclients like\b/i, "a \"we've helped brands like yours\" claim"],
  [/\bno strings attached\b|\bfree of charge\b|\b100% free\b/i, "salesy \"free\" wording"],
  [/\bi noticed that\b/i, "\"I noticed that\""],
  [/\bin (a|one) nutshell\b|\bat the end of the day\b/i, "a filler phrase"],
  [/\bfeel free to\b|\bdon't hesitate\b/i, "\"feel free / don't hesitate\""],
  [/\blooking forward to (hearing|your)\b/i, "\"looking forward to hearing from you\""],
  [/[—–]/, "an em or en dash"],
  [/!/, "an exclamation mark"],
];

/** What reads as a template or as AI in this text; empty when it is clean. */
export function sloppyPhrases(text: string): string[] {
  const found = new Set<string>();
  for (const [re, label] of BANNED) if (re.test(text)) found.add(label);
  return [...found];
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The rules every outreach email follows, for the prompts (kept next to the checker so they never drift apart). */
export const VOICE_RULES = `How it must read:
- Like Emil typed it himself in two minutes: plain, specific, a little informal. Not polished marketing copy.
- No stock openers ("I hope", "I came across", "I'm reaching out", "I noticed that"), no compliments or flattery about their brand, no "quick question".
- No buzzwords (leverage, unlock, elevate, seamless, boost conversions, game changer) and no vague promises about sales or growth. Never invent numbers, results or client names.
- Name the exact thing on their page: quote the headline or button text, name the section, say desktop or mobile. Something they can check on their own site in five seconds.
- Vary the shape: do not reuse the same sentence pattern for every brand. No sentence that could be pasted into another brand's email unchanged.
- No exclamation marks, no em or en dashes, no emojis, no bullet points, no bold, no markdown.`;
