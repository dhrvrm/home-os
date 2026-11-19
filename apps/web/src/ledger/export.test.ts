import { describe, expect, it } from "vitest";
import { statementArtifact } from "./export";
import type { PreparedStatementExport } from "./api";
const prepared: PreparedStatementExport = { text: '"entry_id","amount"\r\n', filename: 'statement.csv', mime: 'text/csv;charset=utf-8', scope: { memberId: '=SUM(1)', currency: 'INR', from: null, to: null, basis: 'current-effective' }, revision: 42, openingMinor: -100, movementMinor: 0, closingMinor: -100, movementCount: 0, bytes: 21 };
describe("complete statement download", () => {
    it("puts scope, revision and reconciling totals in an empty CSV and neutralizes human formulas", () => {
        const artifact = statementArtifact(prepared);
        expect(artifact.text).toContain('"member_id","\'=SUM(1)"');
        expect(artifact.text).toContain('"revision",42');
        expect(artifact.text).toContain('"opening_balance",-1.00');
        expect(artifact.text).toContain('"movement_total",0.00');
        expect(artifact.text).toContain('"closing_balance",-1.00');
        expect(artifact.text).toContain('"movement_count",0');
        expect(artifact.text).toContain(prepared.text);
        expect(artifact.bytes).toBe(new TextEncoder().encode(artifact.text).byteLength);
    });
    it("rechecks UTF8 bytes after adding metadata", () => expect(() => statementArtifact({ ...prepared, text: 'x'.repeat(8388600) })).toThrow(/8 MiB/));
    it("preserves the already complete JSON basis", () => expect(statementArtifact({ ...prepared, mime: 'application/json', text: '{"revision":42}' }).text).toBe('{"revision":42}'));
});
