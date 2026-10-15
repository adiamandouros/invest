// Reads a multipart/form-data body (a form with a file upload), as a Buffer
// from express.raw(). Returns { fields: { name: text }, files: { name: { filename, data } },
// uploads: { name: [{ filename, data }, ...] } }: `files` has the first file of
// each name, `uploads` all of them (an <input type="file" multiple>).
// Enough for the app's own forms; not a general-purpose parser.
export function parseMultipart(body, contentType) {
    const boundary = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundary || !Buffer.isBuffer(body)) throw new Error('Not a multipart form');
    const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
    const fields = {};
    const files = {};
    const uploads = {};

    let start = body.indexOf(delimiter);
    while (start !== -1) {
        const next = body.indexOf(delimiter, start + delimiter.length);
        if (next === -1) break;
        // Each part: \r\n, headers, \r\n\r\n, content, \r\n
        const part = body.subarray(start + delimiter.length + 2, next - 2);
        const split = part.indexOf('\r\n\r\n');
        if (split !== -1) {
            const headers = part.subarray(0, split).toString('utf8');
            const content = part.subarray(split + 4);
            const name = headers.match(/name="([^"]*)"/i)?.[1];
            const filename = headers.match(/filename="([^"]*)"/i)?.[1];
            if (name !== undefined) {
                if (filename !== undefined) {
                    files[name] ??= { filename, data: content };
                    (uploads[name] ??= []).push({ filename, data: content });
                }
                else fields[name] = content.toString('utf8');
            }
        }
        start = next;
    }
    return { fields, files, uploads };
}
