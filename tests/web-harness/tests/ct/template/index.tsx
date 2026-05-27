// @ts-nocheck

import "../../../src/styles.css";

const uiqCounterCard = () =>
  import("../../../src/components/CounterCard").then((module) => module.CounterCard);

queueMicrotask(() => {
  window.__pwRegistry.initialize({ uiqCounterCard });
});
