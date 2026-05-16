import { mountProgramReact } from "../../../adapters/react";
import type { ProgramStreamBootstrap } from "../../../stream";
import type { TraceSnapshot } from "../../../trace";
import type { ApprovalProjection } from "../types";
import { ApprovalApp } from "./approval-app";
import "./styles.css";

declare global {
  interface Window {
    __STUPID_FP_BOOTSTRAP__?: ProgramStreamBootstrap<ApprovalProjection, TraceSnapshot>;
  }
}

const root = document.getElementById("root") as HTMLElement;
const bootstrap = window.__STUPID_FP_BOOTSTRAP__;
const renderErrorMessage =
  process.env.NODE_ENV === "development" ? undefined : "An unexpected error occurred";

mountProgramReact({
  root,
  bootstrap,
  render: (initial) => <ApprovalApp bootstrap={initial} />,
  errorFallback: (error) => (
    <main className="app-shell">
      <section className="banner error">
        {renderErrorMessage ?? (error instanceof Error ? error.message : "React render failed")}
      </section>
    </main>
  ),
});
