# Contributing

1. Fork the repository and create a branch for one logical change.
2. Read `AGENTS.md` for package ownership and dependency direction.
3. Change the OpenAPI document first when the wire contract changes, then run `pnpm generate` and `pnpm update-surface`.
4. Add or update tests in the package you touched.
5. Run `pnpm verify`. Run `swift test --package-path clients/swift` when the Swift client changes.

Pull requests need a short explanation of behavior, risk, and how it was verified. Do not include copyrighted game data, credentials, or generated `dist/` output.

Security reports go through `SECURITY.md`, not a public issue.
