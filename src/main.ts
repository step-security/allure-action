import * as core from "@actions/core";
import type { PluginSummary, QualityGateValidationResult } from "@allurereport/plugin-api";
import fg from "fast-glob";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import axios, {isAxiosError} from 'axios';
import {
  createReportMarkdownSummary,
  fetchWorkflowContext,
  initializeGitHubClient,
  removeColorCodes,
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
    return;
  }

  if (eventName !== "pull_request" || !payload.pull_request) {
    return;
  }

  const reportsDirectory = retrieveActionInput("report-directory") || path.join(process.cwd(), "allure-report");
  const qualityGateFilePath = path.join(reportsDirectory, "quality-gate.json");
  const discoveredSummaryFiles = await fg([path.join(reportsDirectory, "**", "summary.json")], {
    onlyFiles: true,
  });

  const parsedSummaries = await Promise.all(
    discoveredSummaryFiles.map(async (filePath) => {
      const fileContents = await fs.readFile(filePath, "utf-8");

      return JSON.parse(fileContents) as PluginSummary;
    }),
  );

  let qualityGateValidations: QualityGateValidationResult[] | undefined;

  if (existsSync(qualityGateFilePath)) {
    const qualityGateContent = await fs.readFile(qualityGateFilePath, "utf-8");

    try {
      qualityGateValidations = JSON.parse(qualityGateContent) as QualityGateValidationResult[];
    } catch {}
  }

  const githubClient = initializeGitHubClient(githubToken);

  if (qualityGateValidations) {
    const failureMessages: string[] = [];
    const hasQualityGateFailures = qualityGateValidations.length > 0;

    qualityGateValidations.forEach((validationResult) => {
      failureMessages.push(`**${validationResult.rule}** has failed:`);
      failureMessages.push("```shell");
      failureMessages.push(removeColorCodes(validationResult.message));
      failureMessages.push("```");
      failureMessages.push("");
    });

    githubClient.rest.checks.create({
      owner: repo.owner,
      repo: repo.repo,
      name: "Allure Quality Gate",
      head_sha: payload.pull_request.head.sha,
      status: "completed",
      conclusion: !hasQualityGateFailures ? "success" : "failure",
      output: !hasQualityGateFailures
        ? undefined
        : {
            title: "Quality Gate",
            summary: failureMessages.join("\n"),
          },
    });
  }

  if (!parsedSummaries?.length) {
    core.info("No published reports found");
    return;
  }

  const reportMarkdown = createReportMarkdownSummary(parsedSummaries);
  const pullRequestNumber = payload.pull_request.number;

  await upsertPullRequestComment({
    octokit: githubClient,
    owner: repo.owner,
    repo: repo.repo,
    issue_number: pullRequestNumber,
    marker: "<!-- allure-report-summary -->",
    body: reportMarkdown,
  });
};

if (require.main === module) {
  executeAction();
}

export { executeAction };
