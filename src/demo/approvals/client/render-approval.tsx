import { renderToString } from "react-dom/server";
import type { ProgramStreamBootstrap, TraceSnapshot } from "../../../framework";
import type { ApprovalProjection } from "../types";
import { ApprovalApp } from "./approval-app";

export function renderApprovalApp(
  bootstrap: ProgramStreamBootstrap<ApprovalProjection, TraceSnapshot>,
): string {
  return renderToString(<ApprovalApp bootstrap={bootstrap} />);
}
