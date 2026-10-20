/**
 * Column geometry for a markdown table, kept free of React Native and of the
 * markdown library so it can be pinned under `node --test`.
 *
 * `react-native-markdown-display` renders every `tr` as an independent
 * `flexDirection: 'row'` View, so nothing sizes a *column* across rows: a cell
 * sized to its own content (flex/min/max) slides every column out from under its
 * header. One width per column index, computed once from the table's AST and read
 * by every cell at that index, is what keeps `3.66` under `Before`.
 *
 * Nothing can be measured before layout, so the width is estimated from content.
 * 13 px system text averages ~7.1 px per glyph, and header cells are 600-weight
 * and run ~8% wider. The estimate only has to be *consistent* down a column: a
 * column that comes out slightly wide is harmless — the table scrolls sideways —
 * and one that comes out narrow wraps. Both bounds are clamped so a
 * one-character column stays legible and a paragraph-length cell wraps instead of
 * pushing the table off the phone.
 */

/**
 * The subset of the library's `ASTNode` this layer reads. Cell text is nested
 * under `inline` → `text` children, so it is summed rather than taken from the
 * cell's own (empty) `content`.
 */
export interface TableAstNode {
  type: string;
  content?: string;
  children?: TableAstNode[];
}

const glyphWidth = 7.1;
const headerWeightFactor = 1.08;
const minColumnWidth = 72;
const maxColumnWidth = 240;

function cellTextLength(node: TableAstNode): number {
  if (!node.children?.length) {
    return typeof node.content === "string" ? node.content.length : 0;
  }
  return node.children.reduce((total, child) => total + cellTextLength(child), 0);
}

function collectRows(node: TableAstNode, rows: TableAstNode[]): void {
  if (node.type === "tr") {
    rows.push(node);
    return;
  }
  node.children?.forEach((child) => collectRows(child, rows));
}

/**
 * One width per column index — the widest cell at that index across every row,
 * header included. Ragged rows contribute the columns they have; a column no row
 * reaches simply has no width, and its cells fall back to intrinsic sizing.
 *
 * `cellPadding` is the cell's total horizontal padding. It stays a parameter
 * because it is a theme token, and this module owns no theme.
 */
export function computeColumnWidths(table: TableAstNode, cellPadding: number): number[] {
  const rows: TableAstNode[] = [];
  collectRows(table, rows);

  const widths: number[] = [];
  for (const row of rows) {
    row.children?.forEach((cell, columnIndex) => {
      const weight = cell.type === "th" ? headerWeightFactor : 1;
      const estimate = Math.ceil(cellTextLength(cell) * glyphWidth * weight) + cellPadding;
      const clamped = Math.min(Math.max(estimate, minColumnWidth), maxColumnWidth);
      widths[columnIndex] = Math.max(widths[columnIndex] ?? 0, clamped);
    });
  }

  return widths;
}
