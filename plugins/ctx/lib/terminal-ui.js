export function section(title) {
  return `\n${title}\n${"-".repeat(title.length)}`;
}

export function table(headers, rows) {
  const normalizedRows = rows.map((row) => row.map((cell) => String(cell ?? "")));
  const widths = headers.map((header, index) => Math.max(
    String(header).length,
    ...normalizedRows.map((row) => row[index]?.length || 0)
  ));
  const formatRow = (row) => row.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ");
  return [
    formatRow(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...normalizedRows.map(formatRow)
  ].join("\n");
}

export function truncateCell(value, max = 80) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}
