import { Plugin } from "@opencode/plugin";
import { setupWatchdog } from "./opencode/runtime";

const plugin = Plugin.define({
  id: "opencode-watchdog",
  setup: (context) => setupWatchdog({
    location: { directory: context.location.project.directory },
    options: context.options,
    event: context.event,
    session: context.session,
  }),
});

export default plugin;
export { plugin };
