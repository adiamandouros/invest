# Writes the made-up PeerBerry exports test/fixtures/peerberry-{1,2}.xlsx: two
# overlapping periods, like yearly exports. Run: python3 test/fixtures/make-peerberry.py
import datetime, zipfile
from xml.sax.saxutils import escape

HEADER = ['ID', 'Date', 'Type', 'Amount', 'Currency', 'Loan Id', 'Country', 'Loan Status']
ROWS = {
    1001: ('2024-05-14', 'DEPOSIT', '200', ''), 1002: ('2024-05-14', 'INVESTMENT', '-150', 'L1'),
    1003: ('2024-05-20', 'INVESTMENT', '-40', 'L2'), 1004: ('2024-05-31', 'REPAYMENT_INTEREST', '0.8', 'L2'),
    1005: ('2024-05-31', 'REPAYMENT_PRINCIPAL', '10', 'L2'), 1006: ('2024-06-10', 'BUYBACK_INTEREST', '1.25', 'L1'),
    1007: ('2024-06-10', 'BUYBACK_PRINCIPAL', '140', 'L1'), 1008: ('2024-06-12', 'INVESTMENT', '-100', 'L3'),
    1009: ('2024-07-01', 'WITHDRAWAL', '-50', ''), 1010: ('2024-07-15', 'BUYBACK_INTEREST', '0.5', 'L2'),
    1011: ('2024-07-15', 'BUYBACK_PRINCIPAL', '30', 'L2'),
}
FILES = {'peerberry-1.xlsx': [1007, 1006, 1005, 1004, 1003, 1002, 1001], 'peerberry-2.xlsx': [1011, 1010, 1009, 1008, 1007, 1006]}

def xlsx(path, ids):
    strings = []
    def s(text):
        if text not in strings: strings.append(text)
        return strings.index(text)
    def cell(ref, value, kind):
        if kind == 's': return f'<c r="{ref}" t="s"><v>{s(value)}</v></c>'
        return f'<c r="{ref}"><v>{value}</v></c>'
    rows = ['<row r="1">' + ''.join(cell(f'{chr(65 + i)}1', h, 's') for i, h in enumerate(HEADER)) + '</row>']
    for n, i in enumerate(ids, 2):
        date, kind, amount, loan = ROWS[i]
        # One date as an Excel day number, as some exports have them
        d = cell(f'B{n}', (datetime.date.fromisoformat(date) - datetime.date(1899, 12, 30)).days, 'n') if i == 1011 else cell(f'B{n}', date, 's')
        rows.append(f'<row r="{n}">' + cell(f'A{n}', i, 'n') + d + cell(f'C{n}', kind, 's') + cell(f'D{n}', amount, 'n')
                    + cell(f'E{n}', 'EUR', 's') + (cell(f'F{n}', loan, 's') if loan else '') + cell(f'G{n}', 'Testland', 's')
                    + cell(f'H{n}', 'FINISHED', 's') + '</row>')
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    files = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
        '_rels/.rels': f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="{ns}" xmlns:r="{rel}"><sheets><sheet name="Transactions" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{rel}/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{ns}"><sheetData>{"".join(rows)}</sheetData></worksheet>',
    }
    files['xl/sharedStrings.xml'] = f'<?xml version="1.0" encoding="UTF-8"?><sst xmlns="{ns}" count="{len(strings)}" uniqueCount="{len(strings)}">' + ''.join(f'<si><t>{escape(t)}</t></si>' for t in strings) + '</sst>'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            info = zipfile.ZipInfo(name, (2024, 1, 1, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, text)

import os
here = os.path.dirname(os.path.abspath(__file__))
for name, ids in FILES.items(): xlsx(os.path.join(here, name), ids)
