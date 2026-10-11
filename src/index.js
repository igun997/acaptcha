import { generatePuzzle, normalizeAnswer, randomSeed, PUZZLE_KINDS } from './tasks.js';
import { MemoryReplayStore } from './store.js';

export { MemoryReplayStore, PUZZLE_KINDS, generatePuzzle, normalizeAnswer };
export { createHandler } from './handler.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (str) => {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const safeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * @typedef {object} Options
 * @property {string} secret              HMAC key, >= 16 chars. Keep it server-side.
 * @property {number} [timeLimitMs=10000] Server-measured budget from issue() to verify().
 * @property {number} [responseTtlMs=120000] Lifetime of the response token handed to the form.
 * @property {{ consume(id: string, ttlMs: number): Promise<boolean> }} [store] Single-use enforcement.
 * @property {() => number} [now]         Clock, for tests.
 * @property {() => number} [seed]        32-bit seed source, for tests.
 */

/** @param {Options} options */
export function createAgentCaptcha(options) {
  const {
    secret,
    timeLimitMs = 10_000,
    responseTtlMs = 120_000,
    store = new MemoryReplayStore(),
    now = Date.now,
    seed = randomSeed,
  } = options ?? {};
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('createAgentCaptcha: `secret` must be a string of at least 16 characters');
  }

  const keyPromise = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
  const hmac = async (text) => b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await keyPromise, enc.encode(text))));

  async function seal(payload) {
    const body = b64url(enc.encode(JSON.stringify(payload)));
    return `${body}.${await hmac(body)}`;
  }

  /** Returns the payload if the signature is valid and the token has the expected type. */
  async function open(token, type) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    try {
      const valid = await crypto.subtle.verify('HMAC', await keyPromise, fromB64url(parts[1]), enc.encode(parts[0]));
      if (!valid) return null;
      const payload = JSON.parse(dec.decode(fromB64url(parts[0])));
      return payload?.t === type ? payload : null;
    } catch {
      return null;
    }
  }

  const answerDigest = (id, answer) => hmac(`${id}\n${answer}`);

  return {
    /** Create a challenge. Send `prompt` to the caller; `token` carries the sealed expected answer. */
    async issue() {
      const issuedAt = now();
      const id = b64url(crypto.getRandomValues(new Uint8Array(12)));
      const puzzle = generatePuzzle(seed());
      const token = await seal({
        t: 'c',
        id,
        iat: issuedAt,
        exp: issuedAt + timeLimitMs,
        h: await answerDigest(id, puzzle.answer),
      });
      return {
        token,
        issuedAt,
        timeLimitMs,
        prompt: puzzle.prompt,
        answerFormat: 'one line, lowercase, no explanation',
      };
    },

    /**
     * Check a solved challenge. A token is single-use: any attempt that reaches the answer
     * comparison burns it, right or wrong.
     * @returns {Promise<{ success: true, response: string, expiresInMs: number, elapsedMs: number } | { success: false, reason: string, elapsedMs?: number }>}
     */
    async verify(token, answer) {
      const p = await open(token, 'c');
      if (!p) return { success: false, reason: 'invalid_token' };
      if (typeof answer !== 'string' || answer.length > 512) return { success: false, reason: 'bad_format' };
      const t = now();
      const elapsedMs = t - p.iat;
      if (t > p.exp) return { success: false, reason: 'too_slow', elapsedMs };
      if (!(await store.consume(`c:${p.id}`, p.exp - t + 1000))) return { success: false, reason: 'replayed' };
      if (!safeEqual(await answerDigest(p.id, normalizeAnswer(answer)), p.h)) {
        return { success: false, reason: 'wrong_answer', elapsedMs };
      }
      return {
        success: true,
        elapsedMs,
        expiresInMs: responseTtlMs,
        response: await seal({ t: 'p', id: p.id, iat: t, exp: t + responseTtlMs }),
      };
    },

    /**
     * Server-side check of the `agent-captcha-response` form field. Single-use, like reCAPTCHA siteverify.
     * @returns {Promise<{ success: true, challengeTs: number } | { success: false, reason: string }>}
     */
    async siteverify(response) {
      const p = await open(response, 'p');
      if (!p) return { success: false, reason: 'invalid_response' };
      const t = now();
      if (t > p.exp) return { success: false, reason: 'expired' };
      if (!(await store.consume(`p:${p.id}`, p.exp - t + 1000))) return { success: false, reason: 'replayed' };
      return { success: true, challengeTs: p.iat };
    },
  };
}
