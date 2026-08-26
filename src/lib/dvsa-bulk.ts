import { createInflateRaw } from "node:zlib";
import { getAccessToken } from "./dvla-auth";
import { odometerToMiles } from "./mot-history";

// DVSA MOT History API — bulk-download endpoint. Lists a weekly bulk file
// plus daily delta files (every vehicle created/updated/deleted in the last
// 24h, full record each). We only consume the deltas: registrations are
// matched against our own vehicles table, so the 500k-record bulk files are
// never needed. Same OAuth + API-key auth as the per-registration lookup in
// dvla.ts. Download URLs are presigned and expire 5 minutes after listing —
// list, then download promptly.

export type BulkFileInfo = {
  filename: string;
  downloadUrl: string;
  fileSize: number;
  fileCreatedOn: string;
};

export type BulkDownloadListing = {
  bulk: BulkFileInfo[];
  delta: BulkFileInfo[];
};

export async function listBulkDownloadFiles(): Promise<BulkDownloadListing> {
  const apiKey = process.env.DVSA_API_KEY;
  if (!apiKey) throw new Error("DVSA API key not configured.");

  const token = await getAccessToken();
  const res = await fetch("https://history.mot.api.gov.uk/v1/trade/vehicles/bulk-download", {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DVSA bulk-download listing failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as Partial<BulkDownloadListing>;
  return {
    bulk: Array.isArray(json.bulk) ? json.bulk : [],
    delta: Array.isArray(json.delta) ? json.delta : [],
  };
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader. Delta files are ZIP archives of JSON; we only need
// central-directory walking + deflate, so a dependency isn't warranted.
// ZIP64 is rejected — delta files are tens of MB, nowhere near the 4GB mark.
// ---------------------------------------------------------------------------

export type ZipEntry = {
  filename: string;
  /** 0 = stored, 8 = deflate */
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
};

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function listZipEntries(buf: Buffer): ZipEntry[] {
  // EOCD is within the last 65557 bytes (comment can pad it); scan backwards.
  const scanFrom = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP file (no end-of-central-directory record).");

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error("Corrupt ZIP central directory.");
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const filenameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("ZIP64 archives are not supported.");
    }
    const filename = buf.toString("utf8", p + 46, p + 46 + filenameLen);
    entries.push({ filename, method, compressedSize, localHeaderOffset });
    p += 46 + filenameLen + extraLen + commentLen;
  }
  return entries;
}

function entryCompressedData(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localHeaderOffset;
  if (buf.readUInt32LE(p) !== LOCAL_SIG) throw new Error("Corrupt ZIP local file header.");
  // Local-header filename/extra lengths can differ from the central copy.
  const filenameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + filenameLen + extraLen;
  return buf.subarray(start, start + entry.compressedSize);
}

// ---------------------------------------------------------------------------
// Incremental JSON record scanner. The files hold one JSON object per
// vehicle; tolerant of both NDJSON and a single top-level array, since the
// docs show records but don't pin the framing. Tracks brace depth outside
// strings and emits each complete top-level object.
// ---------------------------------------------------------------------------

export class JsonRecordScanner {
  private tail = "";
  private depth = 0;
  private inString = false;
  private escaped = false;

  /** Feed a chunk; returns the complete JSON object strings it closed. */
  push(chunk: string): string[] {
    const text = this.tail + chunk;
    const out: string[] = [];
    // If a partial record was carried over, tail starts exactly at its "{".
    let start = this.depth > 0 ? 0 : -1;

    for (let i = this.tail.length; i < text.length; i++) {
      const c = text[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') {
        this.inString = true;
      } else if (c === "{") {
        if (this.depth === 0) start = i;
        this.depth++;
      } else if (c === "}") {
        this.depth--;
        if (this.depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
      // Everything else at depth 0 (array brackets, commas, whitespace) is framing.
    }

    this.tail = start >= 0 ? text.slice(start) : "";
    return out;
  }
}

// ---------------------------------------------------------------------------
// Delta record extraction
// ---------------------------------------------------------------------------

export type DeltaMotTest = {
  /** YYYY-MM-DD */
  testDate: string;
  result: string | null;
  /** Normalised to miles at extraction (KM readings converted). */
  odometerMiles: number | null;
  defects: { text: string; type: string }[];
};

export type DeltaVehicleUpdate = {
  registration: string;
  normalizedReg: string;
  modification: "CREATED" | "UPDATED" | "DELETED" | null;
  /**
   * Latest PASSED test expiry across the record's test history, YYYY-MM-DD.
   * Never-tested vehicles have no tests; DVSA's motTestDueDate (first MOT
   * due) is used instead so new cars stay in sync too.
   */
  motExpiry: string | null;
  /** Most recent completed test date, YYYY-MM-DD. */
  lastTestDate: string | null;
  /**
   * Full parsed test history from the record (#596) — the delta record is
   * the complete vehicle record, so each matched vehicle gets its whole
   * odometer + defect series refreshed nightly at zero extra API cost.
   */
  tests: DeltaMotTest[];
};

export function normalizeRegistration(reg: string): string {
  return reg.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

// DVSA dates appear as ISO ("2026-01-17T14:23:21.000Z"), bare dates, or the
// legacy "2026.01.17 14:23:21" form depending on payload vintage. Normalise
// to YYYY-MM-DD; null for anything unparseable.
export function parseDvsaDate(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 10) return null;
  const datePart = raw.slice(0, 10).replace(/\./g, "-");
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

export function extractDeltaUpdate(record: Record<string, unknown>): DeltaVehicleUpdate | null {
  const registration = typeof record.registration === "string" ? record.registration : null;
  if (!registration) return null;

  const rawMod = typeof record.modification === "string" ? record.modification.toUpperCase() : null;
  const modification =
    rawMod === "CREATED" || rawMod === "UPDATED" || rawMod === "DELETED" ? rawMod : null;

  type RawTest = {
    completedDate?: unknown;
    testResult?: unknown;
    expiryDate?: unknown;
    odometerValue?: unknown;
    odometerUnit?: unknown;
    defects?: unknown;
    rfrAndComments?: unknown;
  };
  const tests = Array.isArray(record.motTests) ? (record.motTests as RawTest[]) : [];

  let motExpiry: string | null = null;
  let lastTestDate: string | null = parseDvsaDate(record.lastMotTestDate);
  const parsedTests: DeltaMotTest[] = [];
  for (const t of tests) {
    const completed = parseDvsaDate(t.completedDate);
    if (completed) {
      if (!lastTestDate || completed > lastTestDate) lastTestDate = completed;
      const rawDefects = Array.isArray(t.defects)
        ? t.defects
        : Array.isArray(t.rfrAndComments) // legacy payload name
          ? t.rfrAndComments
          : [];
      parsedTests.push({
        testDate: completed,
        result: typeof t.testResult === "string" ? t.testResult.toUpperCase() : null,
        odometerMiles: odometerToMiles(t.odometerValue, t.odometerUnit),
        defects: (rawDefects as { text?: unknown; type?: unknown }[])
          .filter((d) => typeof d?.text === "string")
          .map((d) => ({ text: String(d.text), type: String(d.type ?? "ADVISORY") })),
      });
    }
    if (String(t.testResult ?? "").toUpperCase() !== "PASSED") continue;
    const expiry = parseDvsaDate(t.expiryDate);
    if (expiry && (!motExpiry || expiry > motExpiry)) motExpiry = expiry;
  }
  // New-reg records carry no tests but do carry the first-MOT due date.
  if (!motExpiry) motExpiry = parseDvsaDate(record.motTestDueDate);

  return {
    registration,
    normalizedReg: normalizeRegistration(registration),
    modification,
    motExpiry,
    lastTestDate,
    tests: parsedTests,
  };
}

// ---------------------------------------------------------------------------
// File processing: download → unzip → scan → extract, streaming the inflate
// so the (much larger) uncompressed JSON never sits in memory at once.
// ---------------------------------------------------------------------------

const MAX_DELTA_FILE_BYTES = 250 * 1024 * 1024;

export async function downloadDeltaFile(file: BulkFileInfo): Promise<Buffer> {
  if (file.fileSize > MAX_DELTA_FILE_BYTES) {
    throw new Error(`Delta file ${file.filename} too large (${file.fileSize} bytes).`);
  }
  const res = await fetch(file.downloadUrl);
  if (!res.ok) {
    throw new Error(`Delta file download failed (${res.status}) for ${file.filename}.`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function scanDeltaZip(
  zip: Buffer,
  onRecord: (update: DeltaVehicleUpdate) => void,
): Promise<{ scanned: number }> {
  let scanned = 0;

  const handleJson = (objText: string) => {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(objText) as Record<string, unknown>;
    } catch {
      return; // skip malformed record rather than abort the file
    }
    const update = extractDeltaUpdate(record);
    if (!update) return;
    scanned++;
    onRecord(update);
  };

  for (const entry of listZipEntries(zip)) {
    if (!entry.filename.toLowerCase().endsWith(".json")) continue;
    const compressed = entryCompressedData(zip, entry);
    const scanner = new JsonRecordScanner();
    const decoder = new TextDecoder("utf-8");

    if (entry.method === 0) {
      for (const obj of scanner.push(decoder.decode(compressed))) handleJson(obj);
    } else if (entry.method === 8) {
      await new Promise<void>((resolve, reject) => {
        const inflater = createInflateRaw();
        inflater.on("data", (chunk: Buffer) => {
          for (const obj of scanner.push(decoder.decode(chunk, { stream: true }))) handleJson(obj);
        });
        inflater.on("end", () => {
          for (const obj of scanner.push(decoder.decode())) handleJson(obj);
          resolve();
        });
        inflater.on("error", reject);
        inflater.end(compressed);
      });
    } else {
      throw new Error(`Unsupported ZIP compression method ${entry.method} in ${entry.filename}.`);
    }
  }

  return { scanned };
}
