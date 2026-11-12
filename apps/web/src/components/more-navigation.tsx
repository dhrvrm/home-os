"use client";

import { useEffect, useRef } from "react";
import {
  AddressBook,
  BookOpen,
  Receipt,
  ShoppingCartSimple,
  UserCircle,
  Users,
  X,
} from "@phosphor-icons/react";
import type { HomeView } from "@/lib/navigation";

const destinations = [
  ["recipes", "Recipes", BookOpen],
  ["shopping", "Shopping", ShoppingCartSimple],
  ["expenses", "Expenses", Receipt],
  ["contacts", "Contacts", AddressBook],
  ["members", "Members", Users],
  ["account", "Account", UserCircle],
] as const;

export function MoreNavigation({
  activeView,
  onNavigate,
  onClose,
}: {
  activeView: HomeView;
  onNavigate: (view: HomeView) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab") return;
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      );
      const first = buttons?.[0];
      const last = buttons?.[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("keydown", keyDown);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);

  return (
    <div className="more-navigation-overlay">
      <button
        className="more-navigation-backdrop"
        type="button"
        tabIndex={-1}
        aria-label="Dismiss navigation"
        onClick={onClose}
      />
      <section
        ref={dialog}
        className="more-navigation"
        role="dialog"
        aria-modal="true"
        aria-labelledby="more-navigation-title"
      >
        <header>
          <h2 id="more-navigation-title">More from your home</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <nav aria-label="Other destinations">
          {destinations.map(([view, label, Icon]) => (
            <button
              key={view}
              type="button"
              aria-current={activeView === view ? "page" : undefined}
              onClick={() => {
                onNavigate(view);
                onClose();
              }}
            >
              <Icon size={21} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </section>
    </div>
  );
}
