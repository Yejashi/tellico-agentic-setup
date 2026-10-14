// Recognises a reply that has started repeating itself, while it streams.
//
// The signature of a loop is that what the model writes *now* is text it has
// already written in this part: "So the new file should be 14-... But the
// task says 12-... Hmm, let me re-read" over and over until the step hits the
// output cap. Quoting is different -- re-reading a struct or a status file
// repeats a passage, but surrounded by new analysis. So the test looks at the
// most recent WINDOW characters and asks what share of its SHINGLE-character
// substrings already appeared earlier in the part; at >= RATIO for NEED
// consecutive checks, it is a loop.
//
// Tuned on 2,861 stored reasoning and text parts from real sessions on this
// cluster (2026-10-14): it fired on 16, every one a genuine loop -- the same
// indecision paragraph, the same plan restated, the same code re-drafted --
// and caught the worst, a 480-character paragraph repeated until the 32,768-
// token cap, at 4,200 characters instead of 121,709. A simpler "the tail
// recurs K times" rule could not tell loops from quoting at any K.
//
// Whitespace is collapsed first, so a loop that varies only in line breaks is
// still one. Every earlier position is indexed: sampling them would miss a
// loop whose period is a multiple of the sampling stride (that one did, with
// a period of 483 = 7 x 69).

export const DEFAULTS = {
  shingle: 50,
  window: 1500,
  step: 400,
  min: 3000,
  ratio: 0.95,
  need: 2,
  // A part longer than this has hit the output cap anyway; stop indexing it.
  max: 200000,
};

export class LoopDetector {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.text = "";
    this.seen = new Set();
    this.indexed = 0;
    this.next = this.o.min;
    this.streak = 0;
    this.fired = false;
  }

  // Append streamed text; true once, on the push that confirms a loop.
  push(delta) {
    if (this.fired || typeof delta !== "string" || !delta) return false;
    const { shingle, window, step, ratio, need, max } = this.o;
    let add = delta.replace(/\s+/g, " ");
    if (this.text.endsWith(" ") && add.startsWith(" ")) add = add.slice(1);
    this.text += add;
    if (this.text.length > max) return false;

    while (this.text.length >= this.next) {
      const end = this.next;
      this.next += step;
      // Everything before the window is "earlier".
      const limit = end - window - shingle;
      for (; this.indexed <= limit; this.indexed++) {
        this.seen.add(this.text.slice(this.indexed, this.indexed + shingle));
      }
      let hits = 0;
      let total = 0;
      for (let i = end - window; i + shingle <= end; i += 7) {
        total++;
        if (this.seen.has(this.text.slice(i, i + shingle))) hits++;
      }
      if (total && hits / total >= ratio) {
        this.streak++;
        if (this.streak >= need) {
          this.fired = true;
          this.release();
          return true;
        }
      } else {
        this.streak = 0;
      }
    }
    return false;
  }

  release() {
    this.seen = new Set();
  }
}
