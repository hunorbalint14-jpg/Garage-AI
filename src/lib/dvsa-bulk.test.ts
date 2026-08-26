import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import {
  JsonRecordScanner,
  listZipEntries,
  scanDeltaZip,
  normalizeRegistration,
  parseDvsaDate,
  extractDeltaUpdate,
  type DeltaVehicleUpdate,
} from "./dvsa-bulk";

describe("normalizeRegistration", () => {
  it("uppercases and strips spaces", () => {
    expect(normalizeRegistration("ab12 cde")).toBe("AB12CDE");
  });

  it("strips non-alphanumerics", () => {
    expect(normalizeRegistration(" AB12-CDE ")).toBe("AB12CDE");
  });
});

describe("parseDvsaDate", () => {
  it("handles ISO timestamps", () => {
    expect(parseDvsaDate("2026-01-17T14:23:21.000Z")).toBe("2026-01-17");
  });

  it("handles bare dates", () => {
    expect(parseDvsaDate("2026-01-17")).toBe("2026-01-17");
  });

  it("handles legacy dotted format", () => {
    expect(parseDvsaDate("2026.01.17 14:23:21")).toBe("2026-01-17");
  });

  it("rejects garbage", () => {
    expect(parseDvsaDate("not a date")).toBeNull();
    expect(parseDvsaDate(null)).toBeNull();
    expect(parseDvsaDate(42)).toBeNull();
  });
});

