/** Public contact DTOs. Contacts never confer household membership. */
export interface ContactInput {
  name: string;
  role?: string;
  phone?: string;
  email?: string;
  address?: string;
  labels?: string[];
  notes?: string;
}
export type CreateContactInput = ContactInput;
export type UpdateContactInput = Partial<ContactInput>;

export interface Contact {
  id: string;
  householdId: string;
  name: string;
  role: string;
  phone: string;
  email: string;
  address: string;
  labels: string[];
  notes: string;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactFilter {
  search?: string;
  archived?: "exclude" | "only" | "include";
}
