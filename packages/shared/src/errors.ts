import { ZodError } from "zod";

export function isZodError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
