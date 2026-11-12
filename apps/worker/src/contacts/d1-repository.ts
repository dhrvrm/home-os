import type { Contact, ContactFilter } from "./model";
import { ConflictError, NotFoundError } from "../platform/errors";
import {
  commandGuard,
  commitCommand,
  type HouseholdCommand,
} from "../platform/household-command";

interface Row {
  id: string;
  household_id: string;
  name: string;
  role: string;
  phone: string;
  email: string;
  address: string;
  labels_json: string;
  notes: string;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function map(row: Row): Contact {
  return {
    id: row.id,
    householdId: row.household_id,
    name: row.name,
    role: row.role,
    phone: row.phone,
    email: row.email,
    address: row.address,
    labels: JSON.parse(row.labels_json),
    notes: row.notes,
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class D1ContactRepository {
  constructor(readonly database: D1Database) {}

  async get(householdId: string, id: string): Promise<Contact> {
    const row = await this.database
      .prepare("SELECT * FROM contacts WHERE household_id = ? AND id = ?")
      .bind(householdId, id)
      .first<Row>();
    if (!row) throw new NotFoundError("contact", id);
    return map(row);
  }

  async list(householdId: string, filter: ContactFilter): Promise<Contact[]> {
    const rows = await this.database
      .prepare(
        "SELECT * FROM contacts WHERE household_id = ? ORDER BY name COLLATE NOCASE, id",
      )
      .bind(householdId)
      .all<Row>();
    const search = filter.search?.trim().toLocaleLowerCase();
    return rows.results.map(map).filter((contact) => {
      const lifecycle =
        filter.archived === "include" ||
        (filter.archived === "only") === !!contact.archivedAt;
      const text = [
        contact.name,
        contact.role,
        contact.phone,
        contact.email,
        contact.address,
        ...contact.labels,
        contact.notes,
      ];
      return (
        lifecycle &&
        (!search || text.join(" ").toLocaleLowerCase().includes(search))
      );
    });
  }

  async save(
    contact: Contact,
    command: HouseholdCommand,
    create: boolean,
  ): Promise<Contact> {
    const values = [
      contact.name,
      contact.role,
      contact.phone,
      contact.email,
      contact.address,
      JSON.stringify(contact.labels),
      contact.notes,
      contact.version,
      contact.updatedAt,
      contact.archivedAt,
    ];
    const statements = create
      ? [
          this.database
            .prepare(
              `INSERT INTO contacts (name, role, phone, email, address, labels_json, notes, version,
                               updated_at, archived_at, id, household_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              ...values,
              contact.id,
              contact.householdId,
              contact.createdAt,
            ),
        ]
      : [
          commandGuard(
            this.database,
            command,
            command.context.expectedVersion!,
            "SELECT version FROM contacts WHERE household_id = ? AND id = ?",
            [contact.householdId, contact.id],
          ),
          this.database
            .prepare(
              `UPDATE contacts SET name = ?, role = ?, phone = ?, email = ?, address = ?, labels_json = ?,
                             notes = ?, version = ?, updated_at = ?, archived_at = ?
         WHERE household_id = ? AND id = ? AND version = ?`,
            )
            .bind(
              ...values,
              contact.householdId,
              contact.id,
              command.context.expectedVersion!,
            ),
        ];
    return commitCommand(
      this.database,
      command,
      contact,
      contact.id,
      contact.updatedAt,
      statements,
      async () => {
        if (!create) {
          const latest = await this.get(contact.householdId, contact.id);
          if (latest.version !== command.context.expectedVersion) {
            throw new ConflictError(
              "contact",
              contact.id,
              command.context.expectedVersion!,
              latest.version,
              latest,
            );
          }
        }
      },
    );
  }
}
