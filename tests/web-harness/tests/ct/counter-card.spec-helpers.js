import { expect } from "./playwright-ct-runtime.js";

export function createCounterCardClickActionsCase(component) {
  return async ({ mount }) => {
    const mounted = await mount(component);
    await expect(mounted.getByTestId("counter-value")).toHaveText("0");
    await expect(mounted.getByTestId("counter-inc")).toHaveAttribute("type", "button");
    await expect(mounted.getByTestId("counter-dec")).toHaveAttribute("type", "button");
    await expect(mounted.getByTestId("counter-reset")).toHaveAttribute("type", "button");

    await mounted.getByTestId("counter-inc").click();
    await expect(mounted.getByTestId("counter-value")).toHaveText("1");

    await mounted.getByTestId("counter-dec").click();
    await expect(mounted.getByTestId("counter-value")).toHaveText("0");

    await mounted.getByTestId("counter-reset").click();
    await expect(mounted.getByTestId("counter-value")).toHaveText("0");
  };
}

export function createCounterCardIncrementCase(component) {
  return async ({ mount }) => {
    const mounted = await mount(component);
    await mounted.getByTestId("counter-inc").click();
    await expect(mounted.getByTestId("counter-value")).toHaveText("1");
  };
}

export function createCounterCardDecrementCase(component) {
  return async ({ mount }) => {
    const mounted = await mount(component);
    await mounted.getByTestId("counter-inc").click();
    await mounted.getByTestId("counter-dec").click();
    await expect(mounted.getByTestId("counter-value")).toHaveText("0");
  };
}

export function createCounterCardResetCase(component) {
  return async ({ mount }) => {
    const mounted = await mount(component);
    await mounted.getByTestId("counter-inc").click();
    await mounted.getByTestId("counter-reset").click();
    await expect(mounted.getByTestId("counter-value")).toHaveText("0");
  };
}
