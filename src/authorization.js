export const OPERATOR_USER_ID = "363466015683903488";

export function parseUserIds(value) {
  return new Set(String(value ?? "").split(/[\s,]+/).filter((id) => /^\d+$/.test(id)));
}

export function addApplicationOwners(ids, owner) {
  if (owner?.id) ids.add(owner.id);
  for (const member of owner?.members?.values?.() ?? []) {
    const id = member.id ?? member.user?.id;
    if (id) ids.add(id);
  }
  return ids;
}

export function canRunScan({ userId, memberPermissions, botOwnerIds = new Set() }) {
  return userId === OPERATOR_USER_ID
    || botOwnerIds.has(userId)
    || memberPermissions?.has?.("Administrator") === true;
}

export function scanCooldownRemaining(finishedAt, now = Date.now(), cooldownMs = 300000) {
  const finished = Date.parse(finishedAt ?? "");
  return Number.isFinite(finished) ? Math.max(0, cooldownMs - (now - finished)) : 0;
}
