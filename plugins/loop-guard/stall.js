// Recognises a reply that announces its next action and then ends the turn.
//
// Now and then this model writes "Now let me add the tests to the file." and
// then stops instead of making the tool call, so the session goes idle while
// its last words say it is working. On 2026-10-14 a lead in the VS Code
// extension sat like that for 84 minutes until the user asked "Are you
// working?". Over 2,432 stored turn endings (both OpenCode databases) this
// matched 6, all of that kind, and none that were finished, asking the user
// something, or waiting on a background worker or command -- those name what
// they wait for ("I'll continue once the report lands"), which is excluded.

// The last sentence starts with an intention to act, after optional fillers.
const ANNOUNCE = /^(?:(?:now|next|ok(?:ay)?|so|alright|right|first|then)[,:]?\s+)*(?:let me|let's|i'll|i will|i'm going to|i am going to|i need to|time to)\b(?!\s+know\b)/i;
// Anything about waiting for something else to finish.
const WAITING = /\b(?:when|once|as soon as|after|until|wait|waiting|await|awaiting|reports?|completes?|lands?|arrives?|finish(?:es)?|notif\w*|comes back|background)\b/i;

function lastSentence(text) {
  const paragraphs = text.trim().split(/\n\s*\n/).filter(p => p.trim());
  if (!paragraphs.length) return "";
  const sentences = paragraphs[paragraphs.length - 1].trim().split(/(?<=[.!])\s+/);
  // Strip a block marker (OpenCode's §n§) and markdown emphasis and markers.
  return sentences[sentences.length - 1].replace(/^§\d+§\s*/, "").replace(/[*_]+/g, "")
    .replace(/^[#>\-\s]+/, "").trim();
}

// The announced step as a short quote, or "" when the text does not end on one.
export function announcedStep(text) {
  if (typeof text !== "string") return "";
  const sentence = lastSentence(text.replace(/^§\d+§\s*/, ""));
  if (!sentence || sentence.endsWith("?")) return "";
  if (!ANNOUNCE.test(sentence) || WAITING.test(sentence)) return "";
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}
