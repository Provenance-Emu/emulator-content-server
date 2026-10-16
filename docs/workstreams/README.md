# Follow-on workstreams

The foundation in this repository is the contract, storage, access control, and reference server. The briefs below are independent enough for parallel agents after they read `AGENTS.md`. Each brief names the paths it may change. Leave every other path alone.

| Brief | Outcome |
| --- | --- |
| [App adapters](app-adapters.md) | Provenance, iCube, and iFly clients |
| [Scanning and metadata](scanning-metadata.md) | Opt-in read-only library scan |
| [WebDAV compatibility](webdav-compatibility.md) | Authenticated legacy file access |
| [Virtual formats](virtual-formats.md) | ZIP first, then disc-specific providers |
| [Content roots](content-roots.md) | Saved read-only collection folders |
| [Media availability](media-availability.md) | External, network, and iCloud files stay put until requested, and clients see offline |
| [Web playback](web-playback.md) | In-browser play of the same files and accounts, after a folder can be streamed |
| [Container install](container-install.md) | Docker for a VM or cloud host, without trusting the bridge address |
| [Storage locations](storage-locations.md) | Blobs across more than one directory |
| [Service lifecycle](service-lifecycle.md) | Start at login on macOS, Linux, Windows |
| [Desktop UI](desktop-ui.md) | Web and menu-bar client over the same API |
| [Remote access](remote-access.md) | VPN now, relay only after a new threat model |
| [Sideload and JIT isolation](sideload-jit-isolation.md) | Separate process and credentials, same repository |
| [Sideload installer](sideload-installer.md) | Install the apps on a device, keep them signed, enable JIT |
| [Sync](sync.md) | Devices converge without losing a save |
| [Plugins](../operations/plugins.md) | Connectors, feeds, player, signer, and JIT in a separate process |
| [Adversarial validation](adversarial-validation.md) | Fuzz and security regression pack |

Signing, JIT activation, and IPA distribution stay out of the content server process, database, and capability document. They may live in this repository as a separate app. See [ADR 0006](../architecture/decisions/0006-sideload-colocation.md).
