export interface TelemetrySnapshot {
  hangupsDetected: number;
  pingsSent: number;
  recoveries: number;
  silencedFailures: number;
  recoveryRate: number | null;
}

export interface Telemetry {
  recordHangup(): void;
  recordPing(): void;
  recordRecovery(): void;
  recordFailure(): void;
  snapshot(): TelemetrySnapshot;
  report(): string;
}

export class TelemetryCollector implements Telemetry {
  private hangupsDetected = 0;
  private pingsSent = 0;
  private recoveries = 0;
  private silencedFailures = 0;

  recordHangup(): void {
    this.hangupsDetected += 1;
  }
  recordPing(): void {
    this.pingsSent += 1;
  }
  recordRecovery(): void {
    this.recoveries += 1;
  }
  recordFailure(): void {
    this.silencedFailures += 1;
  }

  snapshot(): TelemetrySnapshot {
    const denom = this.recoveries + this.silencedFailures;
    const recoveryRate = denom === 0 ? null : this.recoveries / denom;
    return {
      hangupsDetected: this.hangupsDetected,
      pingsSent: this.pingsSent,
      recoveries: this.recoveries,
      silencedFailures: this.silencedFailures,
      recoveryRate,
    };
  }

  report(): string {
    const s = this.snapshot();
    const rate = s.recoveryRate === null ? "n/a" : `${(s.recoveryRate * 100).toFixed(1)}%`;
    return `[Telemetry] hangups=${s.hangupsDetected} pings=${s.pingsSent} recoveries=${s.recoveries} failures=${s.silencedFailures} recoveryRate=${rate}`;
  }
}

export class NoopTelemetry implements Telemetry {
  recordHangup(): void {}
  recordPing(): void {}
  recordRecovery(): void {}
  recordFailure(): void {}

  snapshot(): TelemetrySnapshot {
    return {
      hangupsDetected: 0,
      pingsSent: 0,
      recoveries: 0,
      silencedFailures: 0,
      recoveryRate: null,
    };
  }

  report(): string {
    return "[Telemetry] hangups=0 pings=0 recoveries=0 failures=0 recoveryRate=n/a";
  }
}
