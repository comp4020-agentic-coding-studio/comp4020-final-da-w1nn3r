import type { TestProject } from "vitest/node";
import { adminProblem, clearLedger, deleteAccounts, recorded } from "./cleanup.ts";

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
  }
}

// The spec checks a RUNNING app over HTTP, so it holds whatever the app is
// built with. CI builds the Dockerfile, starts the image and points APP_URL
// at it, so what passes there is what deploys. Locally, start your app however
// you run it, then `pnpm check`; APP_URL says where it's listening. It waits
// up to a minute, since some stacks take a while to boot or migrate.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const baseUrl = process.env.APP_URL ?? "http://localhost:8080";

  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(baseUrl);
      break;
    } catch {
      // not up yet
    }
    if (attempt >= 300) {
      throw new Error(
        `nothing is answering at ${baseUrl}: start your app first, or set APP_URL to where it's listening`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Fail now, before any test registers an account it could not delete afterwards.
  const token = process.env.ADMIN_TOKEN;
  const problem = await adminProblem(baseUrl, token);
  if (problem) throw new Error(`cannot run the specs: ${problem}`);

  // Accounts a crashed or killed earlier run left behind, then the same sweep again once this run is over.
  const sweep = async (): Promise<void> => {
    const left = await deleteAccounts(baseUrl, token!, recorded(baseUrl));
    if (left) console.warn(`cleanup: ${left} test account(s) could not be deleted`);
    else clearLedger(baseUrl);
  };
  await sweep();

  project.provide("baseUrl", baseUrl);
  return sweep;
}
