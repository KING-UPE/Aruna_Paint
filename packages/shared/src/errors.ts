/** Error codes shared by the server and the screens. Messages are plain words for staff. */
export const ERROR_CODES = [
  'VALIDATION',
  'UNAUTHENTICATED',
  'LOCKED',
  'FORBIDDEN',
  'APPROVAL_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'DUPLICATE',
  'INSUFFICIENT_STOCK',
  'BELOW_COST',
  'DISCOUNT_ABOVE_LIMIT',
  'PRICE_ABOVE_R_PRICE',
  'MONTH_CLOSED',
  'IN_USE',
  'INVALID_STATE',
  'PASSWORD_CHANGE_REQUIRED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Form field the message belongs under, e.g. "lines.2.qty". */
    field?: string;
    /** Extra data, e.g. the permission an approver needs. */
    details?: Record<string, unknown>;
  };
}

/** A domain rule failure that can be shown under a field. */
export interface RuleIssue {
  code: ErrorCode;
  field: string;
  message: string;
}

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly field?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
