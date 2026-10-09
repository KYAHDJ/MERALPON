// Old releases stored unowned browser data. Never silently adopt those records.
export function accountRecordState(uid, record) {
  if (!record) return "new";
  if (record.ownerUid === uid) return "owned";
  if (record.ownerUid) return "blocked";
  return "review";
}

export function createAccountLease(uid, getCurrentUid) {
  let active = true;
  return {
    valid: () => active && getCurrentUid() === uid,
    close: () => { active = false; },
  };
}
