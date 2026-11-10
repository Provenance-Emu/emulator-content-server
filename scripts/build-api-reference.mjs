import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const output = new URL('../dist/api-reference/', import.meta.url);
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'">
  <title>Emulator Content Server REST API</title>
  <link rel="stylesheet" href="./swagger-ui.css">
  <script defer src="./swagger-ui-bundle.js"></script>
  <script defer src="./init.js"></script>
</head>
<body>
  <header class="swagger-ui">
    <div class="wrapper">
      <h1>Emulator Content Server REST API</h1>
      <p>Browse operations and examples from the main branch. To run requests, open <code>/docs/</code> on your ECS server.</p>
      <p><a href="./openapi.yaml">Download OpenAPI YAML</a> · <a href="https://github.com/Provenance-Emu/emulator-content-server/wiki">Project wiki</a></p>
    </div>
  </header>
  <main id="swagger-ui"></main>
</body>
</html>
`;

const init = `window.ui = SwaggerUIBundle({
  dom_id: '#swagger-ui',
  url: './openapi.yaml',
  deepLinking: true,
  filter: true,
  docExpansion: 'none',
  defaultModelsExpandDepth: -1,
  persistAuthorization: false,
  supportedSubmitMethods: [],
  validatorUrl: null,
  plugins: [() => ({
    wrapComponents: {
      authorizeBtn: () => () => null,
      authorizeOperationBtn: () => () => null,
      servers: () => () => null
    }
  })]
});
`;

await mkdir(output, { recursive: true });
const outputPath = (file) => new URL(file, output);
await Promise.all([
  writeFile(outputPath('index.html'), html),
  writeFile(outputPath('init.js'), init),
  copyFile(
    new URL('../packages/protocol/openapi/openapi.yaml', import.meta.url),
    outputPath('openapi.yaml'),
  ),
  ...['swagger-ui-bundle.js', 'swagger-ui.css', 'LICENSE'].map((file) =>
    copyFile(require.resolve(`swagger-ui-dist/${file}`), outputPath(file)),
  ),
]);
