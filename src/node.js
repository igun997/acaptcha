const MAX_BODY = 16 * 1024;

/**
 * Adapt a web-standard handler (see createHandler) to node:http / Express-style (req, res, next).
 * Unmatched routes call `next()` if given, otherwise respond 404.
 */
export function toNodeListener(handler) {
  return async (req, res, next) => {
    try {
      const url = `http://${req.headers.host ?? 'localhost'}${req.url}`;
      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
      const response = await handler(new Request(url, { method: req.method, headers: req.headers, body }));
      if (!response) {
        if (next) return next();
        res.writeHead(404).end();
        return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      if (next) return next(err);
      res.writeHead(500).end();
    }
  };
}
