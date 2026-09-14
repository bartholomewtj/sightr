import { homePath, panePath, tracePath } from "./nav";

describe("panePath", () => {
  it("URL-encodes the colon in a pane id", () => {
    expect(panePath("wE:p2")).toBe("/pane/wE%3Ap2");
  });

  it("leaves a colon-free id alone", () => {
    expect(panePath("abc")).toBe("/pane/abc");
  });

  it("round-trips back to the original pane id via decodeURIComponent", () => {
    const id = "w1:p1";
    const encoded = panePath(id).replace("/pane/", "");
    expect(decodeURIComponent(encoded)).toBe(id);
  });

});

describe("homePath", () => {
  it("is '/'", () => {
    expect(homePath()).toBe("/");
  });
});

describe("tracePath", () => {
  it("is space + repo, encoded, with no query when there is no scope", () => {
    expect(tracePath("w1", "sightr")).toBe("/traces/w1/sightr");
    expect(tracePath("w1", "my repo")).toBe("/traces/w1/my%20repo");
  });

  it("carries a pane scope and a pinned run, encoded", () => {
    expect(tracePath("w1", "sightr", { pane: "w1:p2" })).toBe("/traces/w1/sightr?pane=w1%3Ap2");
    expect(tracePath("w1", "sightr", { pane: "w1:p2", adw: "ab12" })).toBe(
      "/traces/w1/sightr?pane=w1%3Ap2&adw=ab12",
    );
  });
});
