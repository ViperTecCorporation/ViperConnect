export const normalizeHistoryMaxAgeDays = (value: unknown): number => {
  const days = Math.trunc(Number(value))
  return Number.isFinite(days) && days > 0 ? Math.min(days, 3_650) : 30
}
