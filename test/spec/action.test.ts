import * as core from "@actions/core";
import fg from "fast-glob";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../../src/main.js";
import { fetchWorkflowContext, retrieveActionInput, initializeGitHubClient, removeColorCodes } from "../../src/helpers.js";
import { octokitMock } from "../mocks.js";

vi.mock("fast-glob", () => ({
  default: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal()),
  info: vi.fn(),
}));
vi.mock("../../src/helpers.js", async (importOriginal) => {
  const testUtils = await import("../mocks.js");

  return {
    ...(await importOriginal()),
    initializeGitHubClient: vi.fn().mockReturnValue(testUtils.octokitMock),
    fetchWorkflowContext: vi.fn().mockReturnValue({
      repo: {
        owner: "owner",
        repo: "repo",
      },
    }),
    retrieveActionInput: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Allure Report Action Tests", () => {
  describe("Action execution guard conditions", () => {
    it("exits early when GitHub token is missing", async () => {
      (retrieveActionInput as unknown as Mock).mockReturnValue(undefined);
      (fetchWorkflowContext as unknown as Mock).mockReturnValue({});

      await executeAction();

      expect(fg).not.toHaveBeenCalled();
    });

    it("exits early when event is not a pull request", async () => {
      (retrieveActionInput as unknown as Mock).mockReturnValue("foo");
      (fetchWorkflowContext as unknown as Mock).mockReturnValue({
        eventName: "push",
      });

      await executeAction();

      expect(fg).not.toHaveBeenCalled();
    });

    it("exits early when pull request payload is missing", async () => {
      (retrieveActionInput as unknown as Mock).mockReturnValue("foo");
      (fetchWorkflowContext as unknown as Mock).mockReturnValue({
        eventName: "pull_request",
        payload: {},
      });

      await executeAction();

      expect(fg).not.toHaveBeenCalled();
    });
  });

  describe("Report summary generation", () => {
    beforeEach(() => {
      (retrieveActionInput as unknown as Mock).mockImplementation((input: string) => {
        if (input === "report-directory") {
          return "test/fixtures/action";
        }
        if (input === "github-token") {
          return "token";
        }
        return "";
      });
      (fetchWorkflowContext as unknown as Mock).mockReturnValue({
        eventName: "pull_request",
        repo: {
          owner: "owner",
          repo: "repo",
        },
        payload: {
          pull_request: {
            number: 1,
          },
        },
      });
    });

    it("logs info message when no report summaries found", async () => {
      (fg as unknown as Mock).mockResolvedValue([]);
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({ data: [] });

      await executeAction();

      expect(fs.readFile).not.toHaveBeenCalled();
      expect(initializeGitHubClient).toHaveBeenCalledWith("token");
      expect(core.info).toHaveBeenCalledWith("No published reports found");
      expect(octokitMock.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("creates PR comment with report summary", async () => {
      const mockSummary = {
        name: "Test Suite",
        stats: {
          passed: 10,
          failed: 2,
          broken: 1,
        },
        duration: 5000,
        newTests: [],
        flakyTests: [],
        retryTests: [],
      };

      (fg as unknown as Mock).mockResolvedValue(["report1/summary.json"]);
      (fs.readFile as unknown as Mock).mockResolvedValueOnce(JSON.stringify(mockSummary));
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({ data: [] });

      await executeAction();

      expect(fs.readFile).toHaveBeenCalledTimes(1);
      expect(initializeGitHubClient).toHaveBeenCalledWith("token");
      expect(octokitMock.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(octokitMock.rest.issues.createComment.mock.calls[0][0].body).toContain("<!-- allure-report-summary -->");
      expect(octokitMock.rest.issues.createComment.mock.calls[0][0].body).toContain("Allure Report Summary");
    });

    it("updates existing comment instead of creating new one", async () => {
      const existingCommentId = 123456;
      const mockSummary = {
        name: "Test Suite",
        stats: { passed: 10, failed: 2, broken: 1 },
        duration: 5000,
        newTests: [],
        flakyTests: [],
        retryTests: [],
      };

      (fg as unknown as Mock).mockResolvedValue(["report1/summary.json"]);
      (fs.readFile as unknown as Mock).mockResolvedValueOnce(JSON.stringify(mockSummary));
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({
        data: [
          {
            id: existingCommentId,
            body: "<!-- allure-report-summary -->\n# Old Summary",
          },
        ],
      });

      await executeAction();

      expect(octokitMock.rest.issues.createComment).not.toHaveBeenCalled();
      expect(octokitMock.rest.issues.updateComment).toHaveBeenCalledTimes(1);
      expect(octokitMock.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        comment_id: existingCommentId,
        body: expect.stringContaining("<!-- allure-report-summary -->"),
      });
    });
  });

  describe("Quality gate validation", () => {
    beforeEach(() => {
      (retrieveActionInput as unknown as Mock).mockImplementation((input: string) => {
        if (input === "report-directory") return "test/fixtures/quality-gate";
        if (input === "github-token") return "token";
        return "";
      });
      (fetchWorkflowContext as unknown as Mock).mockReturnValue({
        eventName: "pull_request",
        repo: { owner: "owner", repo: "repo" },
        payload: {
          pull_request: {
            number: 1,
            head: { sha: "abc123" },
          },
        },
      });
    });

    it("creates successful check when quality gate passes", async () => {
      const mockSummary = {
        name: "Test Suite",
        stats: { passed: 10, failed: 0, broken: 0 },
        duration: 5000,
        newTests: [],
        flakyTests: [],
        retryTests: [],
      };

      (fg as unknown as Mock).mockResolvedValue(["test/fixtures/quality-gate/summary.json"]);
      (fs.readFile as unknown as Mock)
        .mockResolvedValueOnce(JSON.stringify(mockSummary))
        .mockResolvedValueOnce(JSON.stringify([]));
      (existsSync as unknown as Mock).mockReturnValue(true);
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({ data: [] });

      await executeAction();

      expect(octokitMock.rest.checks.create).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        name: "Allure Quality Gate",
        head_sha: "abc123",
        status: "completed",
        conclusion: "success",
        output: undefined,
      });
    });

    it("creates failed check when quality gate fails", async () => {
      const mockSummary = {
        name: "Test Suite",
        stats: { passed: 8, failed: 2, broken: 0 },
        duration: 5000,
        newTests: [],
        flakyTests: [],
        retryTests: [],
      };
      const qualityGateFailures = [
        {
          rule: "Failed tests threshold",
          message: "\u001b[31mFailed tests: 2 exceeds threshold of 0\u001b[0m",
        },
      ];

      (fg as unknown as Mock).mockResolvedValue(["test/fixtures/quality-gate/summary.json"]);
      (fs.readFile as unknown as Mock)
        .mockResolvedValueOnce(JSON.stringify(mockSummary))
        .mockResolvedValueOnce(JSON.stringify(qualityGateFailures));
      (existsSync as unknown as Mock).mockReturnValue(true);
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({ data: [] });

      await executeAction();

      expect(octokitMock.rest.checks.create).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        name: "Allure Quality Gate",
        head_sha: "abc123",
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Quality Gate",
          summary: expect.stringContaining("Failed tests threshold"),
        },
      });
    });

    it("strips ANSI color codes from quality gate messages", async () => {
      const mockSummary = {
        name: "Test Suite",
        stats: { passed: 8, failed: 2, broken: 0 },
        duration: 5000,
        newTests: [],
        flakyTests: [],
        retryTests: [],
      };
      const qualityGateFailures = [
        {
          rule: "Failed tests threshold",
          message: "\u001b[31mFailed tests: 2 exceeds threshold of 0\u001b[0m",
        },
      ];

      (fg as unknown as Mock).mockResolvedValue(["test/fixtures/quality-gate/summary.json"]);
      (fs.readFile as unknown as Mock)
        .mockResolvedValueOnce(JSON.stringify(mockSummary))
        .mockResolvedValueOnce(JSON.stringify(qualityGateFailures));
      (existsSync as unknown as Mock).mockReturnValue(true);
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({ data: [] });

      await executeAction();

      const summaryOutput = octokitMock.rest.checks.create.mock.calls[0][0].output?.summary;
      expect(summaryOutput).not.toContain("\u001b[31m");
      expect(summaryOutput).not.toContain("\u001b[0m");
      expect(summaryOutput).toContain("Failed tests: 2 exceeds threshold of 0");
    });
  });

  describe("Utility functions", () => {
    it("removes ANSI color codes from text", () => {
      const textWithColors = "\u001b[31mRed text\u001b[0m and \u001b[32mGreen text\u001b[0m";
      const result = removeColorCodes(textWithColors);

      expect(result).toBe("Red text and Green text");
      expect(result).not.toContain("\u001b[31m");
      expect(result).not.toContain("\u001b[0m");
    });

    it("replaces ANSI codes with custom character when specified", () => {
      const textWithColors = "\u001b[31mRed\u001b[0m";
      const result = removeColorCodes(textWithColors, "*");

      expect(result).toBe("*Red*");
    });
  });
});
