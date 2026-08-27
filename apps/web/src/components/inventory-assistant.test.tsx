import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserAssistant, LOCAL_MODEL, type AssistantRuntime } from "@/lib/browser-assistant";
import type { InventoryItem } from "@/lib/inventory";
import { InventoryAssistant } from "./inventory-assistant";

const soap = {
  id: "soap", name: "Dish soap", alternativeNames: ["साबुन", "Soap"], category: "Cleaning", categories: ["Cleaning", "Kitchen"],
  location: "Kitchen", unit: "bottle", trackingMode: "simple", quantity: 0, stockLevel: "low", levelPercent: 25, minQuantity: 0,
  createdAt: "2026-08-24T10:00:00Z", updatedAt: "2026-08-24T10:00:00Z",
} satisfies InventoryItem;

function runtime(output = '{"intent":"rename","item":"Dish soap","name":"Washing-up liquid"}'): AssistantRuntime {
  return {
    loadModelFromUrl: vi.fn(async (_source, options) => {
      options.progressCallback({ loaded: LOCAL_MODEL.sizeBytes / 2, total: LOCAL_MODEL.sizeBytes });
      options.progressCallback({ loaded: LOCAL_MODEL.sizeBytes, total: LOCAL_MODEL.sizeBytes });
    }),
    createChatCompletion: vi.fn(async () => ({ choices: [{ message: { content: output } }] })),
    isSupportWebGPU: vi.fn(() => true),
    exit: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InventoryAssistant", () => {
  it("answers deterministic queries without downloading a model", async () => {
    const localRuntime = runtime();
    const assistant = new BrowserAssistant(async () => localRuntime);
    const user = userEvent.setup();
    render(<InventoryAssistant assistant={assistant} items={[soap]} onApply={vi.fn()} onClose={vi.fn()} />);

    expect(localRuntime.loadModelFromUrl).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "What is running low?" }));
    expect(screen.getByText(/Dish soap.*matches/)).toBeInTheDocument();
    expect(screen.getByText("Answered from local inventory · 1 record")).toBeInTheDocument();
    expect(localRuntime.loadModelFromUrl).not.toHaveBeenCalled();
  });

  it("handles an empty inventory without loading the model", async () => {
    const localRuntime = runtime();
    const user = userEvent.setup();
    render(<InventoryAssistant assistant={new BrowserAssistant(async () => localRuntime)} items={[]} onApply={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "What is running low?" }));
    expect(screen.getByText("No inventory items need attention.")).toBeInTheDocument();
    expect(localRuntime.loadModelFromUrl).not.toHaveBeenCalled();
  });

  it("requires consent, shows progress, and confirms a generated proposal", async () => {
    const localRuntime = runtime();
    const assistant = new BrowserAssistant(async () => localRuntime);
    const onApply = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<InventoryAssistant assistant={assistant} items={[soap]} onApply={onApply} onClose={vi.fn()} />);

    const input = screen.getByLabelText("Ask about inventory or propose an edit");
    await user.type(input, "Rename Dish soap to Washing-up liquid");
    await user.click(screen.getByRole("button", { name: "Ask Home" }));
    expect(screen.getByText("This request needs the local model")).toBeInTheDocument();
    expect(localRuntime.loadModelFromUrl).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Enable local assistant" }));
    expect(await screen.findByRole("heading", { name: "Proposed change to Dish soap" })).toBeInTheDocument();
    expect(screen.getByText("Washing-up liquid")).toBeInTheDocument();
    expect(localRuntime.loadModelFromUrl).toHaveBeenCalledOnce();
    expect(localRuntime.createChatCompletion).toHaveBeenCalledOnce();
    expect(screen.getByText("Interpreted locally · 1 retrieved record · Answer verified against inventory")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm change" }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      itemID: "soap",
      changes: { name: "Washing-up liquid" },
    }));
    expect(await screen.findByText("Inventory updated after your confirmation.")).toBeInTheDocument();
  });

  it("checks model storage after consent and blocks a known insufficient device", async () => {
    const localRuntime = runtime();
    const assistant = new BrowserAssistant(async () => localRuntime, {
      estimate: vi.fn(async () => ({ usage: 90_000_000, quota: 100_000_000 })),
    });
    const user = userEvent.setup();
    render(<InventoryAssistant assistant={assistant} items={[soap]} onApply={vi.fn()} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText("Ask about inventory or propose an edit"), "Rename Dish soap");
    await user.click(screen.getByRole("button", { name: "Ask Home" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enable local assistant" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("139 MB required; 10 MB available");
    expect(localRuntime.loadModelFromUrl).not.toHaveBeenCalled();
  });

  it("continues when quota estimation is unavailable and does not persist prompts", async () => {
    const localRuntime = runtime();
    const assistant = new BrowserAssistant(async () => localRuntime, {});
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<InventoryAssistant assistant={assistant} items={[soap]} onApply={vi.fn()} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText("Ask about inventory or propose an edit"), "Rename Dish soap");
    await user.click(screen.getByRole("button", { name: "Ask Home" }));
    await user.click(screen.getByRole("button", { name: "Enable local assistant" }));

    expect(await screen.findByRole("heading", { name: "Proposed change to Dish soap" })).toBeInTheDocument();
    expect(localRuntime.loadModelFromUrl).toHaveBeenCalledOnce();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(screen.queryByText(/source \d/i)).not.toBeInTheDocument();
  });

  it("shows real model download progress", async () => {
    let finish!: () => void;
    const localRuntime = runtime();
    localRuntime.loadModelFromUrl = vi.fn((_source, options) => new Promise<void>((resolve) => {
      finish = resolve;
      options.progressCallback({ loaded: LOCAL_MODEL.sizeBytes / 2, total: LOCAL_MODEL.sizeBytes });
    }));
    const assistant = new BrowserAssistant(async () => localRuntime);
    const user = userEvent.setup();
    render(<InventoryAssistant assistant={assistant} items={[soap]} onApply={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText("Ask about inventory or propose an edit"), "Rename Dish soap");
    await user.click(screen.getByRole("button", { name: "Ask Home" }));
    await user.click(screen.getByRole("button", { name: "Enable local assistant" }));
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveValue(50);
    finish();
    expect(await screen.findByRole("heading", { name: "Proposed change to Dish soap" })).toBeInTheDocument();
  });

  it("surfaces a load failure and retries in the same dialog", async () => {
    const failingRuntime = runtime();
    failingRuntime.loadModelFromUrl = vi.fn(async () => { throw new Error("Device storage is full"); });
    const assistant = new BrowserAssistant(async () => failingRuntime);
    const user = userEvent.setup();
    render(<InventoryAssistant assistant={assistant} items={[soap]} onApply={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText("Ask about inventory or propose an edit"), "Rename Dish soap");
    await user.click(screen.getByRole("button", { name: "Ask Home" }));
    await user.click(screen.getByRole("button", { name: "Enable local assistant" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Device storage is full");
    failingRuntime.loadModelFromUrl = vi.fn(async (_source, options) => options.progressCallback({ loaded: LOCAL_MODEL.sizeBytes, total: LOCAL_MODEL.sizeBytes }));
    await user.click(screen.getByRole("button", { name: "Retry local assistant" }));
    expect(await screen.findByRole("heading", { name: "Proposed change to Dish soap" })).toBeInTheDocument();
  });

  it("cancels a proposal without applying it", async () => {
    const localRuntime = runtime();
    const assistant = new BrowserAssistant(async () => localRuntime);
    const onApply = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<InventoryAssistant assistant={assistant} items={[soap]} onApply={onApply} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText("Ask about inventory or propose an edit"), "Rename Dish soap");
    await user.click(screen.getByRole("button", { name: "Ask Home" }));
    await user.click(screen.getByRole("button", { name: "Enable local assistant" }));
    await screen.findByRole("heading", { name: "Proposed change to Dish soap" });
    expect(screen.getByText("Dish soap", { selector: ".assistant-proposal__comparison td" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Proposed change to Dish soap" })).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("keeps a loaded model ready after a generation error", async () => {
    const localRuntime = runtime();
    vi.mocked(localRuntime.createChatCompletion)
      .mockRejectedValueOnce(new Error("Generation stopped"))
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"intent":"rename","item":"Dish soap","name":"Washing-up liquid"}' } }] });
    const assistant = new BrowserAssistant(async () => localRuntime);
    const user = userEvent.setup();
    render(<InventoryAssistant assistant={assistant} items={[soap]} onApply={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByLabelText("Ask about inventory or propose an edit");
    await user.type(input, "Rename Dish soap");
    await user.click(screen.getByRole("button", { name: "Ask Home" }));
    await user.click(screen.getByRole("button", { name: "Enable local assistant" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Generation stopped");
    await user.clear(input);
    await user.type(input, "Rename Dish soap again");
    await user.click(screen.getByRole("button", { name: "Ask Home" }));
    expect(await screen.findByRole("heading", { name: "Proposed change to Dish soap" })).toBeInTheDocument();
    expect(localRuntime.loadModelFromUrl).toHaveBeenCalledOnce();
  });

  it("traps focus and restores it when closed", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    render(<InventoryAssistant assistant={new BrowserAssistant(async () => runtime())} items={[soap]} onApply={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Ask Home" });
    const close = within(dialog).getByRole("button", { name: "Close assistant" });
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("*")).filter((element) => (
      element.matches('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')
    ));
    const last = focusable[focusable.length - 1];
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    cleanup();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
