import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WORKDIR_RESOLVER_REQUEST_EVENT = "pi-customizations:workdir-resolver-request";

type WorkdirResolver = (ctx: ExtensionContext) => string;

interface WorkdirResolverRequest {
  resolver?: WorkdirResolver;
}

/** Advertise session workdir restoration to extensions that need a cwd. */
export function registerWorkdirResolver(pi: ExtensionAPI, resolver: WorkdirResolver): void {
  pi.events.on(WORKDIR_RESOLVER_REQUEST_EVENT, (data) => {
    const request = data as WorkdirResolverRequest;
    request.resolver ??= resolver;
  });
}

/** Use the optional persisted workdir, falling back to Pi's current context. */
export function resolveExtensionWorkdir(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const request: WorkdirResolverRequest = {};
  pi.events.emit(WORKDIR_RESOLVER_REQUEST_EVENT, request);
  return request.resolver?.(ctx) ?? ctx.cwd;
}
