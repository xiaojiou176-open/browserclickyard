import { test } from "./playwright-ct-runtime.js";
import {
  createCounterCardClickActionsCase,
  createCounterCardDecrementCase,
  createCounterCardIncrementCase,
  createCounterCardResetCase,
} from "./counter-card.spec-helpers.js";

const counterCard = {
  __pw_type: "jsx",
  type: {
    __pw_type: "importRef",
    id: "uiqCounterCard",
  },
  props: {
    title: "CT Counter",
  },
  key: null,
};

test("counter card responds to click actions", createCounterCardClickActionsCase(counterCard));

test("appsweb-counter-inc", createCounterCardIncrementCase(counterCard));

test("appsweb-counter-dec", createCounterCardDecrementCase(counterCard));

test("appsweb-counter-reset", createCounterCardResetCase(counterCard));
