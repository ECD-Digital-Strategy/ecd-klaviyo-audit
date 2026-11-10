// Discounted invoice lines in whole cents that add up exactly to the signed total.
// A discount is spread over the lines proportionally, so each line lands on a fraction of a cent. Rounding each
// one on its own could leave the invoice a cent or two off the total the client signed; the leftover goes on the
// last line instead (or the nearest line before it that stays above zero).

/** Each amount rounded to cents, with the rounding remainder moved so the sum is the total rounded to cents. */
export function roundLinesToTotal(amounts: number[], total: number = amounts.reduce((s, a) => s + a, 0)): number[] {
  const cents = amounts.map((a) => Math.round(a * 100));
  let diff = Math.round(total * 100) - cents.reduce((s, c) => s + c, 0);
  for (let i = cents.length - 1; i >= 0 && diff !== 0; i--) {
    // Never push a line to zero or below: try the line before it.
    const next = cents[i] + diff;
    if (next > 0) {
      cents[i] = next;
      diff = 0;
    }
  }
  return cents.map((c) => c / 100);
}
