import { defineConfig } from "allure";
import { env } from "node:process";

// Configuration builder for Allure reporting
const buildReportConfiguration = () => {
  const serviceToken = env.ALLURE_SERVICE_ACCESS_TOKEN;

  const reportSettings = {
    output: "./out/allure-report",
    plugins: {
      awesome: {
        options: {
          singleFile: false,
          reportLanguage: "en",
          reportName: "Allure Action",
          open: false,
          publish: true,
        },
      },
      log: {
        options: {
          groupBy: "none",
        },
      },
    },
  };

  // Add service configuration when token is available
  if (serviceToken) {
    reportSettings.allureService = {
      accessToken: serviceToken,
    };
  }

  return reportSettings;
};

export default defineConfig(buildReportConfiguration());
