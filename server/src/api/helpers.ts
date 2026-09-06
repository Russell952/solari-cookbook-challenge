import type { Request } from "express";

/**
 * Extract a route parameter as a single string.
 * Express 5 types params as `string | string[]`; this normalises to `string`.
 */
export function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}
