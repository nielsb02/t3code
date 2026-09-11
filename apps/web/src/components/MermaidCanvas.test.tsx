import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import MermaidCanvas, { zoomDiagram } from "./MermaidCanvas";
import { Button } from "./ui/button";

describe("Mermaid canvas navigation", () => {
  it("keeps the point under the cursor stationary while zooming a panned diagram", () => {
    const view = { x: 30, y: -20, scale: 2 };
    const next = zoomDiagram(view, 1.5, 100, 80);
    expect((100 - next.x) / next.scale).toBe((100 - view.x) / view.scale);
    expect((80 - next.y) / next.scale).toBe((80 - view.y) / view.scale);
    expect(next.scale).toBe(3);
  });

  it("clamps zoom and leaves a view at its limit stationary", () => {
    const view = { x: 30, y: -20, scale: 8 };
    expect(zoomDiagram(view, 2, 100, 80)).toEqual(view);
    expect(zoomDiagram(view, 0.001).scale).toBe(0.25);
  });

  it("pans with captured pointers, zooms, resets, and ignores a released pointer", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<MermaidCanvas svg='<svg viewBox="0 0 100 100" />' />);
      });
      const canvas = renderer!.root.findByProps({ role: "region" });
      const target = { focus: vi.fn(), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
      const pointer = { button: 0, pointerId: 1, clientX: 10, clientY: 20, currentTarget: target };
      await act(async () => {
        canvas.props.onPointerDown(pointer);
        canvas.props.onPointerMove({ ...pointer, clientX: 50, clientY: 70 });
      });
      const transform = () =>
        renderer!.root.findByProps({ "data-mermaid-diagram": "" }).props.style.transform;
      expect(transform()).toBe("translate(40px, 50px) scale(1)");
      await act(async () => {
        canvas.props.onPointerUp(pointer);
        canvas.props.onPointerMove({ ...pointer, clientX: 100, clientY: 100 });
      });
      expect(transform()).toBe("translate(40px, 50px) scale(1)");
      await act(async () => {
        renderer!.root
          .findAllByType(Button)
          .find((button) => button.props["aria-label"] === "Zoom in")!
          .props.onClick();
      });
      expect(transform()).toBe("translate(50px, 62.5px) scale(1.25)");
      await act(async () => {
        canvas.props.onKeyDown({ key: "0", preventDefault: vi.fn(), stopPropagation: vi.fn() });
      });
      expect(transform()).toBe("translate(0px, 0px) scale(1)");
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});
