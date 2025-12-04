# Repo-specific instructions

- When making changes under `backend/`, prefer to add or update automated tests alongside the code where appropriate (unit tests in `backend/tests`, using Vitest).
- Always run the backend test suite before committing backend changes:
  - From `backend/`: `npm install` (once per environment), then `npm test` (runs `npx vitest run`).
  - You can run specific tests with `npx vitest run tests/<file>.test.{js,mjs}` during development.
- New backend tests should:
  - Use the shared helpers in `backend/tests/helpers/test-utils.mjs` to create isolated config directories when touching config-dependent code.
  - Prefer descriptive `describe`/`it` names and keep tests isolated (no reliance on global state across files).
