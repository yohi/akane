import { RGBA } from "@opentui/core";
import { createElement, insert, setProp, testRender } from "@opentui/solid";
import { describe, expect, it } from "bun:test";

describe("OpenTUI Solid rendering", () => {
  it("renders inline text colors from style.fg", async () => {
    const fg = RGBA.fromInts(0, 206, 209, 255);
    const setup = await testRender(
      () => {
        const text = createElement("text");
        const span = createElement("span");
        setProp(span, "style", { fg });
        insert(span, "Akane color probe");
        insert(text, span);
        return text;
      },
      { width: 40, height: 5 },
    );

    try {
      await setup.renderOnce();
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      const coloredSpan = spans.find((span) => span.text.includes("Akane color probe"));
      expect(coloredSpan).toBeDefined();

      expect(coloredSpan?.fg.toInts()).toEqual(fg.toInts());
    } finally {
      setup.renderer.destroy();
    }
  });
});
