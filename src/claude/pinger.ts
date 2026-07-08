import { buildPingPrompt, type Pinger, type PingContext } from "../pinger";

export type StdoutWriter = (line: string) => void;

// Emits the ping as a single stdout line. Claude Code delivers monitor stdout
// lines to the session as notifications (SPEC §6.2). stdout is RESERVED for
// ping/notification lines only — all logs go through `log` (stderr) so the
// monitor's stdout discipline holds (SPEC §6.4).
export class ClaudeCodeAdapter implements Pinger {
  constructor(
    private readonly writeStdout: StdoutWriter,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async inject(sessionId: string, message: string, context?: PingContext): Promise<void> {
    const maskedSessionId = sessionId.length > 4 ? `${sessionId.slice(0, 4)}***` : "***";
    const finalMessage = buildPingPrompt(message, context?.reason);
    try {
      // Strip embedded newlines so the ping is exactly one stdout line.
      this.writeStdout(`${finalMessage.replace(/\r?\n/g, " ")}\n`);
      this.log(`PINGER stdout inject sessionId=${maskedSessionId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const maskedErr = msg.length > 30 ? `${msg.slice(0, 30)}... (redacted)` : msg;
      this.log(`PINGER stdout failed sessionId=${maskedSessionId} err=${maskedErr}`);
    }
  }
}
