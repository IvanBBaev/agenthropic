/**
 * UX-19 - one USD cell of a dense table. The cell shows the column-aligned
 * figure (`formatUsdDense`); when that figure is the sub-cent shorthand, the
 * precise amount (`formatUsd`) is one hover away in the title, so `<$0.01`
 * hides digits from the column, not from the reader.
 *
 * `prefix` carries a marker that belongs to the figure, such as the `~ ` of an
 * estimate, into both the cell and its title.
 */
import { formatUsd, formatUsdDense } from '../format';

export function UsdCell({
  costUsd,
  prefix = '',
}: {
  readonly costUsd: number;
  readonly prefix?: string;
}) {
  const dense = formatUsdDense(costUsd);
  const precise = formatUsd(costUsd);
  return (
    <td className="num" title={dense === precise ? undefined : `${prefix}${precise}`}>
      {prefix}
      {dense}
    </td>
  );
}
