export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function fail(message, exitCode = 1) {
  throw new CliError(message, exitCode);
}

