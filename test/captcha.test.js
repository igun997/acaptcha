import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCaptcha, createHandler, generatePuzzle, PUZZLE_KINDS } from '../src/index.js';

const SECRET = 'test-secret-test-secret-1234';
const SEED = 42;

function setup(extra = {}) {
  const clock = { t: 1_000_000 };
  const captcha = createAgentCaptcha({
    secret: SECRET,
    timeLimitMs: 10_000,
    now: () => clock.t,
    seed: () => SEED,
    ...extra,
  });
  return { captcha, clock, answer: generatePuzzle(SEED).answer };
}

test('correct answer inside the window passes and the response survives siteverify once', async () => {
  const { captcha, clock, answer } = setup();
  const ch = await captcha.issue();
  clock.t += 1_500;
  const res = await captcha.verify(ch.token, answer);
  assert.equal(res.success, true);
  assert.equal(res.elapsedMs, 1_500);
  assert.deepEqual(await captcha.siteverify(res.response), { success: true, challengeTs: 1_001_500 });
  assert.deepEqual(await captcha.siteverify(res.response), { success: false, reason: 'replayed' });
});

test('human-speed solve is rejected even with the correct answer', async () => {
  const { captcha, clock, answer } = setup();
  const ch = await captcha.issue();
  clock.t += 10_001;
  assert.deepEqual(await captcha.verify(ch.token, answer), { success: false, reason: 'too_slow', elapsedMs: 10_001 });
});

test('challenge token is single-use, including after a wrong attempt', async () => {
  const { captcha, answer } = setup();
  const first = await captcha.issue();
  assert.equal((await captcha.verify(first.token, answer)).success, true);
  assert.equal((await captcha.verify(first.token, answer)).reason, 'replayed');

  const second = await captcha.issue();
  assert.equal((await captcha.verify(second.token, 'nope')).reason, 'wrong_answer');
  assert.equal((await captcha.verify(second.token, answer)).reason, 'replayed');
});

test('answers are compared leniently on case, whitespace, quotes and zero-width characters', async () => {
  const { captcha, answer } = setup();
  const ch = await captcha.issue();
  const messy = ` "${answer.toUpperCase().split('').join('\u200b')}". `;
  assert.equal((await captcha.verify(ch.token, messy)).success, true);
});

test('tampered or foreign tokens are refused', async () => {
  const { captcha, answer } = setup();
  const ch = await captcha.issue();
  const [body, sig] = ch.token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), exp: 9e15 })).toString('base64url');
  assert.equal((await captcha.verify(`${forged}.${sig}`, answer)).reason, 'invalid_token');

  const other = createAgentCaptcha({ secret: 'another-secret-another-secret', seed: () => SEED });
  assert.equal((await captcha.verify((await other.issue()).token, answer)).reason, 'invalid_token');
});

test('non-string answers are refused without consuming the token', async () => {
  const { captcha, answer } = setup();
  const ch = await captcha.issue();
  assert.equal((await captcha.verify(ch.token, ['x'])).reason, 'bad_format');
  assert.equal((await captcha.verify(ch.token, answer)).success, true);
});

test('responses expire, and challenge tokens cannot be used as responses', async () => {
  const { captcha, clock, answer } = setup({ responseTtlMs: 1_000 });
  const ch = await captcha.issue();
  assert.equal((await captcha.siteverify(ch.token)).reason, 'invalid_response');
  const res = await captcha.verify(ch.token, answer);
  clock.t += 1_001;
  assert.equal((await captcha.siteverify(res.response)).reason, 'expired');
});

test('every puzzle kind is deterministic and its answer follows from the data it shows', () => {
  const words = (s) => s.split(' ');
  const checks = {
    filterSort: (data) => words(data).filter((w) => w.length % 2 === 0 && w.includes('e') && w[0] <= 'm').sort().join('-'),
    numbers: (data) => String(words(data).map(Number).filter((x) => x % 2 === 1 && x % 3 === 0).reduce((a, b) => a + b, 0)),
    stride: (data) => words(data).filter((_, i) => i % 3 === 1).map((w) => w[0]).reverse().join(''),
    mixed: (data) => words(data).filter((t) => /^[a-z]/.test(t) && t[0] <= 'f').reverse().join(','),
    extremes: (data) => {
      const six = words(data).filter((w) => w.length === 6).sort();
      return `${six[0]}-${six[six.length - 1]}`;
    },
  };
  assert.deepEqual(Object.keys(checks).sort(), [...PUZZLE_KINDS].sort());

  for (const kind of PUZZLE_KINDS) {
    for (let seed = 0; seed < 200; seed++) {
      const p = generatePuzzle(seed, kind);
      assert.deepEqual(p, generatePuzzle(seed, kind));
      const data = p.prompt.split('\n\n')[1];
      assert.equal(p.answer, checks[kind](data), `${kind} seed ${seed}`);
    }
  }
  assert.throws(() => generatePuzzle(1, 'nope'), RangeError);
});

test('http handler: challenge -> verify round trip, unknown routes fall through', async () => {
  const { captcha, answer } = setup();
  const handle = createHandler(captcha, { basePath: '/c' });
  const ch = await (await handle(new Request('http://x/c/challenge'))).json();
  const post = (body) => handle(new Request('http://x/c/verify', { method: 'POST', body: JSON.stringify(body) }));
  assert.equal((await post({ token: ch.token, answer: 'wrong' })).status, 403);
  assert.equal((await post({ token: ch.token, answer })).status, 400); // burned by the wrong attempt
  const ch2 = await (await handle(new Request('http://x/c/challenge'))).json();
  const ok = await post({ token: ch2.token, answer });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).success, true);
  assert.equal(await handle(new Request('http://x/other')), null);
});
