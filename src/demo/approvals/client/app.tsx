import { createRoot, hydrateRoot } from "react-dom/client";
import type { ProgramStreamBootstrap, TraceSnapshot } from "../../../framework";
import type { ApprovalProjection } from "../types";
import { ApprovalApp } from "./approval-app";

declare global {
  interface Window {
    __STUPID_FP_BOOTSTRAP__?: ProgramStreamBootstrap<ApprovalProjection, TraceSnapshot>;
  }
}

const root = document.getElementById("root") as HTMLElement;
const bootstrap = window.__STUPID_FP_BOOTSTRAP__;
const app = <ApprovalApp bootstrap={bootstrap} />;

if (bootstrap && root.hasChildNodes()) {
  hydrateRoot(root, app);
} else {
  createRoot(root).render(app);
}
