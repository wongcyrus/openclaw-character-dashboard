import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreview } from "./FilePreview";

const highlight = vi.hoisted(() => ({
  highlight: vi.fn(
    (
      content: string,
      _options?: { language: string; ignoreIllegals: boolean },
    ) => ({ value: `highlighted:${content}` }),
  ),
  highlightAuto: vi.fn((content: string) => ({ value: `auto:${content}` })),
}));

vi.mock("highlight.js", () => ({
  default: highlight,
}));

function mockTextResponse(text: string, ok = true, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      text: async () => text,
      blob: async () => new Blob([text]),
    }),
  );
}

describe("FilePreview", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.className = "";
  });

  it.each([
    ["photo.png", "img", "src"],
    ["sound.mp3", "audio", "src"],
    ["movie.mp4", "video", "src"],
    ["report.pdf", "embed", "src"],
  ])("loads protected media for %s", async (filePath, selector, attribute) => {
    mockTextResponse("binary");
    const { container } = render(<FilePreview filePath={filePath} />);
    await waitFor(() =>
      expect(container.querySelector(selector)).toHaveAttribute(
        attribute,
        "blob:preview",
      ),
    );
  });

  it("renders a protected download button for unknown files", () => {
    render(<FilePreview filePath="archive/my file.bin" />);
    expect(screen.getByText(/No preview available/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Download file" })).toBeVisible();
  });

  it("loads markdown and toggles rendered and raw views", async () => {
    mockTextResponse("# Heading\n\nBody");
    render(<FilePreview filePath="README.md" />);

    expect(screen.getByText("Loading…")).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "Heading" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(document.querySelector(".file-preview-md__raw")).toHaveTextContent(
      "# Heading Body",
    );
    fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
    expect(screen.getByRole("heading", { name: "Heading" })).toBeVisible();
  });

  it("shows fetch errors for textual previews", async () => {
    mockTextResponse("", false, 404);
    const { rerender } = render(<FilePreview filePath="missing.md" />);
    expect(await screen.findByText("Error: HTTP 404")).toBeVisible();

    rerender(<FilePreview filePath="missing.ts" />);
    expect(await screen.findByText("Error: HTTP 404")).toBeVisible();

    rerender(<FilePreview filePath="missing.json" />);
    expect(await screen.findByText("Error: HTTP 404")).toBeVisible();

    rerender(<FilePreview filePath="missing.csv" />);
    expect(await screen.findByText("Error: HTTP 404")).toBeVisible();
  });

  it("highlights text and falls back to automatic language detection", async () => {
    mockTextResponse("const value = 1;");
    const { rerender } = render(<FilePreview filePath="sample.ts" />);
    await waitFor(() =>
      expect(highlight.highlight).toHaveBeenCalledWith("const value = 1;", {
        language: "ts",
        ignoreIllegals: true,
      }),
    );
    expect(screen.getByText("highlighted:const value = 1;")).toBeVisible();

    highlight.highlight.mockImplementation(
      (
        content: string,
        options?: { language: string; ignoreIllegals: boolean },
      ) => {
        if (options?.language === "Dockerfile") {
          throw new Error("unknown language");
        }
        return { value: `highlighted:${content}` };
      },
    );
    mockTextResponse("plain text");
    rerender(<FilePreview filePath="Dockerfile" />);
    await waitFor(() =>
      expect(highlight.highlightAuto).toHaveBeenCalledWith("plain text"),
    );
    expect(screen.getByText("auto:plain text")).toBeVisible();
  });

  it("renders structured JSON primitives and interactive modes", async () => {
    mockTextResponse(
      JSON.stringify({
        name: "Alice",
        age: 42,
        active: true,
        missing: null,
        nested: { values: [1, 2] },
      }),
    );
    render(<FilePreview filePath="data.json" />);

    expect(await screen.findByText('"Alice"')).toBeVisible();
    expect(screen.getByText("42")).toBeVisible();
    expect(screen.getByText("true")).toBeVisible();
    expect(screen.getByText("null")).toBeVisible();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Collapse object" })[0],
    );
    expect(screen.getByText("{5 keys}")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Expand object" }));

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.getByRole("button", { name: "Expand object" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(screen.getByText(/"name":"Alice"/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.getByText(/"nested"/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText('"Alice"')).toBeVisible();
  });

  it("falls back to raw text for malformed JSON", async () => {
    mockTextResponse("{invalid");
    render(<FilePreview filePath="broken.json" />);
    expect(await screen.findByText("{invalid")).toBeVisible();
  });

  it("parses quoted CSV fields, toggles raw mode, and resizes columns", async () => {
    mockTextResponse(
      'name,notes\r\nAlice,"hello, world"\r\nBob,"line 1\nline 2"\r\n',
    );
    render(<FilePreview filePath="people.csv" />);

    expect(await screen.findByText("3 rows · 2 cols")).toBeVisible();
    expect(screen.getByText("hello, world")).toBeVisible();
    expect(screen.getByText(/line 1/)).toBeVisible();

    const separator = screen.getByRole("separator", { name: "Resize name" });
    const header = separator.parentElement;
    if (!header) throw new Error("header missing");
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 20,
      x: 0,
      y: 0,
      top: 0,
      right: 120,
      bottom: 20,
      left: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(separator, { clientX: 100 });
    expect(document.body).toHaveClass("file-preview-csv--resizing");
    fireEvent.pointerMove(window, { clientX: 20 });
    fireEvent.pointerUp(window);
    expect(document.body).not.toHaveClass("file-preview-csv--resizing");

    fireEvent.click(screen.getByRole("button", { name: "Raw text" }));
    expect(screen.getByText(/Alice,"hello, world"/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    expect(screen.getByText("Alice")).toBeVisible();
  });

  it("parses TSV content and handles an empty file", async () => {
    mockTextResponse("name\tage\nAlice\t42");
    const { rerender } = render(<FilePreview filePath="people.tsv" />);
    expect(await screen.findByText("2 rows · 2 cols")).toBeVisible();
    expect(screen.getByText("42")).toBeVisible();

    mockTextResponse("");
    rerender(<FilePreview filePath="empty.csv" />);
    expect(await screen.findByText("0 rows")).toBeVisible();
  });
});
