// The row whose name matches exactly (ignoring case), else the only row whose name
// contains or is contained in the query. Ambiguous or missing matches return undefined.
export function byName<T extends { name: string }>(
  rows: T[],
  query: string,
): T | undefined {
  const lower = query.trim().toLowerCase();
  if (!lower) return undefined;
  const exact = rows.find((r) => r.name.toLowerCase() === lower);
  if (exact) return exact;
  const similar = rows.filter(
    (r) =>
      r.name.toLowerCase().includes(lower) ||
      lower.includes(r.name.toLowerCase()),
  );
  return similar.length === 1 ? similar[0] : undefined;
}
