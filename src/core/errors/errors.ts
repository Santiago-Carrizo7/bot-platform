export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'APP_ERROR',
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado') {
    super(message, 'NOT_FOUND', 404);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'No autenticado') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'No autorizado') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class TenantError extends AppError {
  constructor(message = 'Contexto de negocio inválido') {
    super(message, 'TENANT_ERROR', 403);
  }
}

export class AIProviderError extends AppError {
  constructor(message: string, public readonly provider: string, statusCode?: number) {
    super(message, 'AI_PROVIDER_ERROR', statusCode ?? 502);
  }
}

export class AIInterpretationError extends AppError {
  constructor(message: string, public readonly rawOutput?: string) {
    super(message, 'AI_INTERPRETATION_ERROR', 422);
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', 500);
  }
}
