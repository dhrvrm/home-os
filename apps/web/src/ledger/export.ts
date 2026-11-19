import { APIError } from "@/lib/api";
import { runHouseholdWork } from "@/auth/work";
import { requireIdentity } from "@/household/api";
import type { AuthUser } from "@/lib/auth";
import { decimalMoney } from "./allocation-preview";
import { prepareStatementExport, type PreparedStatementExport, type StatementExportInput } from "./api";
const quote = (value: string) => `"${(/^[\s\u0000-\u001f]*[=+@-]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`;
/** Adds artifact metadata to the complete U6 basis, never reads another page. */
export function statementArtifact(prepared: PreparedStatementExport): PreparedStatementExport {
    const { scope } = prepared;
    const text = prepared.mime.startsWith("text/csv") ? [
        `${quote("member_id")},${quote(scope.memberId)}`,
        `${quote("currency")},${quote(scope.currency)}`,
        `${quote("from_inclusive")},${quote(scope.from ?? "all history")}`,
        `${quote("to_inclusive")},${quote(scope.to ?? "all history")}`,
        `${quote("basis")},${quote(scope.basis)}`,
        `${quote("revision")},${prepared.revision}`,
        `${quote("opening_balance")},${decimalMoney(prepared.openingMinor, scope.currency)}`,
        `${quote("movement_total")},${decimalMoney(prepared.movementMinor, scope.currency)}`,
        `${quote("closing_balance")},${decimalMoney(prepared.closingMinor, scope.currency)}`,
        `${quote("movement_count")},${prepared.movementCount}`, "", prepared.text,
    ].join("\r\n") : prepared.text;
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > 8388608)
        throw new APIError("Choose a narrower date range: this complete statement exceeds 8 MiB.", "export_too_large");
    return { ...prepared, text, bytes };
}
export async function downloadStatement(user: AuthUser, input: StatementExportInput, options: Parameters<typeof prepareStatementExport>[2] = {}) {
    return runHouseholdWork(async (lease) => {
        requireIdentity(user, lease);
        const artifact = statementArtifact(await prepareStatementExport(user, input, options));
        requireIdentity(user, lease);
        if (options.signal?.aborted)
            throw new APIError("Export cancelled.", "cancelled");
        const href = URL.createObjectURL(new Blob([artifact.text], { type: artifact.mime }));
        const link = document.createElement("a");
        link.href = href;
        link.download = artifact.filename;
        link.click();
        URL.revokeObjectURL(href);
        return artifact;
    });
}
