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
  const { eventName, repo, payload } = workflowContext;

  if (!githubToken) {
    core.error("No GitHub token provided");
    return;
  }

  if (eventName !== "pull_request" || !payload.pull_request) {
    core.info("Not a pull request event, skipping");
    return;
  }

  const reportsDirectory = retrieveActionInput("report-directory") || path.join(process.cwd(), "allure-report");
  const staticRemoteHref = retrieveActionInput("remote-href") || undefined;
  const enabledSections = parseEnabledSummarySections(retrieveActionInput("sections"));
  const qualityGateFilePath = path.join(reportsDirectory, "quality-gate.json");
  const discoveredSummaryFiles = await fg([path.join(reportsDirectory, "**", "summary.json")], {
    onlyFiles: true,
  });

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

  let qualityGateContent: QualityGateContent | undefined;

  if (existsSync(qualityGateFilePath)) {
    const rawQualityGate = await fs.readFile(qualityGateFilePath, "utf-8");

    try {
      qualityGateContent = JSON.parse(rawQualityGate) as QualityGateContent;
    } catch {}
  }

  const githubClient = initializeGitHubClient(githubToken);

  if (qualityGateContent) {
    core.info("Quality gate results found, checking status");
    const failed = hasQualityGateFailures(qualityGateContent);

    githubClient.rest.checks.create({
      owner: repo.owner,
      repo: repo.repo,
      name: "Allure Quality Gate",
      head_sha: payload.pull_request.head.sha,
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

  if (!enrichedSummaries?.length) {
    core.info("No published reports found");
    return;
  }

  const pullRequestNumber = payload.pull_request.number;
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
