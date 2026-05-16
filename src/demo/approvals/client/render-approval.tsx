import { renderToString } from "react-dom/server";
import type { ProgramStreamBootstrap } from "../../../stream";
import type { TraceSnapshot } from "../../../trace";
import type { ApprovalProjection } from "../types";
import { ApprovalApp } from "./approval-app";

export function renderApprovalApp(
  bootstrap: ProgramStreamBootstrap<ApprovalProjection, TraceSnapshot>,
): string {
  return renderToString(<ApprovalApp bootstrap={bootstrap} />);
}
