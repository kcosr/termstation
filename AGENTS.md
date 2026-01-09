# Repo-specific instructions

## Backend Testing

- When making changes under `backend/`, prefer to add or update automated tests alongside the code where appropriate (unit tests in `backend/tests`, using Vitest).
- Always run the backend test suite before committing backend changes:
  - From `backend/`: `npm install` (once per environment), then `npm test` (runs `npx vitest run`).
  - You can run specific tests with `npx vitest run tests/<file>.test.{js,mjs}` during development.
- New backend tests should:
  - Use the shared helpers in `backend/tests/helpers/test-utils.mjs` to create isolated config directories when touching config-dependent code.
  - Prefer descriptive `describe`/`it` names and keep tests isolated (no reliance on global state across files).

## Changelog

Location: `CHANGELOG.md` (root)

### Format

Use these sections under `## [Unreleased]`:
- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- New entries ALWAYS go under `## [Unreleased]`
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections (e.g., `## [0.0.3]`)
- Use inline PR links: `([#123](https://github.com/kcosr/termstation/pull/123))`

### Attribution

- Internal changes: `Fixed foo bar ([#123](https://github.com/kcosr/termstation/pull/123))`
- External contributions: `Added feature X ([#456](https://github.com/kcosr/termstation/pull/456) by [@user](https://github.com/user))`

## Releasing

### During Development

When PRs are merged to main, add changelog entries under `## [Unreleased]`. This can be done as part of the PR or immediately after merge.

### When Ready to Release

1. Checkout and update main:
   ```bash
   git checkout main && git pull
   ```
2. Verify `## [Unreleased]` in CHANGELOG.md has all changes documented
3. Run the release script:
   ```bash
   npm run release:patch    # Bug fixes (0.0.3 -> 0.0.4)
   npm run release:minor    # New features (0.0.4 -> 0.1.0)
   npm run release:major    # Breaking changes (0.1.0 -> 1.0.0)
   ```

### What the Script Does

1. Verifies working directory is clean (no uncommitted changes)
2. Bumps `VERSION` file
3. Updates CHANGELOG: `## [Unreleased]` -> `## [X.Y.Z] - YYYY-MM-DD`
4. Commits "Release vX.Y.Z" and creates git tag
5. Pushes commit and tag to origin
6. Creates GitHub prerelease with notes extracted from CHANGELOG
7. Adds new `## [Unreleased]` section with `_No unreleased changes._` placeholder
8. Commits "Prepare for next release" and pushes
