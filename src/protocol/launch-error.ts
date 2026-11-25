/** Shared error identity for launch policy and the frozen v2 codec. */

export class LaunchInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchInvocationError";
  }
}
