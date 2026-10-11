// Drop-in widget, modelled on reCAPTCHA/Turnstile:
//
//   <form method="post">
//     <div class="agent-captcha" data-endpoint="/agent-captcha"></div>
//   </form>
//   <script type="module" src="/client.js"></script>
//
// On success a hidden <input name="agent-captcha-response"> is added to the enclosing form. Verify it on
// your server with `captcha.siteverify(value)`.
//
// Agents can bypass the UI: `agentCaptcha.getChallenge()` / `agentCaptcha.solve(answer)`, or read the
// JSON in <script data-agent-captcha-challenge>, or call the HTTP endpoints directly.

const FIELD = 'agent-captcha-response';

export async function requestChallenge(endpoint = '/agent-captcha', fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${endpoint}/challenge`);
  if (!res.ok) throw new Error(`challenge request failed: ${res.status}`);
  return res.json();
}

export async function submitAnswer(endpoint, token, answer, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${endpoint}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, answer }),
  });
  return res.json();
}

const CSS = `
.ac{--ac-bg:#fff;--ac-fg:#1f2328;--ac-muted:#656d76;--ac-line:#d0d7de;--ac-accent:#0969da;--ac-ok:#1a7f37;--ac-bad:#cf222e;
  box-sizing:border-box;width:304px;max-width:100%;border:1px solid var(--ac-line);border-radius:4px;background:var(--ac-bg);
  color:var(--ac-fg);font:14px/1.4 system-ui,sans-serif;box-shadow:0 1px 2px rgba(0,0,0,.08);overflow:hidden}
.ac[data-theme=dark]{--ac-bg:#161b22;--ac-fg:#e6edf3;--ac-muted:#8b949e;--ac-line:#30363d;--ac-accent:#58a6ff;--ac-ok:#3fb950;--ac-bad:#f85149}
.ac *{box-sizing:border-box}
.ac-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 14px}
.ac-check{all:unset;display:flex;align-items:center;gap:12px;cursor:pointer;flex:1;min-width:0}
.ac-check:focus-visible{outline:2px solid var(--ac-accent);outline-offset:4px;border-radius:4px}
.ac-check[aria-disabled=true]{cursor:default}
.ac-box{position:relative;flex:none;width:26px;height:26px;border:2px solid var(--ac-muted);border-radius:3px;display:grid;place-items:center}
.ac-check:hover:not([aria-disabled=true]) .ac-box{border-color:var(--ac-accent)}
.ac-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ac-brand{flex:none;font-size:10px;line-height:1.2;text-align:center;color:var(--ac-muted);letter-spacing:.02em}
.ac-brand b{display:block;font-size:18px;line-height:1}
.ac[data-agent-captcha-state=loading] .ac-box,.ac[data-agent-captcha-state=verifying] .ac-box{border-color:var(--ac-line);border-top-color:var(--ac-accent);border-radius:50%;animation:ac-spin .8s linear infinite}
.ac[data-agent-captcha-state=challenge] .ac-box{border-color:var(--ac-accent)}
.ac[data-agent-captcha-state=passed] .ac-box{border-color:var(--ac-ok);background:var(--ac-ok)}
.ac[data-agent-captcha-state=passed] .ac-box::after{content:"";width:6px;height:12px;border:solid #fff;border-width:0 3px 3px 0;transform:translateY(-1px) rotate(45deg)}
.ac[data-agent-captcha-state=failed] .ac-box,.ac[data-agent-captcha-state=error] .ac-box{border-color:var(--ac-bad)}
.ac[data-agent-captcha-state=failed] .ac-label,.ac[data-agent-captcha-state=error] .ac-label{color:var(--ac-bad)}
.ac-panel{border-top:1px solid var(--ac-line);padding:12px 14px 14px;display:grid;gap:10px}
.ac-panel[hidden]{display:none}
.ac-prompt{margin:0;padding:10px;border-radius:4px;background:color-mix(in srgb,var(--ac-line) 35%,transparent);font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
.ac-answer{width:100%;padding:8px 10px;border:1px solid var(--ac-line);border-radius:4px;background:var(--ac-bg);color:var(--ac-fg);font:13px ui-monospace,monospace}
.ac-answer:focus-visible{outline:2px solid var(--ac-accent);outline-offset:1px}
.ac-timer{height:4px;border-radius:2px;background:var(--ac-line);overflow:hidden}
.ac-timer>i{display:block;height:100%;width:100%;background:var(--ac-accent)}
@keyframes ac-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ac-box{animation-duration:2s!important}}
`;

const widgets = new Map();
let nextId = 0;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function injectStyle() {
  if (document.querySelector('style[data-agent-captcha]')) return;
  const style = el('style', { textContent: CSS });
  style.dataset.agentCaptcha = '';
  document.head.append(style);
}

const REASONS = {
  too_slow: 'Too slow — looks human',
  wrong_answer: 'Wrong answer',
  replayed: 'Challenge already used',
  network_error: 'Network error — retry',
};

/**
 * Render a widget into `container`. Options fall back to `data-*` attributes:
 * `data-endpoint`, `data-theme` (light|dark), `data-callback`, `data-error-callback`, `data-response-field`.
 * @returns {number} widget id
 */
export function render(container, opts = {}) {
  if (container.dataset.agentCaptchaId !== undefined) return Number(container.dataset.agentCaptchaId);
  injectStyle();

  const endpoint = opts.endpoint ?? container.dataset.endpoint ?? '/agent-captcha';
  const field = opts.responseField ?? container.dataset.responseField ?? FIELD;
  const resolveFn = (v) => (typeof v === 'string' ? globalThis[v] : v);
  const callback = resolveFn(opts.callback ?? container.dataset.callback);
  const errorCallback = resolveFn(opts.errorCallback ?? container.dataset.errorCallback);

  const id = nextId++;
  container.dataset.agentCaptchaId = String(id);
  const form = container.closest('form');
  const hidden = el('input', { type: 'hidden', name: field });
  (form ?? container).append(hidden);

  const box = el('span', { className: 'ac-box' });
  const label = el('span', { className: 'ac-label' });
  const check = el('button', { type: 'button', className: 'ac-check' }, box, label);
  check.setAttribute('role', 'checkbox');
  const brand = el('span', { className: 'ac-brand' }, el('b', { textContent: '🤖' }), 'Agent', el('br'), 'CAPTCHA');
  const promptEl = el('pre', { className: 'ac-prompt' });
  const answerEl = el('input', { type: 'text', className: 'ac-answer', autocomplete: 'off', spellcheck: false, placeholder: 'Answer, then Enter' });
  answerEl.setAttribute('aria-label', 'Answer');
  const timer = el('div', { className: 'ac-timer' }, el('i'));
  const panel = el('form', { className: 'ac-panel', hidden: true }, promptEl, answerEl, timer);
  const root = el('div', { className: 'ac' }, el('div', { className: 'ac-top' }, check, brand), panel);
  root.dataset.theme = opts.theme ?? container.dataset.theme ?? 'light';
  container.append(root);

  let challenge = null;
  let settled = true;
  let raf = 0;
  let expiry = 0;

  const setState = (state, text, checked = false) => {
    root.dataset.agentCaptchaState = state;
    container.dataset.agentCaptchaState = state;
    label.textContent = text;
    check.setAttribute('aria-checked', String(checked));
    check.setAttribute('aria-disabled', String(state !== 'idle' && state !== 'failed' && state !== 'error'));
  };

  function reset() {
    cancelAnimationFrame(raf);
    clearTimeout(expiry);
    challenge = null;
    settled = true;
    hidden.value = '';
    panel.hidden = true;
    container.querySelector('script[data-agent-captcha-challenge]')?.remove();
    setState('idle', "I'm an AI agent");
  }

  async function finish(answer) {
    if (settled || !challenge) return null;
    settled = true;
    cancelAnimationFrame(raf);
    setState('verifying', 'Verifying…');
    panel.hidden = true;
    let result;
    try {
      result = await submitAnswer(endpoint, challenge.token, String(answer));
    } catch {
      result = { success: false, reason: 'network_error' };
    }
    if (result.success) {
      hidden.value = result.response;
      setState('passed', `Verified agent · ${(result.elapsedMs / 1000).toFixed(2)}s`, true);
      expiry = setTimeout(reset, result.expiresInMs);
      callback?.(result.response);
    } else {
      hidden.value = '';
      setState(result.reason === 'network_error' ? 'error' : 'failed', REASONS[result.reason] ?? `Rejected (${result.reason})`);
      errorCallback?.(result);
    }
    return result;
  }

  async function start() {
    if (!settled) return;
    setState('loading', 'Loading…');
    try {
      challenge = await requestChallenge(endpoint);
    } catch {
      setState('error', 'Network error — retry');
      errorCallback?.({ success: false, reason: 'network_error' });
      return;
    }
    settled = false;
    const startedAt = performance.now();
    promptEl.textContent = challenge.prompt;
    answerEl.value = '';
    container.append(el('script', { type: 'application/json', textContent: JSON.stringify(challenge) }));
    container.lastChild.dataset.agentCaptchaChallenge = '';
    panel.hidden = false;
    setState('challenge', 'Solve it, fast');
    answerEl.focus();

    const tick = () => {
      const left = Math.max(0, challenge.timeLimitMs - (performance.now() - startedAt));
      timer.firstChild.style.width = `${(left / challenge.timeLimitMs) * 100}%`;
      if (left <= 0) finish(answerEl.value); // the server remains the judge: it times from issue, not from here
      else if (!settled) raf = requestAnimationFrame(tick);
    };
    tick();
  }

  check.addEventListener('click', () => {
    if (root.dataset.agentCaptchaState === 'idle' || root.dataset.agentCaptchaState === 'failed' || root.dataset.agentCaptchaState === 'error') {
      reset();
      start();
    }
  });
  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    finish(answerEl.value);
  });

  widgets.set(id, {
    getChallenge: () => challenge,
    solve: (answer) => finish(answer),
    getResponse: () => hidden.value,
    reset,
    isActive: () => !settled,
  });
  reset();
  return id;
}

const get = (id) => (id === undefined ? [...widgets.values()].find((w) => w.isActive()) ?? widgets.values().next().value : widgets.get(id));

export const agentCaptcha = {
  render,
  /** Current response token of widget `id` (default: first widget), or ''. */
  getResponse: (id) => get(id)?.getResponse() ?? '',
  reset: (id) => get(id)?.reset(),
  /** Agent lane: the open challenge ({ token, prompt, timeLimitMs, ... }) or null. */
  getChallenge: (id) => get(id)?.getChallenge() ?? null,
  /** Agent lane: submit an answer for the open challenge. Resolves with the verify result. */
  solve: (answer, id) => get(id)?.solve(answer) ?? Promise.resolve(null),
};

if (typeof document !== 'undefined') {
  globalThis.agentCaptcha = agentCaptcha;
  const auto = () => document.querySelectorAll('.agent-captcha').forEach((node) => render(node));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
}
