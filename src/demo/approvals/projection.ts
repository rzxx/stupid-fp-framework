import { Region, type ProjectionPatchManifest } from "../../framework/projection";
import type { ApprovalProjection } from "./types";

export const approvalProjectionPatchManifest = {
  projectionVersion: 1,
  regions: {
    layout: Region.merge(),
    pendingDeployments: Region.replace(),
    selectedDeployment: Region.replace(),
    activeRuns: Region.replace(),
  },
} satisfies ProjectionPatchManifest<ApprovalProjection>;
