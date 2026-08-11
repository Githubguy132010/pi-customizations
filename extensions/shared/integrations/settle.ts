import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SETTLE_WORKFLOW_REQUEST_EVENT = "pi-customizations:settle-workflow-request";

export type SettleWorkflow = (args: string, ctx: ExtensionContext) => Promise<void>;

interface SettleWorkflowRequest {
  workflow?: SettleWorkflow;
}

/** Advertise /settle functionality without making /yeet depend on the settle extension. */
export function registerSettleWorkflow(pi: ExtensionAPI, workflow: SettleWorkflow): void {
  pi.events.on(SETTLE_WORKFLOW_REQUEST_EVENT, (data) => {
    const request = data as SettleWorkflowRequest;
    request.workflow ??= workflow;
  });
}

/** Resolve the optional settle integration synchronously through Pi's extension event bus. */
export function resolveSettleWorkflow(pi: ExtensionAPI): SettleWorkflow | undefined {
  const request: SettleWorkflowRequest = {};
  pi.events.emit(SETTLE_WORKFLOW_REQUEST_EVENT, request);
  return request.workflow;
}
