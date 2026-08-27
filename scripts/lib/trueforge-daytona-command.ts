import { z } from "zod";

export const DaytonaNodeArchiveName = "node-v22.23.2-linux-x64.tar.gz";
export const DaytonaNodeArchiveSha256 =
  "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a";
export const DaytonaEvidenceScriptName = "daytona-reducer-evidence.sh";
export const DaytonaEvidenceScriptSha256 =
  "619fab9f4375c84b402c52b21597aeafcd3d414e942f7dca347cf6f53ca7f3ab";
export const DaytonaProviderExecTimeoutSeconds = 180;

const ScriptDownloadTimeoutSeconds = 12;
const ScriptDownloadKillAfterSeconds = 2;
const EvidenceExecutionTimeoutSeconds = 140;
const EvidenceExecutionKillAfterSeconds = 5;
const EvidenceExecutionOuterMarginSeconds = 5;
const LauncherSetupCleanupMarginSeconds = 10;
export const DaytonaLauncherWorstCaseSeconds =
  ScriptDownloadTimeoutSeconds +
  ScriptDownloadKillAfterSeconds +
  EvidenceExecutionTimeoutSeconds +
  EvidenceExecutionKillAfterSeconds +
  EvidenceExecutionOuterMarginSeconds +
  EvidenceExecutionKillAfterSeconds +
  LauncherSetupCleanupMarginSeconds;

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const TimeoutSecondsSchema = z.number().int().positive().max(180);

export function buildBoundedNpmCiCommand(
  aggregateTimeoutSeconds = 75,
  attemptTimeoutSeconds = 32,
  killAfterSeconds = 2,
): string {
  const aggregateTimeout = TimeoutSecondsSchema.parse(aggregateTimeoutSeconds);
  const attemptTimeout = TimeoutSecondsSchema.parse(attemptTimeoutSeconds);
  const killAfter = TimeoutSecondsSchema.parse(killAfterSeconds);
  if ((attemptTimeout + killAfter) * 2 >= aggregateTimeout) {
    throw new Error("Aggregate npm timeout must leave time for two attempts and cleanup");
  }
  return `timeout --kill-after=${killAfter}s ${aggregateTimeout}s sh -c 'for attempt in 1 2; do timeout --kill-after=${killAfter}s ${attemptTimeout}s npm ci --include=dev --ignore-scripts --no-audit --no-fund --loglevel warn --fetch-retries 2 --fetch-retry-mintimeout 1000 --fetch-retry-maxtimeout 5000 --fetch-timeout 20000 && exit 0; rm -rf node_modules; done; exit 1'`;
}

export function buildBoundedEvidenceScriptExecutionCommand(
  commitShaInput: string,
  reducerSha256Input: string,
  scriptSha256Input = DaytonaEvidenceScriptSha256,
  options: {
    aggregateTimeoutSeconds?: number;
    killAfterSeconds?: number;
  } = {},
): string {
  const commitSha = CommitShaSchema.parse(commitShaInput);
  const reducerSha256 = Sha256Schema.parse(reducerSha256Input);
  const scriptSha256 = Sha256Schema.parse(scriptSha256Input);
  const aggregateTimeout = TimeoutSecondsSchema.parse(
    options.aggregateTimeoutSeconds ?? EvidenceExecutionTimeoutSeconds,
  );
  const killAfter = TimeoutSecondsSchema.parse(options.killAfterSeconds ?? 5);
  const outerTimeout = aggregateTimeout + killAfter + EvidenceExecutionOuterMarginSeconds;
  if (outerTimeout + killAfter >= 180) {
    throw new Error("Evidence script timeout must leave margin below the provider deadline");
  }
  const python = `import hashlib,pathlib,subprocess,sys; data=pathlib.Path(sys.argv[1]).read_bytes(); hashlib.sha256(data).hexdigest()==sys.argv[2] or sys.exit(3); result=subprocess.run(["timeout","--kill-after=${killAfter}s","${aggregateTimeout}s","sh","-s","--",sys.argv[3],sys.argv[4],sys.argv[5]],input=data); sys.exit(result.returncode)`;
  return `status=0; timeout --kill-after=${killAfter}s ${outerTimeout}s python3 -c '${python}' "$script" '${scriptSha256}' '${commitSha}' '${reducerSha256}' "$work" || status=$?; rm -rf "$root"; exit "$status"`;
}

function buildPrivateEvidenceRootSetupCommand(): string {
  return `umask 077; root=/tmp/projection-witness-launcher.$$; mkdir "$root"; trap 'rm -rf "$root"' EXIT; script="$root/${DaytonaEvidenceScriptName}"; work="$root/work"`;
}

export function buildTrueForgeDaytonaEvidenceCommand(
  commitShaInput: string,
  reducerSha256Input: string,
): string {
  const commitSha = CommitShaSchema.parse(commitShaInput);
  const reducerSha256 = Sha256Schema.parse(reducerSha256Input);
  if (DaytonaLauncherWorstCaseSeconds >= DaytonaProviderExecTimeoutSeconds) {
    throw new Error("Daytona launcher must remain below the provider execution deadline");
  }
  return `set -euo pipefail; ${buildPrivateEvidenceRootSetupCommand()}; timeout --kill-after=${ScriptDownloadKillAfterSeconds}s ${ScriptDownloadTimeoutSeconds}s curl --fail --show-error --location --retry 5 --retry-all-errors --connect-timeout 6 --max-time 6 --retry-max-time 10 --output "$script" 'https://raw.githubusercontent.com/karan68/ProjectionWitness/${commitSha}/scripts/${DaytonaEvidenceScriptName}'; chmod 400 "$script"; ${buildBoundedEvidenceScriptExecutionCommand(commitSha, reducerSha256, DaytonaEvidenceScriptSha256, { aggregateTimeoutSeconds: EvidenceExecutionTimeoutSeconds, killAfterSeconds: EvidenceExecutionKillAfterSeconds })}`;
}
