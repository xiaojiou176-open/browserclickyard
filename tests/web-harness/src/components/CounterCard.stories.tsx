import type { Meta, StoryObj } from "@storybook/react";
import { CounterCard } from "./CounterCard";

const meta = {
  title: "Components/CounterCard",
  component: CounterCard,
  args: {
    title: "Storybook Counter",
  },
  tags: ["autodocs"],
} satisfies Meta<typeof CounterCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongTitle: Story = {
  args: {
    title: "Counter Card With A Longer Title For Layout Regression Checks",
  },
};
