import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const site = new URL('../dist/api-reference/', import.meta.url);
const output = new URL('api/', site);
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'">
  <title>Emulator Content Server REST API</title>
  <meta name="description" content="Browse the Emulation Server REST API operations and download the OpenAPI specification.">
  <link rel="canonical" href="https://provenance-emu.com/emulator-content-server/api/">
  <link rel="icon" type="image/png" sizes="32x32" href="../assets/favicon.png">
  <link rel="stylesheet" href="./swagger-ui.css">
  <script defer src="./swagger-ui-bundle.js"></script>
  <script defer src="./init.js"></script>
</head>
<body>
  <header class="swagger-ui">
    <div class="wrapper">
      <h1>Emulator Content Server REST API</h1>
      <p>Browse operations and examples from the main branch. To run requests, open <code>/docs/</code> on your ECS server.</p>
      <p><a href="../">Emulation Server</a> · <a href="./openapi.yaml">Download OpenAPI YAML</a> · <a href="https://github.com/Provenance-Emu/emulator-content-server/wiki">Project wiki</a></p>
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

const sourceSite = new URL('../docs/site/', import.meta.url);
await cp(sourceSite, site, { recursive: true });

// Give the landing page fresh asset URLs when its controls or styles change.
let landing = await readFile(new URL('index.html', sourceSite), 'utf8');
for (const file of ['site.css', 'api-link.js', 'gallery.js', 'site-actions.js']) {
  const contents = await readFile(new URL(file, sourceSite));
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 12);
  const extension = file.lastIndexOf('.');
  const versioned = `${file.slice(0, extension)}.${hash}${file.slice(extension)}`;
  await writeFile(new URL(versioned, site), contents);
  landing = landing.replace(`"./${file}"`, `"./${versioned}"`);
}
await writeFile(new URL('index.html', site), landing);
await mkdir(output, { recursive: true });
const outputPath = (file) => new URL(file, output);
await Promise.all([
  writeFile(outputPath('index.html'), html),
  writeFile(outputPath('init.js'), init),
  copyFile(
    new URL('../packages/protocol/openapi/openapi.yaml', import.meta.url),
    outputPath('openapi.yaml'),
  ),
  copyFile(
    new URL('../packages/protocol/openapi/openapi.yaml', import.meta.url),
    new URL('openapi.yaml', site),
  ),
  ...['swagger-ui-bundle.js', 'swagger-ui.css', 'LICENSE'].map((file) =>
    copyFile(require.resolve(`swagger-ui-dist/${file}`), outputPath(file)),
  ),
]);
