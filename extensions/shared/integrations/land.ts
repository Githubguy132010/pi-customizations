import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LAND_WORKFLOW_REQUEST_EVENT = "pi-customizations:land-workflow-request";

export type LandWorkflow = (args: string, ctx: ExtensionContext) => Promise<void>;

interface LandWorkflowRequest {
  workflow?: LandWorkflow;
}

/** Advertise /land functionality without making /yeet depend on the land extension. */
export function registerLandWorkflow(pi: ExtensionAPI, workflow: LandWorkflow): void {
  pi.events.on(LAND_WORKFLOW_REQUEST_EVENT, (data) => {
    const request = data as LandWorkflowRequest;
    request.workflow ??= workflow;
  });
}

/** Resolve the optional land integration synchronously through Pi's extension event bus. */
export function resolveLandWorkflow(pi: ExtensionAPI): LandWorkflow | undefined {
  const request: LandWorkflowRequest = {};
  pi.events.emit(LAND_WORKFLOW_REQUEST_EVENT, request);
  return request.workflow;
}
