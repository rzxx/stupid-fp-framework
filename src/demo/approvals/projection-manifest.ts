import type { ProjectionPatchManifest } from "../../framework";
import type { ApprovalProjection } from "./types";

export const approvalProjectionPatchManifest: ProjectionPatchManifest<ApprovalProjection> = {
  projectionVersion: 1,
  regions: {
    pendingDeployments: {
      kind: "replace-at-path",
      path: ["pendingDeployments"],
    },
    selectedDeployment: {
      kind: "replace-at-path",
      path: ["selectedDeployment"],
    },
    activeRuns: {
      kind: "replace-at-path",
      path: ["activeRuns"],
    },
    tracePanel: {
      kind: "replace-fields",
      fields: [
        { from: ["open"], to: ["tracePanelOpen"] },
        { from: ["traces"], to: ["traces"] },
      ],
    },
  },
};
