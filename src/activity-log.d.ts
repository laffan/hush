/**
 * Types for `activity-log.js` — the notebook bundle is TypeScript and
 * logs into the same permanent console the rest of the app uses.
 */
export type ActivityLevel = "info" | "warn" | "error";

export declare function logActivity(
  source: string,
  level: ActivityLevel,
  message: string,
  detail?: unknown,
): void;

export declare function configureActivityLog(opts?: {
  windowLabel?: string;
  deskName?: () => string;
}): void;

export declare function flushActivityLog(): Promise<void>;
export declare function readActivityLog(limit?: number): Promise<unknown[]>;
export declare function clearActivityLog(): Promise<void>;
export declare function installActivityCapture(): void;
