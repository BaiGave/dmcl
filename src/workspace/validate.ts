const MOD_ID_RE = /^[a-z][a-z0-9_]{1,63}$/;

export function isValidModId(modId: string): boolean {
  return MOD_ID_RE.test(modId);
}

export function assertValidModId(modId: string): void {
  if (!isValidModId(modId)) {
    throw new Error("modId 需为小写字母开头，仅含小写字母、数字、下划线");
  }
}
