import {
  __resetFilesTree,
  filesTreeState,
  isOpen,
  open,
  openAncestors,
  toggle,
  noteDeletedFile,
  isDeletedFile,
} from "./files-tree";

describe("files tree expanded folders", () => {
  beforeEach(() => __resetFilesTree());
  afterEach(() => __resetFilesTree());

  it("has a closed-folder default and an always-open root", () => {
    expect(filesTreeState()).toMatchInlineSnapshot(`
      {
        "expanded": [],
      }
    `);
    expect(isOpen("")).toBe(true);
    expect(isOpen("Projects")).toBe(false);
  });

  it("persists toggles, folders, and ancestors without storing the root", () => {
    toggle("Projects");
    open("Projects/sightr");
    openAncestors("Projects/sightr/README.md");

    expect(filesTreeState().expanded).toEqual(["Projects", "Projects/sightr"]);
    expect(JSON.parse(localStorage.getItem("sightr:files-tree:v1") ?? "null")).toEqual({
      expanded: ["Projects", "Projects/sightr"],
    });
    expect(filesTreeState().expanded).not.toContain("");
  });

  it("toggles a folder closed again", () => {
    toggle("Projects");
    toggle("Projects");
    expect(filesTreeState().expanded).toEqual([]);
    expect(JSON.parse(localStorage.getItem("sightr:files-tree:v1") ?? "null")).toEqual({ expanded: [] });
  });

  it("opens a folder only once", () => {
    open("Projects");
    open("Projects");
    expect(filesTreeState().expanded).toEqual(["Projects"]);
  });

  it("keeps the root open without storing it", () => {
    toggle("");
    open("");
    expect(filesTreeState().expanded).toEqual([]);
    expect(isOpen("")).toBe(true);
  });

  it("does not expand a single-segment path", () => {
    openAncestors("README.md");
    expect(filesTreeState().expanded).toEqual([]);
  });

  it("falls back to empty for corrupt stored values", () => {
    localStorage.setItem("sightr:files-tree:v1", "not json");
    expect(filesTreeState()).toEqual({ expanded: [] });
    __resetFilesTree();
    localStorage.setItem("sightr:files-tree:v1", '{"expanded":"nope"}');
    expect(filesTreeState()).toEqual({ expanded: [] });
  });

  it("tracks deleted files in memory without persisting them", () => {
    noteDeletedFile("src/notes.md");
    expect(isDeletedFile("src/notes.md")).toBe(true);
    expect(localStorage.getItem("sightr:files-tree:v1")).toBeNull();
    __resetFilesTree();
    expect(isDeletedFile("src/notes.md")).toBe(false);
  });

  it("resets memory and storage", () => {
    open("Projects");
    __resetFilesTree();
    expect(filesTreeState()).toEqual({ expanded: [] });
    expect(localStorage.getItem("sightr:files-tree:v1")).toBeNull();
  });
});
