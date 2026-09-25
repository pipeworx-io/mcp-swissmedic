/**
 * Minimal read-only XLSX reader — enough for one machine-generated sheet, no
 * deps. Copy of mcps/ema-medicines/src/xlsx.ts (a Worker can't reasonably
 * carry a zip/xlsx library for one file per pack, and the two files are
 * small enough that keeping them in sync by eye is cheaper than a shared
 * dependency neither pack's build wants).
 */

const td = new TextDecoder();

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 66_000);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function inflateRaw(bytes: Uint8Array): Promise<string> {
  const body = new Response(bytes).body;
  if (!body) throw new Error('cannot stream zip entry');
  return await new Response(body.pipeThrough(new DecompressionStream('deflate-raw'))).text();
}

export async function unzipText(
  buffer: ArrayBuffer,
  wanted: string[],
): Promise<Record<string, string>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const want = new Set(wanted);
  const out: Record<string, string> = {};

  for (let i = 0; i < count && p + 46 <= view.byteLength; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!want.has(name)) continue;

    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const slice = bytes.subarray(start, start + compressedSize);
    out[name] = method === 0 ? td.decode(slice) : await inflateRaw(slice);
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#039;': "'",
};

function unescapeXml(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    const known = ENTITIES[m];
    if (known !== undefined) return known;
    const code = m[2] === 'x' || m[2] === 'X'
      ? parseInt(m.slice(3, -1), 16)
      : parseInt(m.slice(2, -1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

const T_RE = /<t[^>]*>([\s\S]*?)<\/t>/g;

function textOf(xml: string): string {
  let s = '';
  T_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = T_RE.exec(xml)) !== null) s += m[1];
  return unescapeXml(s);
}

export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(textOf(m[1]));
  return out;
}

// The `[^>]*?` MUST be lazy — a greedy attribute match swallows the `/` of a
// self-closing `<c .../>` and runs on to the next cell's `</c>`, silently
// shifting every value in the row by one column.
const CELL_RE = /<c\s+r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const V_RE = /<v>([\s\S]*?)<\/v>/;

export interface SheetScan {
  rows: Map<number, Record<string, string>>;
}

export function scanSheet(sheetXml: string, shared: string[]): SheetScan {
  const rows = new Map<number, Record<string, string>>();
  CELL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CELL_RE.exec(sheetXml)) !== null) {
    const inner = m[4];
    if (!inner) continue;
    const attrs = m[3];
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
    let value: string;
    if (type === 's') {
      const v = V_RE.exec(inner);
      if (!v) continue;
      value = shared[Number(v[1])] ?? '';
    } else if (type === 'inlineStr' || type === 'str') {
      value = textOf(inner);
    } else {
      const v = V_RE.exec(inner);
      if (!v) continue;
      value = unescapeXml(v[1]);
    }
    value = value.trim();
    if (!value) continue;
    const rowNum = Number(m[2]);
    let row = rows.get(rowNum);
    if (!row) {
      row = {};
      rows.set(rowNum, row);
    }
    row[m[1]] = value;
  }
  return { rows };
}
