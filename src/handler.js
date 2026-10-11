const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * Web-standard handler (Request -> Response | null) for Bun, Deno, Workers, Hono, etc.
 *   GET  {basePath}/challenge  -> { token, prompt, timeLimitMs, ... }
 *   POST {basePath}/verify     -> body { token, answer } -> { success, response } | { success:false, reason }
 * Returns `null` when the route does not match so it can be composed with your own routing.
 * The final check (`captcha.siteverify`) is done in-process by your own backend, never over HTTP.
 */
export function createHandler(captcha, { basePath = '/agent-captcha' } = {}) {
  return async function handle(request) {
    const { pathname } = new URL(request.url);
    if (pathname === `${basePath}/challenge` && request.method === 'GET') {
      return json(await captcha.issue());
    }
    if (pathname === `${basePath}/verify` && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, reason: 'bad_format' }, 400);
      }
      const result = await captcha.verify(body?.token, body?.answer);
      const rejected = result.reason === 'too_slow' || result.reason === 'wrong_answer';
      return json(result, result.success ? 200 : rejected ? 403 : 400);
    }
    return null;
  };
}
