// One compact puzzle per challenge. Each puzzle chains 2-3 trivial operations over a list of ~10-18
// items: a language model answers it in a single pass, a human needs 15-30s of careful scanning.
// Phrasing is randomised per challenge so answers/regexes cannot be cached.

const ZWSP = '\u200b';

const WORDS = [
  'anchor', 'basalt', 'cobalt', 'dynamo', 'ember', 'falcon', 'garnet', 'harbor', 'island', 'jasmine',
  'kernel', 'lantern', 'meadow', 'nebula', 'orchid', 'pepper', 'quartz', 'raven', 'saddle', 'timber',
  'umbra', 'velvet', 'walnut', 'xenon', 'yonder', 'zephyr', 'copper', 'dagger', 'fabric', 'glacier',
  'hollow', 'ivory', 'jungle', 'knight', 'marble', 'needle', 'oyster', 'pillar', 'quiver', 'ribbon',
  'spruce', 'tundra', 'violet', 'willow', 'yellow', 'canyon', 'delta', 'forest', 'harvest', 'meteor',
];

/** Fast, seedable PRNG (mulberry32). Not cryptographic: the seed never leaves the server. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}

/** Canonical form used on both sides of the comparison. */
export function normalizeAnswer(value) {
  return String(value)
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/["'`“”‘’.]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

const KINDS = {
  /** Two filters, then sort + join. */
  filterSort({ sample, pick, n }) {
    let words, kept;
    do {
      words = sample(WORDS, 16);
      kept = words.filter((w) => w.length % 2 === 0 && w.includes('e'));
    } while (kept.length < 3 || kept.length > 6);
    const rule = pick([
      `${n('Keep only the words that have an even number of letters and contain the letter')} "e". ${n('Sort them alphabetically and join them with hyphens')}.`,
      `${n('From the list, select words with an even letter count that also contain')} "e", ${n('then output them in alphabetical order separated by hyphens')}.`,
    ]);
    return { instruction: rule, data: words.join(' '), answer: [...kept].sort().join('-') };
  },

  /** Filter by two arithmetic properties, then sum. */
  numbers({ int, pick, n }) {
    let nums, kept;
    do {
      nums = Array.from({ length: 14 }, () => int(10, 99));
      kept = nums.filter((x) => x % 2 === 1 && x % 3 === 0);
    } while (kept.length < 3 || kept.length > 5);
    const rule = pick([
      `${n('Add up only the numbers that are odd and divisible by 3')}.`,
      `${n('Sum the values that are both odd and a multiple of 3, ignoring the rest')}.`,
    ]);
    return { instruction: rule, data: nums.join(' '), answer: String(kept.reduce((a, b) => a + b, 0)) };
  },

  /** Strided pick, initials, reverse. */
  stride({ sample, pick, n }) {
    const words = sample(WORDS, 18);
    const picked = [1, 4, 7, 10, 13, 16].map((i) => words[i]);
    const rule = pick([
      `${n('Starting from the 2nd word, take every 3rd word')} (2nd, 5th, 8th, ...). ${n('Write the first letter of each, in reverse order, as one string')}.`,
      `${n('Take the 2nd, 5th, 8th, 11th, 14th and 17th words')}. ${n('Reverse their order and output only their first letters joined together')}.`,
    ]);
    return { instruction: rule, data: words.join(' '), answer: picked.map((w) => w[0]).reverse().join('') };
  },

  /** Drop numbers, filter by initial, reverse the list. */
  mixed({ int, sample, pick, n }) {
    let tokens, kept;
    do {
      const words = sample(WORDS, 12);
      const nums = Array.from({ length: 6 }, () => String(int(1, 99)));
      tokens = sample([...words, ...nums], 18);
      kept = tokens.filter((t) => /^[a-z]/.test(t) && t[0] <= 'm');
    } while (kept.length < 3 || kept.length > 7);
    const rule = pick([
      `${n('Ignore all numbers. Keep only the words that start with a letter from a to m, then list them in reverse order separated by commas')}.`,
      `${n('Discard the numbers, then keep words whose first letter is between a and m, and print them back to front, comma separated')}.`,
    ]);
    return { instruction: rule, data: tokens.join(' '), answer: [...kept].reverse().join(',') };
  },

  /** Most and fewest vowels (both unique), word-level answer. */
  vowels({ sample, pick, n }) {
    const count = (w) => (w.match(/[aeiou]/g) ?? []).length;
    let words, most, fewest;
    for (;;) {
      words = sample(WORDS, 10);
      const counts = words.map(count);
      const hi = Math.max(...counts);
      const lo = Math.min(...counts);
      if (counts.filter((c) => c === hi).length === 1 && counts.filter((c) => c === lo).length === 1) {
        most = words[counts.indexOf(hi)];
        fewest = words[counts.indexOf(lo)];
        break;
      }
    }
    const rule = pick([
      `${n('Find the word with the most vowels')} (a, e, i, o, u) ${n('and the word with the fewest vowels')}. ${n('Reply with the first, a hyphen, then the second')}.`,
      `${n('Which word has the highest vowel count and which the lowest')}? ${n('Answer as highest-lowest')}.`,
    ]);
    return { instruction: rule, data: words.join(' '), answer: `${most}-${fewest}` };
  },
};

export const PUZZLE_KINDS = Object.keys(KINDS);

/**
 * Deterministically build one puzzle from a seed.
 * @returns {{ kind: string, prompt: string, answer: string }} `answer` is already normalised
 */
export function generatePuzzle(seed, kind) {
  const rand = mulberry32(seed);
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const sample = (arr, k) => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, k);
  };
  // Zero-width noise inside instruction words only; breaks naive substring/regex matching.
  const n = (text) =>
    text.replace(/[A-Za-z]{5,}/g, (w) => {
      const i = int(1, w.length - 1);
      return w.slice(0, i) + ZWSP + w.slice(i);
    });

  const chosen = kind ?? pick(PUZZLE_KINDS);
  if (!(chosen in KINDS)) throw new RangeError(`unknown puzzle kind: ${chosen}`);
  const { instruction, data, answer } = KINDS[chosen]({ int, pick, sample, n });
  return { kind: chosen, prompt: `${instruction}\n\n${data}`, answer: normalizeAnswer(answer) };
}
