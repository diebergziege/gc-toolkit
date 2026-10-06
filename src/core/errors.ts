/** Error with a stable code and an actionable hint, rendered the same way by CLI and MCP. */
export class GctkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "GctkError";
  }

  format(): string {
    return this.hint ? `${this.code}: ${this.message}\nHint: ${this.hint}` : `${this.code}: ${this.message}`;
  }
}

export function formatError(err: unknown): string {
  if (err instanceof GctkError) return err.format();
  if (err instanceof Error) return err.message;
  return String(err);
}
