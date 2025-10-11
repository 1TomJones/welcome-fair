export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Box–Muller transform for gaussian-ish noise
export function gaussianRandom() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function averagePrice({ previousAvg, previousQty, tradePrice, tradeQty }) {
  if (tradeQty === 0) return previousAvg ?? tradePrice;
  const totalQty = Math.abs(previousQty) + Math.abs(tradeQty);
  if (totalQty === 0) return null;
  return (
    (Math.abs(previousQty) * (previousAvg ?? tradePrice) +
      Math.abs(tradeQty) * tradePrice) /
    totalQty
  );
}