describe("JsonRecordScanner", () => {
  it("parses NDJSON framing", () => {
    const scanner = new JsonRecordScanner();
    const out = scanner.push('{"a":1}\n{"b":2}\n');
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("parses array framing", () => {
    const scanner = new JsonRecordScanner();
    const out = scanner.push('[{"a":1},{"b":2}]');
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles records split across chunks", () => {
    const scanner = new JsonRecordScanner();
    expect(scanner.push('{"registration":"AB')).toEqual([]);
    expect(scanner.push('12CDE","x":{"y":1}}')).toEqual(['{"registration":"AB12CDE","x":{"y":1}}']);
  });

  it("ignores braces inside strings", () => {
    const scanner = new JsonRecordScanner();
    const out = scanner.push('{"text":"} fake { close \\" still"}');
    expect(out).toEqual(['{"text":"} fake { close \\" still"}']);
  });

  it("handles nested objects and arrays", () => {
    const scanner = new JsonRecordScanner();
    const record = '{"motTests":[{"defects":[{"text":"worn {brake}"}]}]}';
    expect(scanner.push(record)).toEqual([record]);
  });
});

describe("extractDeltaUpdate", () => {
  it("extracts latest passed expiry and last test date", () => {
    const update = extractDeltaUpdate({
      registration: "AB12 CDE",
      modification: "updated",
      motTests: [
        { completedDate: "2026-06-09T10:00:00Z", testResult: "PASSED", expiryDate: "2027-06-08" },
        { completedDate: "2025-06-01T10:00:00Z", testResult: "PASSED", expiryDate: "2026-06-01" },
        { completedDate: "2026-06-09T09:00:00Z", testResult: "FAILED" },
      ],
    });
    expect(update).toMatchObject({
      registration: "AB12 CDE",
      normalizedReg: "AB12CDE",
      modification: "UPDATED",
      motExpiry: "2027-06-08",
      lastTestDate: "2026-06-09",
    });
    expect(update?.tests).toHaveLength(3);
  });

  it("parses the full test series with odometer and defects (#596)", () => {
    const update = extractDeltaUpdate({
      registration: "AB12 CDE",
      motTests: [
        {
          completedDate: "2026-06-09T10:00:00Z",
          testResult: "passed",
          expiryDate: "2027-06-08",
          odometerValue: "45210",
          odometerUnit: "MI",
          defects: [{ text: "Nearside front tyre worn on inner edge", type: "ADVISORY" }],
        },
        {
          completedDate: "2025-06-01T10:00:00Z",
          testResult: "PASSED",
          odometerValue: "60000",
          odometerUnit: "KM",
          rfrAndComments: [{ text: "Offside rear tyre slightly perished" }], // legacy shape
        },
        { completedDate: null, testResult: "PASSED", odometerValue: "1" }, // dateless → dropped
      ],
    });
    expect(update?.tests).toEqual([
      {
        testDate: "2026-06-09",
        result: "PASSED",
        odometerMiles: 45210,
        defects: [{ text: "Nearside front tyre worn on inner edge", type: "ADVISORY" }],
      },
      {
        testDate: "2025-06-01",
        result: "PASSED",
        odometerMiles: 37282,
        defects: [{ text: "Offside rear tyre slightly perished", type: "ADVISORY" }],
      },
    ] satisfies DeltaVehicleUpdate["tests"]);
  });

  it("uses motTestDueDate for never-tested vehicles", () => {
    const update = extractDeltaUpdate({
      registration: "LC74 XYZ",
      modification: "created",
      motTests: [],
      motTestDueDate: "2027-11-15",
    });
    expect(update?.motExpiry).toBe("2027-11-15");
    expect(update?.lastTestDate).toBeNull();
  });

  it("falls back to lastMotTestDate when newer than test list", () => {
    const update = extractDeltaUpdate({
      registration: "XY99ZZZ",
      lastMotTestDate: "2026-06-10",
      motTests: [],
    });
    expect(update?.lastTestDate).toBe("2026-06-10");
    expect(update?.motExpiry).toBeNull();
  });

  it("returns null without a registration", () => {
    expect(extractDeltaUpdate({ make: "FORD" })).toBeNull();
  });
});

// --- synthetic ZIP construction (single deflate entry, no data descriptor) ---

function buildZip(filename: string, content: string, method: 0 | 8 = 8): Buffer {
  const nameBuf = Buffer.from(filename, "utf8");
  const raw = Buffer.from(content, "utf8");
  const data = method === 8 ? deflateRawSync(raw) : raw;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const localChunk = Buffer.concat([local, nameBuf, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset

  const centralChunk = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries on disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralChunk.length, 12);
  eocd.writeUInt32LE(localChunk.length, 16); // central dir offset

  return Buffer.concat([localChunk, centralChunk, eocd]);
}

describe("listZipEntries", () => {
  it("walks the central directory", () => {
    const zip = buildZip("delta_2026-06-10.json", '{"a":1}');
    const entries = listZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe("delta_2026-06-10.json");
    expect(entries[0].method).toBe(8);
  });

  it("rejects non-zip buffers", () => {
    expect(() => listZipEntries(Buffer.from("definitely not a zip file at all"))).toThrow(
      /end-of-central-directory/,
    );
  });
});

describe("scanDeltaZip", () => {
  const records =
    '{"registration":"AB12CDE","modification":"UPDATED","motTests":[{"completedDate":"2026-06-09T10:00:00Z","testResult":"PASSED","expiryDate":"2027-06-08"}]}\n' +
    '{"registration":"XY99 ZZZ","modification":"DELETED","motTests":[]}\n';

  it("scans deflated entries", async () => {
    const zip = buildZip("delta.json", records, 8);
    const seen: DeltaVehicleUpdate[] = [];
    const { scanned } = await scanDeltaZip(zip, (u) => seen.push(u));
    expect(scanned).toBe(2);
    expect(seen[0].normalizedReg).toBe("AB12CDE");
    expect(seen[0].motExpiry).toBe("2027-06-08");
    expect(seen[1].modification).toBe("DELETED");
  });

  it("scans stored entries", async () => {
    const zip = buildZip("delta.json", records, 0);
    const seen: DeltaVehicleUpdate[] = [];
    const { scanned } = await scanDeltaZip(zip, (u) => seen.push(u));
    expect(scanned).toBe(2);
  });

  it("skips non-json entries", async () => {
    const zip = buildZip("README.txt", records, 8);
    const seen: DeltaVehicleUpdate[] = [];
    const { scanned } = await scanDeltaZip(zip, (u) => seen.push(u));
    expect(scanned).toBe(0);
    expect(seen).toHaveLength(0);
  });
});
