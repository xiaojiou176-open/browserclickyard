/* @vitest-environment jsdom */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HelpPanel from "./HelpPanel";

describe("HelpPanel accessibility contract", () => {
  it("renders as modal dialog with labels and description", () => {
    const { container } = render(
      <HelpPanel activeView="launch" onClose={() => {}} onRestartTour={() => {}} />,
    );
    const html = container.innerHTML;
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain('aria-label="Close help panel"');
  });
});
