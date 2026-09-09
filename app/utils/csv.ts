export function csvCell(value: string | number | null | undefined) {
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && /^\s*[=+\-@\t\r]/.test(value))
    text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function csvRows(
  headers: string[],
  rows: (string | number | null | undefined)[][],
) {
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\r\n");
}
