# Follow-on workstreams

The foundation in this repository is the contract, storage, access control, and reference server. The briefs below are independent enough for parallel agents after they read `AGENTS.md`. Each brief names the paths it may change. Leave every other path alone.

| Brief | Outcome |
| --- | --- |
| [App adapters](app-adapters.md) | Provenance, iCube, and iFly clients |
| [Scanning and metadata](scanning-metadata.md) | Opt-in read-only library scan |
| [WebDAV compatibility](webdav-compatibility.md) | Authenticated legacy file access |
| [Virtual formats](virtual-formats.md) | ZIP first, then disc-specific providers |
| [Desktop UI](desktop-ui.md) | Web and menu-bar client over the same API |
| [Remote access](remote-access.md) | VPN now, relay only after a new threat model |
| [Sideload and JIT isolation](sideload-jit-isolation.md) | Separate project, separate credentials |
| [Adversarial validation](adversarial-validation.md) | Fuzz and security regression pack |

Do not implement signing, JIT activation, or IPA distribution inside this repository.
