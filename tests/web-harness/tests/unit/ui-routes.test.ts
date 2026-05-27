import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/App";

function renderApp(path: string): void {
  render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)));
}

afterEach(() => {
  cleanup();
});

describe("web app routes and UI behavior", () => {
  it("renders the app shell and navigation", () => {
    renderApp("/");

    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByTestId("app-title")).toHaveTextContent("Browserclickyard Demo");
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByTestId("nav-home")).toHaveAttribute("href", "/");
    expect(screen.getByTestId("nav-about")).toHaveAttribute("href", "/about");
    expect(screen.getByTestId("nav-contact")).toHaveAttribute("href", "/contact");
    expect(screen.getByTestId("nav-safe")).toHaveAttribute("href", "/safe");
    expect(screen.getByTestId("nav-stories")).toHaveAttribute("href", "/stories/counter-default");
  });

  it("applies active route semantics on navigation links", () => {
    renderApp("/about");

    expect(screen.getByTestId("nav-about")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-home")).not.toHaveAttribute("aria-current");
  });

  it("updates counter state through increment, decrement and reset", () => {
    renderApp("/");

    expect(screen.getByTestId("counter-value")).toHaveTextContent("0");
    expect(screen.getByTestId("counter-inc")).toHaveAttribute("type", "button");
    expect(screen.getByTestId("counter-dec")).toHaveAttribute("type", "button");
    expect(screen.getByTestId("counter-reset")).toHaveAttribute("type", "button");

    fireEvent.click(screen.getByTestId("counter-inc"));
    fireEvent.click(screen.getByTestId("counter-inc"));
    expect(screen.getByTestId("counter-value")).toHaveTextContent("2");

    fireEvent.click(screen.getByTestId("counter-dec"));
    expect(screen.getByTestId("counter-value")).toHaveTextContent("1");

    fireEvent.click(screen.getByTestId("counter-reset"));
    expect(screen.getByTestId("counter-value")).toHaveTextContent("0");
    expect(screen.getByTestId("home-summary")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("home-summary")).getByRole("heading", { level: 2 }),
    ).toHaveTextContent("State Coverage Summary");
  });

  it("toggles about details", () => {
    renderApp("/about");

    expect(screen.getByTestId("about-toggle")).toHaveAttribute("type", "button");
    expect(screen.getByTestId("about-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("about-details")).not.toBeVisible();
    fireEvent.click(screen.getByTestId("about-toggle"));
    expect(screen.getByTestId("about-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("about-details")).toBeVisible();
    fireEvent.click(screen.getByTestId("about-toggle"));
    expect(screen.getByTestId("about-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("about-details")).not.toBeVisible();
  });

  it("validates and submits feedback", () => {
    renderApp("/contact");
    const submitButton = screen.getByTestId("feedback-submit");
    const nameInput = screen.getByLabelText("Name");
    const messageInput = screen.getByLabelText("Message");

    expect(submitButton).toHaveAttribute("type", "submit");

    fireEvent.change(nameInput, { target: { value: "A" } });
    fireEvent.change(messageInput, { target: { value: "12345678" } });
    fireEvent.click(submitButton);
    expect(screen.getByTestId("feedback-result")).toHaveTextContent(
      "Name must contain at least 2 characters.",
    );
    expect(nameInput).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(nameInput, { target: { value: "Alex" } });
    fireEvent.change(messageInput, { target: { value: "short" } });
    fireEvent.click(submitButton);
    expect(screen.getByTestId("feedback-result")).toHaveTextContent(
      "Message must contain at least 8 characters.",
    );
    expect(messageInput).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(messageInput, {
      target: { value: "a long enough message" },
    });
    fireEvent.click(submitButton);
    expect(screen.getByTestId("feedback-result")).toHaveTextContent("Feedback submitted.");
    expect(nameInput).not.toHaveAttribute("aria-invalid");
    expect(messageInput).not.toHaveAttribute("aria-invalid");
    expect(screen.getByTestId("feedback-result")).toHaveAttribute("role", "status");
  });

  it("toggles safe mode", () => {
    renderApp("/safe");

    expect(screen.getByTestId("safe-state")).toHaveTextContent("safe_mode=off");
    fireEvent.click(screen.getByTestId("safe-toggle"));
    expect(screen.getByTestId("safe-state")).toHaveTextContent("safe_mode=on");
  });

  it("renders story route and falls back to default story when unknown id is provided", () => {
    renderApp("/stories/feedback-default");
    expect(screen.getByTestId("story-title")).toHaveTextContent("Feedback / Default");
    expect(screen.getByTestId("feedback-form")).toBeInTheDocument();
    expect(screen.getByTestId("story-content")).toBeInTheDocument();

    cleanup();
    renderApp("/stories/unknown-story");
    expect(screen.getByTestId("story-title")).toHaveTextContent("Counter / Default");
    expect(screen.getByTestId("counter-card")).toBeInTheDocument();
  });
});
