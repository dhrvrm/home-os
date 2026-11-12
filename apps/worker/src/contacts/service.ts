import type { CommandContext } from "../platform/context";
import { ConflictError, ValidationError } from "../platform/errors";
import { createId } from "../platform/ids";
import {
  beginCommand,
  expectedVersion,
  replayCommand,
} from "../platform/household-command";
import type {
  Contact,
  ContactFilter,
  ContactInput,
  UpdateContactInput,
} from "./model";
import { contactSchema, contactUpdateSchema, validate } from "./validation";
import { D1ContactRepository } from "./d1-repository";

export class ContactService {
  constructor(
    private readonly repository: D1ContactRepository,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  listContacts(householdId: string, filter: ContactFilter = {}) {
    return this.repository.list(householdId, filter);
  }

  getContact(householdId: string, id: string) {
    return this.repository.get(householdId, id);
  }

  async createContact(
    context: CommandContext,
    input: ContactInput,
  ): Promise<Contact> {
    const data = validate(contactSchema, input);
    const command = await beginCommand(
      this.repository.database,
      context,
      "contact",
      "contacts.created",
      undefined,
      data,
    );
    const replay = await replayCommand<Contact>(
      this.repository.database,
      command,
    );
    if (replay) return replay;
    const now = this.clock();
    const contact: Contact = {
      id: createId(),
      householdId: context.householdId,
      name: data.name,
      role: data.role ?? "",
      phone: data.phone ?? "",
      email: data.email ?? "",
      address: data.address ?? "",
      labels: data.labels ?? [],
      notes: data.notes ?? "",
      version: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.assertUseful(contact);
    return this.repository.save(contact, command, true);
  }

  updateContact(
    context: CommandContext,
    id: string,
    input: UpdateContactInput,
  ): Promise<Contact> {
    return this.change(
      context,
      id,
      "updated",
      validate(contactUpdateSchema, input),
    );
  }

  archiveContact(context: CommandContext, id: string): Promise<Contact> {
    return this.change(context, id, "archived", {});
  }

  restoreContact(context: CommandContext, id: string): Promise<Contact> {
    return this.change(context, id, "restored", {});
  }

  private async change(
    context: CommandContext,
    id: string,
    action: string,
    input: UpdateContactInput,
  ): Promise<Contact> {
    const version = expectedVersion(context);
    const command = await beginCommand(
      this.repository.database,
      context,
      "contact",
      `contacts.${action}`,
      id,
      input,
    );
    const replay = await replayCommand<Contact>(
      this.repository.database,
      command,
    );
    if (replay) return replay;
    const current = await this.repository.get(context.householdId, id);
    if (current.version !== version)
      throw new ConflictError("contact", id, version, current.version, current);
    if (action === "updated" && current.archivedAt) {
      throw new ValidationError(
        "contact",
        "restore this contact before editing it",
      );
    }
    const now = this.clock();
    const next: Contact = {
      ...current,
      ...input,
      version: version + 1,
      updatedAt: now,
      archivedAt:
        action === "archived"
          ? now
          : action === "restored"
            ? null
            : current.archivedAt,
    };
    this.assertUseful(next);
    return this.repository.save(next, command, false);
  }

  private assertUseful(contact: Contact): void {
    if (!contact.role && !contact.phone && !contact.email) {
      throw new ValidationError(
        "role",
        "add a role, phone number or email address",
      );
    }
  }
}
