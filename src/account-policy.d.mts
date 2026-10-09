export function accountRecordState(uid: string, record?: { ownerUid?: string } | null): "new" | "owned" | "blocked" | "review";
export function createAccountLease(uid: string, getCurrentUid: () => string | undefined): { valid: () => boolean; close: () => void };
