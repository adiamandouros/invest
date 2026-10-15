import { inflateRawSync } from 'zlib';

// Reads the first sheet of an Excel .xlsx file into rows of cell texts, with
// only Node's zlib: an .xlsx is a zip of XML files. Enough for the platforms'
// exports (strings, numbers, dates as text or as day numbers); not a general
// Excel reader.

export const isXlsx = data => Buffer.isBuffer(data) && data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

// { name: Buffer } for each file in the zip, from its central directory
function unzip(data) {
    const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end === -1) throw new Error('The file isn\'t a readable Excel file');
    const count = data.readUInt16LE(end + 10);
    let at = data.readUInt32LE(end + 16);
    const files = {};
    for (let i = 0; i < count; i++) {
        if (data.readUInt32LE(at) !== 0x02014b50) throw new Error('The file isn\'t a readable Excel file');
        const method = data.readUInt16LE(at + 10);
        const size = data.readUInt32LE(at + 20);
        const nameLength = data.readUInt16LE(at + 28);
        const extraLength = data.readUInt16LE(at + 30);
        const commentLength = data.readUInt16LE(at + 32);
        const local = data.readUInt32LE(at + 42);
        const name = data.toString('utf8', at + 46, at + 46 + nameLength);
        const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
        const raw = data.subarray(start, start + size);
        if (method === 0) files[name] = raw;
        else if (method === 8) files[name] = inflateRawSync(raw);
        at += 46 + nameLength + extraLength + commentLength;
    }
    return files;
}

const XML_ESCAPES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = text => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) => {
    if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    return XML_ESCAPES[code] ?? all;
});
// The text of an <si> or <is>: its <t> parts, also inside rich-text runs
const textOf = xml => unescape([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));

// Column letters → index: A → 0, Z → 25, AA → 26
const column = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

// Rows of the first sheet as arrays of strings ('' for empty cells)
export function readXlsx(data) {
    const files = unzip(data);
    const sheetName = Object.keys(files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
    if (!sheetName) throw new Error('The Excel file has no sheet');
    const shared = files['xl/sharedStrings.xml']
        ? [...files['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]))
        : [];
    const rows = [];
    for (const [, body] of files[sheetName].toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const row = [];
        for (const [, attrs, inner = ''] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const ref = attrs.match(/\sr="([A-Z]+)\d+"/)?.[1];
            const type = attrs.match(/\st="(\w+)"/)?.[1];
            const value = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
            const text = type === 's' ? shared[Number(value)] ?? ''
                : type === 'inlineStr' ? textOf(inner)
                    : unescape(value ?? '');
            row[ref ? column(ref) : row.length] = text;
        }
        rows.push(Array.from(row, cell => cell ?? ''));
    }
    return rows;
}

// An Excel day number (days since 1899-12-30) as 'YYYY-MM-DD'; other text unchanged
export function excelDate(value) {
    if (!/^\d+(\.\d+)?$/.test(value)) return value;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(value)) * 86_400_000).toISOString().slice(0, 10);
}
