import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createAgentCaptcha, createHandler } from '../src/index.js';
import { toNodeListener } from '../src/node.js';

const captcha = createAgentCaptcha({
  secret: process.env.CAPTCHA_SECRET ?? randomBytes(32).toString('hex'),
  timeLimitMs: Number(process.env.TIME_LIMIT_MS ?? 10_000),
});
const captchaRoutes = toNodeListener(createHandler(captcha, { basePath: '/api/agent-captcha' }));

const files = {
  '/': ['demo/index.html', 'text/html; charset=utf-8'],
  '/client.js': ['src/client.js', 'text/javascript; charset=utf-8'],
};

const readBody = async (req) => {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new Error('body too large');
  }
  return body;
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  // An ordinary form handler: the only captcha-specific line is `siteverify`.
  if (pathname === '/api/register' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const check = await captcha.siteverify(form.get('agent-captcha-response') ?? '');
    res.writeHead(check.success ? 200 : 403, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        check.success
          ? { registered: form.get('name'), message: 'Welcome, fellow machine.' }
          : { error: 'agent verification failed', reason: check.reason },
      ),
    );
    return;
  }

  if (files[pathname]) {
    const [path, type] = files[pathname];
    res.writeHead(200, { 'content-type': type });
    res.end(await readFile(new URL(`../${path}`, import.meta.url)));
    return;
  }

  captchaRoutes(req, res);
}).listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`agent-captcha demo on http://localhost:${process.env.PORT ?? 3000}`);
});
