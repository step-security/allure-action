import * as core from "@actions/core";
import type { PluginSummary } from "@allurereport/plugin-api";
import fg from "fast-glob";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import axios, {isAxiosError} from 'axios';
import {
  type EnrichedReportSummary,
  type QualityGateContent,
  SECTION_COMMENT_MARKER_PREFIX,
  assembleSectionComments,
  createReportMarkdownSummary,
  deriveSummaryIdFromPath,
  fetchWorkflowContext,
  formatQualityGateBody,
  hasQualityGateFailures,
  initializeGitHubClient,
  parseEnabledSummarySections,
  removeStaleMarkerComments,
  resolvePerSummaryRemoteHref,
  retrieveActionInput,
  upsertPullRequestComment,
} from "./helpers.js";

type ExternalCheckConclusion = "success" | "failure";

type ExternalCheckSource = {
  remoteHref?: string;
  status: NonNullable<PluginSummary["checks"]>[number]["status"];
  summaryId: string;
  summaryName?: string;
};

type ExternalCheckRun = {
  conclusion: ExternalCheckConclusion;
  name: string;
  sources: ExternalCheckSource[];
};

const isDebugModeEnabled = (input: string): boolean =>
  ["1", "true", "yes", "on"].includes(input.trim().toLowerCase());

const collectExternalCheckRuns = (summaries: EnrichedReportSummary[]): ExternalCheckRun[] => {
  const checkRunMap = new Map<string, ExternalCheckRun>();

  summaries.forEach((summary) => {
    (summary.checks ?? []).forEach((check) => {
      const conclusion: ExternalCheckConclusion = check.status === "passed" ? "success" : "failure";
      const key = check.id?.trim() ?? "";
      const existing = checkRunMap.get(key) ?? { name: check.name, conclusion, sources: [] };

      if (existing.conclusion !== "failure" && conclusion === "failure") {
        existing.conclusion = "failure";
      }

      existing.sources.push({
        remoteHref: summary.remoteHref,
        status: check.status,
        summaryId: summary.summaryId,
        summaryName: summary.name,
      });

      checkRunMap.set(key, existing);
    });
  });

  return [...checkRunMap.values()];
};

const logDiagnosticInfo = (params: {
  debugEnabled: boolean;
  eventName: string;
  headSha: string;
  isPullRequest: boolean;
  qualityGateFilePath: string;
  qualityGateFileExists: boolean;
  qualityGateParseError?: unknown;
  staticRemoteHref?: string;
  reportsDirectory: string;
  externalCheckRuns: ExternalCheckRun[];
  discoveredSummaryFiles: string[];
  enrichedSummaries: EnrichedReportSummary[];
}): void => {
  if (!params.debugEnabled) return;

  const checksCount = params.enrichedSummaries.reduce(
    (acc, summary) => acc + (summary.checks?.length ?? 0),
    0,
  );
  const summariesWithChecks = params.enrichedSummaries.filter(
    (summary) => (summary.checks?.length ?? 0) > 0,
  ).length;

  core.info("[debug] Allure Action diagnostics");
  core.info(`[debug] Event: ${params.eventName || "unknown"}`);
  core.info(`[debug] Pull request event: ${params.isPullRequest}`);
  core.info(`[debug] Head SHA: ${params.headSha}`);
  core.info(`[debug] Report directory: ${params.reportsDirectory}`);
  core.info(`[debug] Remote href: ${params.staticRemoteHref ?? "not provided"}`);
  core.info(`[debug] Summary files found: ${params.discoveredSummaryFiles.length}`);
  core.info(`[debug] Parsed summaries: ${params.enrichedSummaries.length}`);
  core.info(`[debug] Summaries with checks: ${summariesWithChecks}`);
  core.info(`[debug] Checks in summaries: ${checksCount}`);
  core.info(`[debug] Unique checks to create: ${params.externalCheckRuns.length}`);
  core.info(
    `[debug] Unique check names: ${params.externalCheckRuns.map((run) => run.name).join(", ") || "none"}`,
  );
  core.info(`[debug] Quality gate file: ${params.qualityGateFilePath}`);
  core.info(`[debug] Quality gate file exists: ${params.qualityGateFileExists}`);

  if (params.qualityGateParseError) {
    core.info(`[debug] Quality gate parse error: ${String(params.qualityGateParseError)}`);
  }

  if (!params.enrichedSummaries.length) return;

  params.enrichedSummaries.forEach((summary) => {
    const checkNames = (summary.checks ?? []).map((check) => check.name).join(", ") || "none";

    core.info(
      `[debug] Summary "${summary.summaryId}": name="${summary.name ?? "unknown"}", checks=${summary.checks?.length ?? 0}, checkNames=${checkNames}, remoteHref=${summary.remoteHref ?? "not provided"}`,
    );
  });
};

async function validateSubscription(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH
  let repoPrivate: boolean | undefined

  if (eventPath && existsSync(eventPath)) {
    const eventData = JSON.parse(readFileSync(eventPath, 'utf8'))
    repoPrivate = eventData?.repository?.private
  }

  const upstream = 'allure-framework/allure-action'
  const action = process.env.GITHUB_ACTION_REPOSITORY
  const docsUrl =
    'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions'

  core.info('')
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m')
  core.info(`Secure drop-in replacement for ${upstream}`)
  if (repoPrivate === false)
    core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m')
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`)
  core.info('')

  if (repoPrivate === false) return

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const body: Record<string, string> = {action: action || ''}
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      {timeout: 3000}
    )
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`
      )
      core.error(
        `\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`
      )
      process.exit(1)
    }
    core.info('Timeout or API not reachable. Continuing to next step.')
  }
}

