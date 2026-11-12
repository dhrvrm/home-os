import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MoreNavigation } from "./more-navigation";

describe("mobile secondary navigation", () => {
  it("makes the remaining destinations reachable and marks the current page", () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(
      <MoreNavigation
        activeView="contacts"
        onNavigate={onNavigate}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "More from your home" });
    expect(
      within(dialog).getByRole("button", { name: "Contacts" }),
    ).toHaveAttribute("aria-current", "page");
    for (const name of [
      "Recipes",
      "Shopping",
      "Expenses",
      "Contacts",
      "Members",
      "Account",
    ])
      expect(within(dialog).getByRole("button", { name })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Recipes" }));
    expect(onNavigate).toHaveBeenCalledWith("recipes");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes with Escape and restores focus to the invoking control", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(
      <MoreNavigation
        activeView="inventory"
        onNavigate={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
