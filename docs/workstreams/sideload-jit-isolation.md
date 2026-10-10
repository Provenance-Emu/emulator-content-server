# Sideload and JIT isolation

AltStore and SideStore style signing, device registration, JIT activation, and IPA distribution are a different product.

## Rules

- Create a separate repository when that work starts.
- Use a separate process, database, container, and credential store.
- Do not reuse content-server bearer tokens.
- Do not read the content blob directory.
- Do not advertise signing as a content-server capability.

## Acceptance

- This repository has no Apple ID, certificate, or provisioning-profile storage.
- `features` in `/api/v1/capabilities` does not grow a sideload flag.

## Non-goals

Implementing any sideload or JIT endpoint here.
