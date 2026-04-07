/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import OnboardingTour from "./OnboardingTour";

const RECOMMENDED_FIRST_PATH =
  "Recommended first path: enter a URL, choose a lab mode, run the experiment, then inspect the latest result before opening Advanced Review.";

describe("OnboardingTour accessibility contract", () => {
  it("renders nothing when inactive", () => {
    const { container } = render(<OnboardingTour active={false} onComplete={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a modal dialog with backdrop when active", async () => {
    render(<OnboardingTour active onComplete={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const html = document.body.innerHTML;
    expect(dialog).toBeTruthy();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('class="tour-backdrop"');
    expect(html).toContain('class="tour-spotlight"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain(RECOMMENDED_FIRST_PATH);
  });
});
