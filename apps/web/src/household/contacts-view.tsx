"use client";
import { useState } from "react";
import { Plus, Phone, EnvelopeSimple } from "@phosphor-icons/react";
import type { AuthUser } from "@/lib/auth";
import type { Contact } from "./types";
import { contactsData } from "./validate";
import {
  Field,
  labelsFrom,
  Modal,
  ResourceState,
  SaveActions,
  useOnline,
  useResource,
  WriteReason,
} from "./ui";
import { useCommand, useEditorSave } from "./mutations";
export function phoneHref(value: string): string | undefined {
  const normalized = value.replace(/[\s().-]/g, "");
  return /^\+?[0-9]{3,20}$/.test(normalized) ? `tel:${normalized}` : undefined;
}
export function emailHref(value: string): string | undefined {
  return /^[A-Za-z0-9.!#$&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(
    value,
  )
    ? `mailto:${encodeURIComponent(value).replace(/%40/g, "@")}`
    : undefined;
}
export function ContactsView({ currentUser }: { currentUser: AuthUser }) {
  return (
    <ContactScreen
      key={`${currentUser.householdId}:${currentUser.id}:${currentUser.role}`}
      user={currentUser}
    />
  );
}
function ContactScreen({ user }: { user: AuthUser }) {
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [editor, setEditor] = useState<Contact | "new" | null>(null);
  const connected = useOnline();
  const writable = connected && user.role !== "viewer";
  const query = new URLSearchParams({
    search,
    archived: archived ? "only" : "exclude",
  }).toString();
  const resource = useResource(
    user,
    `contacts:${query}`,
    `/api/v1/contacts?${query}`,
    contactsData,
  );
  const command = useCommand(user);
  async function lifecycle(contact: Contact) {
    await command.execute(
      contact.id,
      `/contacts/${encodeURIComponent(contact.id)}${archived ? "/restore" : ""}`,
      archived ? "POST" : "DELETE",
      undefined,
      contact.version,
      () => void resource.refresh(),
      archived
        ? "Contact restored."
        : "Contact archived. You can restore it from Archived.",
      () => void resource.refresh(),
    );
  }
  return (
    <section className="hh-panel" aria-label="Contacts">
      <header className="hh-header">
        <div>
          <h2>Household contacts</h2>
          <p>
            Useful people and services. Contacts do not grant sign-in access.
          </p>
        </div>
        {user.role !== "viewer" && (
          <button
            className="button button--primary"
            disabled={!writable}
            onClick={() => setEditor("new")}
          >
            <Plus size={18} /> Add contact
          </button>
        )}
      </header>
      <div className="hh-toolbar">
        <Field label="Search contacts">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Field label="Contact status">
          <select
            value={archived ? "archived" : "active"}
            onChange={(event) => setArchived(event.target.value === "archived")}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </Field>
      </div>
      <WriteReason user={user} connected={connected} />
      <ResourceState {...resource} retry={() => void resource.refresh()} />
      <p role="status" className="hh-status">
        {command.status}
      </p>
      {command.error && (
        <p className="form-error" role="alert">
          {command.error}
        </p>
      )}
      {resource.copy && !resource.copy.data.contacts.length && (
        <p className="hh-empty">
          {search
            ? "No contacts match your search."
            : archived
              ? "No archived contacts."
              : "No contacts yet. Save a useful person or household service."}
        </p>
      )}
      <div className="hh-list">
        {resource.copy?.data.contacts.map((contact) => (
          <article
            className="hh-entry"
            aria-label={contact.name}
            key={contact.id}
          >
            <header>
              <h3>{contact.name}</h3>
              <p>{contact.role}</p>
              {contact.archivedAt && <span className="hh-tag">Archived</span>}
            </header>
            {contact.phone && <p>{contact.phone}</p>}
            {contact.email && <p>{contact.email}</p>}
            {contact.address && <p className="hh-lines">{contact.address}</p>}
            {contact.notes && <p className="hh-lines">{contact.notes}</p>}
            {contact.labels.length > 0 && (
              <p className="hh-muted">{contact.labels.join(" · ")}</p>
            )}
            <div className="hh-actions">
              {!archived && phoneHref(contact.phone) && (
                <a
                  className="button button--quiet"
                  href={phoneHref(contact.phone)}
                >
                  <Phone size={18} /> Call {contact.name}
                </a>
              )}
              {!archived && emailHref(contact.email) && (
                <a
                  className="button button--quiet"
                  href={emailHref(contact.email)}
                >
                  <EnvelopeSimple size={18} /> Email {contact.name}
                </a>
              )}
              {user.role !== "viewer" && (
                <>
                  <button
                    className="button button--quiet"
                    disabled={!writable || !!command.pending}
                    onClick={() => setEditor(contact)}
                  >
                    Edit contact
                  </button>
                  <button
                    className="button button--quiet"
                    disabled={!writable || !!command.pending}
                    onClick={() => void lifecycle(contact)}
                  >
                    {command.pending === contact.id
                      ? "Saving…"
                      : archived
                        ? "Restore contact"
                        : "Archive contact"}
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {editor && (
        <ContactEditor
          user={user}
          contact={editor === "new" ? undefined : editor}
          connected={connected}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void resource.refresh();
          }}
        />
      )}
    </section>
  );
}
function ContactEditor({
  user,
  contact,
  connected,
  onClose,
  onSaved,
}: {
  user: AuthUser;
  contact?: Contact;
  connected: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(contact?.name ?? "");
  const [role, setRole] = useState(contact?.role ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [address, setAddress] = useState(contact?.address ?? "");
  const [notes, setNotes] = useState(contact?.notes ?? "");
  const [labels, setLabels] = useState(contact?.labels.join(", ") ?? "");
  const save = useEditorSave(user, "contacts", contact, onSaved);
  const useful = Boolean(role.trim() || phone.trim() || email.trim());
  return (
    <Modal
      title={contact ? `Edit ${contact.name}` : "Add contact"}
      pending={!!save.pending}
      onClose={onClose}
    >
      <form
        className="item-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!useful) return;
          void save.save({
            name: name.trim(),
            role: role.trim(),
            phone: phone.trim(),
            email: email.trim(),
            address,
            notes,
            labels: labelsFrom(labels),
          });
        }}
      >
        <Field label="Contact name" wide>
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Relationship / service">
          <input
            maxLength={120}
            value={role}
            onChange={(event) => setRole(event.target.value)}
          />
        </Field>
        <Field label="Phone">
          <input
            type="tel"
            maxLength={40}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Labels (comma separated)">
          <input
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
          />
        </Field>
        <Field label="Address" wide>
          <textarea
            maxLength={500}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </Field>
        <Field label="Notes" wide>
          <textarea
            rows={4}
            maxLength={2000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
        {!useful && (
          <p className="hh-muted field--wide">
            Add a relationship, phone, or email so this contact is useful.
          </p>
        )}
        {save.error && (
          <p className="form-error field--wide" role="alert">
            {save.error}
          </p>
        )}
        <div className="field--wide">{save.conflictUI}</div>
        {!connected && (
          <p className="hh-notice field--wide">Connect to save this draft.</p>
        )}
        <SaveActions
          pending={!!save.pending}
          disabled={!connected || !useful || save.conflict}
          onClose={onClose}
          label="Save contact"
        />
      </form>
    </Modal>
  );
}
