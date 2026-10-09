// This is the complete set of documents written by this application.
// Add new account-owned documents here whenever the storage schema grows.
export function deletionPaths(uid) {
  if (typeof uid !== "string" || !uid || uid.includes("/")) throw new Error("Invalid account");
  return [
    ["users", uid, "tracker", "state"],
    ["users", uid, "recovery", "before-account-fix"],
    ["users", uid],
  ];
}
