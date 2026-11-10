/** API links follow the connected server, including in the bundled desktop library. */
export function documentationLinks(origin: string) {
  return [
    { label: 'Interactive API reference', href: new URL('/docs/', origin).href },
    { label: 'OpenAPI contract', href: new URL('/openapi.yaml', origin).href },
    {
      label: 'Project wiki',
      href: 'https://github.com/Provenance-Emu/emulator-content-server/wiki',
    },
  ];
}
