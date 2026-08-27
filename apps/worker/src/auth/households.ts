export interface DomainHousehold {
  id: string;
  name: string;
  organizationId: string;
}

interface HouseholdRow {
  id: string;
  name: string;
  organization_id: string;
}

export async function resolveOrganizationHousehold(
  database: D1Database,
  organization: { id: string; name: string },
  legacyHouseholdId: string,
): Promise<DomainHousehold> {
  const existing = await householdByOrganization(database, organization.id);
  if (existing) return toDomainHousehold(existing);

  await database
    .prepare(
      `UPDATE households
       SET organization_id = ?, name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id IS NULL`,
    )
    .bind(organization.id, organization.name, legacyHouseholdId)
    .run();

  const claimed = await householdByOrganization(database, organization.id);
  if (claimed) return toDomainHousehold(claimed);

  await database
    .prepare(
      `INSERT OR IGNORE INTO households
         (id, name, timezone, created_at, updated_at, organization_id)
       VALUES (?, ?, 'Asia/Kolkata', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
    )
    .bind(organization.id, organization.name, organization.id)
    .run();

  const created = await householdByOrganization(database, organization.id);
  if (!created) throw new Error("Home OS could not map the organization to a household.");
  return toDomainHousehold(created);
}

async function householdByOrganization(
  database: D1Database,
  organizationId: string,
): Promise<HouseholdRow | null> {
  return database
    .prepare(
      `SELECT id, name, organization_id
       FROM households
       WHERE organization_id = ?`,
    )
    .bind(organizationId)
    .first<HouseholdRow>();
}

function toDomainHousehold(row: HouseholdRow): DomainHousehold {
  return { id: row.id, name: row.name, organizationId: row.organization_id };
}
