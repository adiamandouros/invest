// Exact decimal arithmetic for money, units and rates: values are BigInts
// holding the number × 10^8, so sums never pick up float rounding errors.
// Products and quotients round half away from zero to 8 decimals.

const PLACES = 8;
const SCALE = 10n ** BigInt(PLACES);

function roundDiv(n, d) {
    const q = n / d;
    const r = n % d;
    if (r === 0n) return q;
    const twice = (r < 0n ? -r : r) * 2n;
    const half = d < 0n ? -d : d;
    if (twice < half) return q;
    return (n < 0n) !== (d < 0n) ? q - 1n : q + 1n;
}

// From a string like "-12.5", a MySQL DECIMAL string or a number. null stays null.
export function dec(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'bigint') return value;
    const text = typeof value === 'number' ? value.toFixed(PLACES + 2) : String(value).trim();
    const match = text.match(/^([-+])?(\d*)(?:\.(\d*))?$/);
    if (!match || (!match[2] && !match[3])) throw new Error(`Not a number: ${value}`);
    const [, sign, whole, fraction = ''] = match;
    const digits = BigInt((whole || '0') + fraction.padEnd(PLACES + 1, '0').slice(0, PLACES + 1));
    const scaled = roundDiv(digits, 10n);
    return sign === '-' ? -scaled : scaled;
}

export const ZERO = 0n;
export const ONE = SCALE;
export const mul = (a, b) => roundDiv(a * b, SCALE);
export const div = (a, b) => roundDiv(a * SCALE, b);
export const neg = a => -a;
export const abs = a => (a < 0n ? -a : a);
export const sum = values => values.reduce((total, v) => total + v, 0n);

// Rounded to `places` decimals, e.g. fixed(dec('2.345'), 2) → "2.35"
export function fixed(value, places = 2) {
    const factor = 10n ** BigInt(PLACES - places);
    const rounded = roundDiv(value, factor);
    const negative = rounded < 0n;
    const digits = (negative ? -rounded : rounded).toString().padStart(places + 1, '0');
    const text = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
    return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

// Without trailing zeros, e.g. "12" or "0.5"
export const plain = value => fixed(value, PLACES).replace(/\.?0+$/, '') || '0';
