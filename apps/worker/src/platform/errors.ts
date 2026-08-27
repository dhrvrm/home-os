export class HomeOSError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends HomeOSError {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message, "invalid_request", 400);
  }
}

export class NotFoundError extends HomeOSError {
  constructor(
    readonly entityType: string,
    readonly entityId: string,
  ) {
    super(`${entityType.replaceAll("_", " ")} not found`, "not_found", 404);
  }
}

export class ConflictError extends HomeOSError {
  constructor(
    readonly entityType: string,
    readonly entityId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super("This item changed on another device. Review the latest version before retrying.", "conflict", 409);
  }
}
