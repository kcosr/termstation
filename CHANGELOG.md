# Changelog

## [Unreleased]

### Added

- Installer: interactive upgrade mode when the selected app install directory already exists. Prompts Upgrade/Reinstall/Cancel before other prompts. ([#4])
  - Always reinstalls backend dependencies and rebuilds backend tools
  - Skips container rebuild and config interpolation
  - Optional builds for external helpers: chat-to-html and pty-to-html
  - Completion now reminds you to stop any running backend/frontend before restarting

## [0.0.1] - 2025-12-03

### Added

- Initial public release (pre-alpha).

[#4]: https://github.com/kcosr/termstation/pull/4
