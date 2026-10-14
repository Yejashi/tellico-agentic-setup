// Chat-app style text pacing. The model emits tokens in clusters (speculative
// decoding accepts several drafted tokens per round) and the relay batches
// them every ~120 ms on top of that; revealing the received text at a rate
// that follows the backlog turns both into a steady flow.
//
// The same curve as the tellico-vscode extension, which was measured to move
// on every frame without falling behind.

export const PACE = { tau: 160, doneTau: 70, minRate: 60, doneMinRate: 1500 };

// How many characters (fractional) to show after dtMs more milliseconds: the
// larger of an exponential approach to the target and a constant floor, so a
// big burst drains fast and the last few characters never stall.
export function advance(shown, target, dtMs, done, pace = PACE) {
  if (shown >= target) return target;
  const backlog = target - shown;
  const approach = backlog * (1 - Math.exp(-dtMs / (done ? pace.doneTau : pace.tau)));
  const floor = ((done ? pace.doneMinRate : pace.minRate) * dtMs) / 1000;
  return Math.min(target, shown + Math.max(approach, floor));
}

// A cut that does not split a UTF-16 surrogate pair.
export function safeCut(text, n) {
  if (n <= 0) return 0;
  if (n >= text.length) return text.length;
  const c = text.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? n + 1 : n;
}
