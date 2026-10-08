/*!
Column widths for exported tables.

The editor stores a table's column widths in its delimiter row, as
Pandoc reads them: each column's share is its number of dashes. Hush
only honours them when the dashes total exactly 100 (the editor's
`table-model.js` says why — hand-typed and formatter-padded rows would
otherwise read as deliberate widths), so a table resized in the editor
prints with the same proportions, and any other table keeps Typst's
content-sized columns.
*/

/// What the dashes of a width-carrying delimiter row add up to.
const WIDTH_TOTAL: usize = 100;

/// The widths `table_src` (a pipe table's source, header row first)
/// carries, one per column — or `None` when its delimiter row doesn't
/// total `WIDTH_TOTAL` dashes over exactly `columns` cells.
pub fn explicit_widths(table_src: &str, columns: usize) -> Option<Vec<usize>> {
    let delim = table_src.lines().nth(1)?.trim();
    let delim = delim.strip_prefix('|').unwrap_or(delim);
    let delim = delim.strip_suffix('|').unwrap_or(delim);
    let dashes: Vec<usize> = delim
        .split('|')
        .map(|cell| cell.trim().trim_matches(':').len())
        .collect();
    let total: usize = dashes.iter().sum();
    (dashes.len() == columns && total == WIDTH_TOTAL && dashes.iter().all(|d| *d > 0))
        .then_some(dashes)
}

/// The `columns:` argument of a Typst `#table`: the widths as fractions
/// when the table carries them, else the column count (that many
/// content-sized columns).
pub fn columns_arg(widths: Option<&[usize]>, columns: usize) -> String {
    match widths {
        Some(w) => {
            let parts: Vec<String> = w.iter().map(|d| format!("{d}fr")).collect();
            format!("({},)", parts.join(", "))
        }
        None => columns.max(1).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_totalling_100_are_read() {
        let src = "| Year | Title | Link |\n|--------|------------------------------------------------------------------|--------------------------|\n| 1980 | x | y |";
        assert_eq!(explicit_widths(src, 3), Some(vec![8, 66, 26]));
    }

    #[test]
    fn alignment_colons_are_not_dashes() {
        let src = "a | b\n:----------------------------------------:|------------------------------------------------------------:\n1 | 2";
        assert_eq!(explicit_widths(src, 2), Some(vec![40, 60]));
    }

    #[test]
    fn hand_typed_rows_carry_no_widths() {
        assert_eq!(explicit_widths("| a | b |\n|------|-------|\n", 2), None);
        assert_eq!(explicit_widths("| a | b |\n| --- | --- |\n", 2), None);
    }

    #[test]
    fn a_column_count_mismatch_carries_no_widths() {
        let src = format!("| a | b |\n|{}|\n", "-".repeat(100));
        assert_eq!(explicit_widths(&src, 2), None);
    }

    #[test]
    fn columns_argument() {
        assert_eq!(columns_arg(Some(&[8, 66, 26]), 3), "(8fr, 66fr, 26fr,)");
        assert_eq!(columns_arg(None, 3), "3");
        assert_eq!(columns_arg(None, 0), "1");
    }
}
