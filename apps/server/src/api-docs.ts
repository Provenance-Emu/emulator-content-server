import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Emulator Content Server API</title>
  <link rel="stylesheet" href="/docs/swagger-ui.css">
  <script defer src="/docs/swagger-ui-bundle.js"></script>
  <script defer src="/docs/init.js"></script>
</head>
<body>
  <p><a href="/openapi.yaml">OpenAPI YAML</a></p>
  <div id="swagger-ui"></div>
</body>
</html>`;

const init = `SwaggerUIBundle({
  dom_id: '#swagger-ui',
  url: '/openapi.yaml',
  deepLinking: true,
  docExpansion: 'none',
  defaultModelsExpandDepth: -1,
  filter: true,
  persistAuthorization: false,
  validatorUrl: null
});`;

export function registerApiDocs(app: FastifyInstance): void {
  app.get('/docs', async (_request, reply) => reply.redirect('/docs/', 308));
  app.get('/docs/', async (_request, reply) =>
    reply
      .header(
        'content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .header('referrer-policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(html),
  );
  app.get('/docs/init.js', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(init),
  );
  const assets = [
    ['swagger-ui-bundle.js', 'text/javascript; charset=utf-8'],
    ['swagger-ui.css', 'text/css; charset=utf-8'],
  ] as const;
  for (const [name, type] of assets) {
    const file = new URL(import.meta.resolve(`swagger-ui-dist/${name}`));
    app.get(`/docs/${name}`, async (_request, reply) =>
      reply.type(type).send(createReadStream(file)),
    );
  }
}
