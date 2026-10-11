# Sideload installer and JIT activation

Install Provenance, iCube, and iFly onto an iOS device from this machine, keep the installs from expiring, and turn on JIT for the ones that need it. The isolation rules in [Sideload and JIT isolation](sideload-jit-isolation.md) and [ADR 0006](../architecture/decisions/0006-sideload-colocation.md) hold without exception: separate process, separate data directory, separate database, separate credentials, no route on `/api/v1`.

## Owned paths

- `apps/sideload` (new): its own entry point, data directory, and SQLite database
- `packages/signing` (new): IPA inspection and the signing plan, no network and no filesystem outside a temporary directory
- `docs/operations/sideloading.md` (new)

## What it does

- Holds a signing identity, the devices allowed to receive a build, and the installed apps with their expiry.
- Takes an IPA, works out what has to change inside it, re-signs it for one device, and installs it.
- Reinstalls before a build expires, which for a free Apple account is every seven days.
- Turns on JIT for an installed app, which an interpreter-backed emulator needs to run at a usable speed.
- Reports what is missing instead of failing mid-install: no identity, no paired device, a profile that does not cover the bundle id, an expiry that already passed.

## Signing identity

Phase one takes an identity the operator already has: a `.p12` certificate with its password and a `.mobileprovision` profile, exported from an Apple Developer account. No Apple ID, password, or two-factor secret enters this system, which is the strongest version of the promise ADR 0006 makes. The operator pays for a developer account or accepts that a free profile has to be re-exported weekly.

Phase two, only if phase one is working, adds Apple ID sign-in so a free account can be used without exporting anything by hand. That needs Apple's authentication (SRP, two-factor, and anisette data from a provisioning server), certificate and profile creation, and device registration against a private Apple service. It is the fragile part of every project in this space and it is where a stored credential would appear, so it is deliberately not in the first slice.

## Device access and JIT

Neither re-signing nor talking to an iOS device is work this repository should reimplement. `apps/sideload` orchestrates tools that already do it and refuses to run when one is absent:

- `zsign` re-signs the bundle. It runs on Linux, macOS, and Windows, so the server does not have to be a Mac.
- `pymobiledevice3` pairs, lists devices, installs, mounts the developer disk image, opens the iOS 17 and later tunnel, and attaches `debugserver`.

JIT is that last step: with a tunnel open and the disk image mounted, attaching the debug server to a running app marks the process debuggable, which is what lets its interpreter map executable pages. The app must already be installed and launched; this does not patch, inject, or modify a running app.

A `doctor` command reports each tool, its version, whether a device is paired, and what the identity covers, because every failure in this area is a missing prerequisite rather than a bug.

## Rules

- `apps/sideload` depends on `@ecs/signing` and nothing else from this repository. The boundary check must fail on an import of `@ecs/storage`, `@ecs/database`, or `@ecs/domain`.
- The certificate, its password, and the profile live in the sideload data directory at mode `0600`, never in the content database and never in an environment variable that a child process inherits.
- A certificate password is never passed on a command line, where it would appear in the process list.
- Nothing from this app is logged at a level that includes the password, the certificate bytes, or the profile's private contents. A log line may name a bundle id, a device name, and an expiry.
- An IPA is never written into the content blob store, and the content server is never asked for one.
- `packages/signing` does the reasoning about a bundle: what its identifier is, which entitlements the profile grants, whether the profile covers the device, when it expires. That is pure, so it is tested without a device.

## Acceptance

- `ecs-sideload doctor` reports the missing prerequisite for every state: no tool, no identity, no paired device, an expired profile, a profile whose bundle id does not match the IPA.
- A generated IPA fixture with a synthetic bundle is inspected, planned, and refused with a clear reason when the profile does not match. No real app and no real certificate are committed.
- Signing and installing are covered by tests that stop at the tool boundary: the command the app would run is asserted, so the suite needs no device.
- The content server passes `pnpm verify` with the sideload app absent, and `doctor` for the content server never mentions it.
- No Apple credential appears in a log, an audit detail, a discovery record, or a command line.

## Non-goals

Distributing IPAs to strangers, bypassing Apple's device limits, patching or injecting into a running app, and anything that needs a jailbreak. Phase two's Apple ID sign-in is out of scope until phase one installs an app end to end.
