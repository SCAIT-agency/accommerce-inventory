import { describe, it, expect, afterEach } from "vitest";
import { TAB_NAMES, buildSnapshot, loadFixtureSnapshot, fixtureRows, cell, splitAtBlank, parseTab } from "./snapshot";
import { fetchTabRows, gvizJsonToRows, canonicalCell } from "./gviz";

describe("snapshot", () => {
  it("loads every tab from fixtures with validated headers and no blank rows", async () => {
    const snap = await loadFixtureSnapshot();
    expect(Object.keys(snap).sort()).toEqual(Object.keys(TAB_NAMES).sort());
    expect(snap.purchaseOrders.header).toContain("Full Factory Cost/unit");
    expect(snap.purchaseOrders.rows).toHaveLength(13);
    expect(snap.transactions.rows).toHaveLength(153);
    expect(cell(snap.skuMaster, snap.skuMaster.rows[0], "SKU")).toBe("Jello");
  });

  it("never exposes bank columns", async () => {
    const snap = await loadFixtureSnapshot();
    const allHeaders = Object.values(snap).flatMap((t) => t.header);
    expect(allHeaders.some((h) => /bank/i.test(h))).toBe(false);
  });

  it("normalises the Inventory Ledger's live TODAY() title cell", async () => {
    const snap = await loadFixtureSnapshot();
    expect(snap.inventoryLedger.header[0]).toBe("Shipment ID");
    const rows = await fixtureRows(TAB_NAMES.inventoryLedger);
    const future = [[rows[0][0].replace("as of 2026-09-19", "as of 2027-01-01"), ...rows[0].slice(1)], ...rows.slice(1)];
    expect(parseTab("inventoryLedger", future).header[0]).toBe("Shipment ID");
  });

  it("rejects a tab whose header drifted, naming the columns", async () => {
    const fetch = async (title: string) =>
      title === TAB_NAMES.skuMaster ? [["SKU", "Renamed"], ["Jello", "x"]] : fixtureRows(title);
    await expect(buildSnapshot(fetch)).rejects.toThrow(/SKU Master: header drifted — missing \[Product Name/);
  });

  it("cell() throws on an unknown column instead of reading blank", async () => {
    const snap = await loadFixtureSnapshot();
    expect(() => cell(snap.skuMaster, snap.skuMaster.rows[0], "Nope")).toThrow(/unknown column "Nope"/);
  });

  it("splitAtBlank separates the Inventory Ledger batch table from the Current On-Hand block", async () => {
    const snap = await loadFixtureSnapshot();
    const { left, right } = splitAtBlank(snap.inventoryLedger);
    expect(left.header[0]).toBe("Shipment ID");
    expect(right.header).toEqual(["Warehouse", "SKU", "Qty On Hand", "Value On Hand", "Weighted Cost/unit", "Oversold Qty"]);
    expect(right.rows).toHaveLength(6);
    expect(cell(right, right.rows[0], "Qty On Hand")).toBe("228585");
  });
});

describe("gviz", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("rejects an HTML body", async () => {
    globalThis.fetch = (async () => new Response("<html>sign in</html>", { status: 200 })) as typeof fetch;
    await expect(fetchTabRows("id", "Shipments")).rejects.toThrow(/HTML body/);
  });

  it("rejects a non-200 status", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 403 })) as typeof fetch;
    await expect(fetchTabRows("id", "Shipments")).rejects.toThrow(/HTTP 403/);
  });

  it("converts raw JSON cells to canonical strings (full-precision numbers, ISO dates, TRUE/FALSE, blanks)", () => {
    expect(canonicalCell({ v: 2.0259266586730615, f: "2.0259" }, "number")).toBe("2.0259266586730615");
    expect(canonicalCell({ v: 50040, f: "50,040" }, "number")).toBe("50040");
    expect(canonicalCell({ v: "Date(2026,5,23)", f: "2026-06-23" }, "date")).toBe("2026-06-23");
    expect(canonicalCell({ v: true }, "boolean")).toBe("TRUE");
    expect(canonicalCell(null, "number")).toBe("");
    expect(canonicalCell({ v: null }, "string")).toBe("");
  });

  it("parses the setResponse wrapper and uses column labels as the header", () => {
    const body =
      '/*O_o*/\ngoogle.visualization.Query.setResponse({"status":"ok","table":{"cols":[{"label":"SKU","type":"string"},{"label":"Qty","type":"number"}],"rows":[{"c":[{"v":"Jello"},{"v":12.5,"f":"12.5"}]},{"c":[{"v":"Mixer"},null]}]}});';
    expect(gvizJsonToRows(body, "t")).toEqual([["SKU", "Qty"], ["Jello", "12.5"], ["Mixer", ""]]);
  });

  it("falls back to the first data row as header when gviz assigns no labels", () => {
    const body =
      'google.visualization.Query.setResponse({"status":"ok","table":{"cols":[{"label":"","type":"string"},{"label":"","type":"string"}],"rows":[{"c":[{"v":"A"},{"v":"B"}]},{"c":[{"v":"1"},{"v":"2"}]}]}});';
    expect(gvizJsonToRows(body, "t")).toEqual([["A", "B"], ["1", "2"]]);
  });

  it("surfaces a gviz error status", () => {
    const body = 'google.visualization.Query.setResponse({"status":"error","errors":[{"message":"Invalid query"}]});';
    expect(() => gvizJsonToRows(body, "t")).toThrow(/status error Invalid query/);
  });
});