const executeAction = async (): Promise<void> => {
  await validateSubscription();
  const githubToken = retrieveActionInput("github-token");
  const workflowContext = fetchWorkflowContext();
  const { eventName, repo, payload, sha } = workflowContext;

  if (!githubToken) {
    core.error("No GitHub token provided");
    return;
  }

  const pullRequest = payload?.pull_request;
  const isPullRequest = eventName === "pull_request" && Boolean(pullRequest);
  const headSha = pullRequest?.head?.sha ?? sha ?? "";
  const reportsDirectory =
    retrieveActionInput("report-directory") || path.posix.join(process.cwd(), "allure-report");
  const staticRemoteHref = retrieveActionInput("remote-href") || undefined;
  const enabledSections = parseEnabledSummarySections(retrieveActionInput("sections"));
  const debugEnabled = isDebugModeEnabled(retrieveActionInput("debug"));
  const qualityGateFilePath = path.posix.join(reportsDirectory, "quality-gate.json");
  const discoveredSummaryFiles = await fg(
    [path.posix.join(reportsDirectory, "**", "summary.json")],
    { onlyFiles: true },
  );

  const enrichedSummaries = (await Promise.all(
    discoveredSummaryFiles.map(async (filePath) => {
      const fileContents = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(fileContents) as PluginSummary;

      return {
        ...parsed,
        summaryId: deriveSummaryIdFromPath(reportsDirectory, filePath),
        remoteHref: resolvePerSummaryRemoteHref({
          reportDir: reportsDirectory,
          summaryFilePath: filePath,
          inputRemoteHref: staticRemoteHref,
          summaryRemoteHref: parsed.remoteHref,
        }),
      } as EnrichedReportSummary;
    }),
  )) as EnrichedReportSummary[];

  const externalCheckRuns = collectExternalCheckRuns(enrichedSummaries);
  let qualityGateContent: QualityGateContent | undefined;
  let qualityGateParseError: unknown;
  const qualityGateFileExists = existsSync(qualityGateFilePath);

  if (qualityGateFileExists) {
    const rawQualityGate = await fs.readFile(qualityGateFilePath, "utf-8");

    try {
      qualityGateContent = JSON.parse(rawQualityGate) as QualityGateContent;
    } catch (error) {
      qualityGateParseError = error;
    }
  }

  logDiagnosticInfo({
    debugEnabled,
    eventName,
    headSha,
    isPullRequest,
    qualityGateFilePath,
    qualityGateFileExists,
    qualityGateParseError,
    staticRemoteHref,
    reportsDirectory,
    externalCheckRuns,
    discoveredSummaryFiles,
    enrichedSummaries,
  });

  const githubClient = initializeGitHubClient(githubToken);

  if (qualityGateContent) {
    core.info("Quality gate results found, checking status");
    const failed = hasQualityGateFailures(qualityGateContent);

    await githubClient.rest.checks.create({
      owner: repo.owner,
      repo: repo.repo,
      name: "Allure Quality Gate",
      head_sha: headSha,
      status: "completed",
      conclusion: !failed ? "success" : "failure",
      output: !failed
        ? undefined
        : {
            title: "Quality Gate",
            summary: formatQualityGateBody(qualityGateContent),
          },
    });
  }

  await Promise.all(
    externalCheckRuns.map(async (checkRun) => {
      if (debugEnabled) {
        core.info(
          `[debug] Creating check "${checkRun.name}" with conclusion "${checkRun.conclusion}" from ${checkRun.sources.length} source(s)`,
        );
      }

      const response = await githubClient.rest.checks.create({
        owner: repo.owner,
        repo: repo.repo,
        name: `Allure external check: ${checkRun.name}`,
        head_sha: headSha,
        status: "completed",
        conclusion: checkRun.conclusion,
      });

      if (debugEnabled) {
        core.info(
          `[debug] Created check "${checkRun.name}": id=${response?.data?.id ?? "unknown"}, htmlUrl=${response?.data?.html_url ?? "not provided"}`,
        );
      }
    }),
  );

  if (!enrichedSummaries?.length) {
    core.info("No published reports found");
    return;
  }

  if (!isPullRequest || !pullRequest) {
    core.info("Not a pull request event, skipping comments");
    return;
  }

  const pullRequestNumber = pullRequest.number;
  const { data: existingComments } = await githubClient.rest.issues.listComments({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: pullRequestNumber,
  });

  const reportMarkdown = createReportMarkdownSummary(enrichedSummaries);
  const sectionComments = assembleSectionComments(enrichedSummaries, enabledSections);

  await upsertPullRequestComment({
    octokit: githubClient,
    owner: repo.owner,
    repo: repo.repo,
    issue_number: pullRequestNumber,
    marker: "<!-- allure-report-summary -->",
    body: reportMarkdown,
    existingComments,
  });

  await Promise.all(
    sectionComments.map((comment) =>
      upsertPullRequestComment({
        octokit: githubClient,
        owner: repo.owner,
        repo: repo.repo,
        issue_number: pullRequestNumber,
        marker: comment.marker,
        body: comment.body,
        existingComments,
      }),
    ),
  );

  await removeStaleMarkerComments({
    octokit: githubClient,
    owner: repo.owner,
    repo: repo.repo,
    existingComments,
    prefix: SECTION_COMMENT_MARKER_PREFIX,
    keepMarkers: new Set(sectionComments.map((comment) => comment.marker)),
  });
};

if (require.main === module) {
  executeAction();
}

export { executeAction };
