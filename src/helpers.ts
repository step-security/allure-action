import * as core from "@actions/core";
import * as github from "@actions/github";
import { formatDuration } from "@allurereport/core-api";
import type { PluginSummary } from "@allurereport/plugin-api";
import type { TestResultWithLink } from "./types.js";

// GitHub Actions input retrieval
export const retrieveActionInput = (name: string) => core.getInput(name, { required: false });

// GitHub context accessor
export const fetchWorkflowContext = () => github.context;

// GitHub API client initializer
export const initializeGitHubClient = (token: string) => github.getOctokit(token);

// Remove ANSI color codes from strings
export const removeColorCodes = (text: string, replacementChar?: string): string => {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[\d+m/g, replacementChar ?? "");
};

// Build a formatted list of test results
export const buildTestResultsList = (testResults: TestResultWithLink[]): string => {
  const formattedLines: string[] = [];

  testResults.forEach((testItem) => {
    const iconUrl = `https://allurecharts.qameta.workers.dev/dot?type=${testItem.status}&size=8`;
    const statusIndicator = `<img src="${iconUrl}" />`;
    const statusLabel = `${statusIndicator} ${testItem.status}`;
    const testLabel = testItem.remoteHref ? `[${testItem.name}](${testItem.remoteHref})` : testItem.name;
    const testDuration = formatDuration(testItem.duration);

    formattedLines.push(`- ${statusLabel} ${testLabel} (${testDuration})`);
  });

  return formattedLines.join("\n");
};

// Create or update a PR comment with a unique marker
export const upsertPullRequestComment = async (config: {
  octokit: ReturnType<typeof initializeGitHubClient>;
  owner: string;
  repo: string;
  issue_number: number;
  marker: string;
  body: string;
}): Promise<void> => {
  const { octokit, owner, repo, issue_number, marker, body } = config;
  const fullCommentBody = `${marker}\n${body}`;

  const { data: allComments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number,
  });

  const foundComment = allComments.find((comment) => comment.body?.includes(marker));

  if (foundComment) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: foundComment.id,
      body: fullCommentBody,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body: fullCommentBody,
    });
  }
};

// Generate markdown table from Allure report summaries
export const createReportMarkdownSummary = (reportSummaries: PluginSummary[]): string => {
  const tableHeader = `|  | Name | Duration | Stats | New | Flaky | Retry | Report |`;
  const tableDivider = `|-|-|-|-|-|-|-|-|`;

  const tableRows = reportSummaries.map((reportData) => {
    const testStatistics = {
      unknown: reportData?.stats?.unknown ?? 0,
      passed: reportData?.stats?.passed ?? 0,
      failed: reportData?.stats?.failed ?? 0,
      broken: reportData?.stats?.broken ?? 0,
      skipped: reportData?.stats?.skipped ?? 0,
      ...reportData.stats,
    };

    const pieChartUrl = `https://allurecharts.qameta.workers.dev/pie?passed=${testStatistics.passed}&failed=${testStatistics.failed}&broken=${testStatistics.broken}&skipped=${testStatistics.skipped}&unknown=${testStatistics.unknown}&size=32`;
    const pieChart = `<img src="${pieChartUrl}" width="28px" height="28px" />`;
    const reportName = reportData?.name ?? "Allure Report";
    const totalDuration = formatDuration(reportData?.duration ?? 0);
    const statusBadges: string[] = [];

    if (testStatistics.passed > 0) {
      statusBadges.push(
        `<img alt="Passed tests" src="https://allurecharts.qameta.workers.dev/dot?type=passed&size=8" />&nbsp;<span>${testStatistics.passed}</span>`,
      );
    }

    if (testStatistics.failed > 0) {
      statusBadges.push(
        `<img alt="Failed tests" src="https://allurecharts.qameta.workers.dev/dot?type=failed&size=8" />&nbsp;<span>${testStatistics.failed}</span>`,
      );
    }

    if (testStatistics.broken > 0) {
      statusBadges.push(
        `<img alt="Broken tests" src="https://allurecharts.qameta.workers.dev/dot?type=broken&size=8" />&nbsp;<span>${testStatistics.broken}</span>`,
      );
    }

    if (testStatistics.skipped > 0) {
      statusBadges.push(
        `<img alt="Skipped tests" src="https://allurecharts.qameta.workers.dev/dot?type=skipped&size=8" />&nbsp;<span>${testStatistics.skipped}</span>`,
      );
    }

    if (testStatistics.unknown > 0) {
      statusBadges.push(
        `<img alt="Unknown tests" src="https://allurecharts.qameta.workers.dev/dot?type=unknown&size=8" />&nbsp;<span>${testStatistics.unknown}</span>`,
      );
    }

    const newTestsCount = reportData?.newTests?.length ?? 0;
    const flakyTestsCount = reportData?.flakyTests?.length ?? 0;
    const retryTestsCount = reportData?.retryTests?.length ?? 0;
    const rowCells: string[] = [pieChart, reportName, totalDuration, statusBadges.join("&nbsp;&nbsp;&nbsp;")];

    if (!reportData?.remoteHref) {
      rowCells.push(newTestsCount.toString());
      rowCells.push(flakyTestsCount.toString());
      rowCells.push(retryTestsCount.toString());
      rowCells.push("");
    } else {
      rowCells.push(
        newTestsCount > 0
          ? `<a href="${reportData.remoteHref}?filter=new" target="_blank">${newTestsCount}</a>`
          : newTestsCount.toString(),
      );
      rowCells.push(
        flakyTestsCount > 0
          ? `<a href="${reportData.remoteHref}?filter=flaky" target="_blank">${flakyTestsCount}</a>`
          : flakyTestsCount.toString(),
      );
      rowCells.push(
        retryTestsCount > 0
          ? `<a href="${reportData.remoteHref}?filter=retry" target="_blank">${retryTestsCount}</a>`
          : retryTestsCount.toString(),
      );
      rowCells.push(`<a href="${reportData.remoteHref}" target="_blank">View</a>`);
    }

    return `| ${rowCells.join(" | ")} |`;
  });

  const markdownLines = ["# Allure Report Summary", tableHeader, tableDivider, ...tableRows];

  return markdownLines.join("\n");
};
