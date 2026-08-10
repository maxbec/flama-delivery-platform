import { certifyPreflight } from "./certify.js";
import { mintInstallationToken } from "./github-app-token.js";
import { runPreflight } from "./preflight.js";
import {
  GitHubRestCheckClient,
  publishCheck,
  type DeliveryController,
  type PublishCheckResult,
} from "./publish-check.js";

/**
 * Runs the preflight chain end to end for one pull request head and publishes
 * the `Paperclip Preflight` check the policy gate requires.
 *
 * Each stage already existed — `preflight`, `certify`, `publish-check` — and
 * none of them had a caller, which is why the gate has never once been
 * satisfied by automation. This composes them and adds the two things that were
 * missing between them: an installation token scoped to the target repository,
 * and an observation of the repository itself so the disposition asserted to
 * `publish-check` is checked rather than claimed.
 *
 * Nothing here retries. A failed preflight is a result, not an error, and it is
 * deliberately not published: an unpublished check leaves the gate red, while a
 * wrongly published one asserts evidence that was never observed.
 */

const githubApiVersion = "2026-03-10" as const;

/** Owner is the only input that selects an identity, so the mapping is closed. */
const ownerBindings: Readonly<
  Record<string, { readonly controller: DeliveryController; readonly appSlug: string }>
> = {
  maxbec: { controller: "maxbec-delivery-controller", appSlug: "flama-delivery-maxbec" },
  navigaite: { controller: "navigaite-delivery-controller", appSlug: "flama-delivery-navigaite" },
  "edilio-app": { controller: "edilio-delivery-controller", appSlug: "flama-delivery-edilio" },
};

export type PublishPreflightErrorCode =
  | "preflight_owner_unbound"
  | "preflight_repository_ineligible"
  | "preflight_repository_unreadable";

export class PublishPreflightError extends Error {
  override readonly name = "PublishPreflightError";

  constructor(readonly code: PublishPreflightErrorCode) {
    super("preflight publication refused");
  }
}

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = typeof fetch;

export interface PublishPreflightInput {
  /** `owner/name`, the repository the check will be published against. */
  readonly repository: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly releaseImpact: "none" | "patch" | "minor" | "major";
  /** A clean checkout already at `headSha`; `runPreflight` verifies both. */
  readonly checkoutDirectory: string;
  /** Carries the App credentials; supplied by `infisical run`. */
  readonly environment: Environment;
  readonly runnerId: string;
  readonly fetchImplementation?: FetchImplementation;
  readonly now?: () => Date;
}

export type PublishPreflightResult =
  | { readonly status: "published"; readonly check: PublishCheckResult }
  | {
    readonly status: "preflight_failed";
    readonly failedCommand: string | null;
  };

/**
 * `publish-check` takes the repository disposition as literals it cannot
 * verify, so it is verified here instead. A fork or an archived repository must
 * never receive an app-authored check: the first would let an outside head
 * borrow the controller's authority, the second would write to a repository
 * that is meant to be immutable.
 */
async function assertRepositoryEligible(
  repository: string,
  token: string,
  fetchImplementation: FetchImplementation,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImplementation(`https://api.github.com/repos/${repository}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "flama-delivery-ctl",
        "X-GitHub-Api-Version": githubApiVersion,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PublishPreflightError("preflight_repository_unreadable");
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new PublishPreflightError("preflight_repository_unreadable");
  }
  let observed: unknown;
  try {
    observed = await response.json();
  } catch {
    throw new PublishPreflightError("preflight_repository_unreadable");
  }
  if (typeof observed !== "object" || observed === null) {
    throw new PublishPreflightError("preflight_repository_unreadable");
  }
  const record = observed as Record<string, unknown>;
  if (
    record["fork"] !== false || record["archived"] !== false || record["disabled"] === true ||
    record["full_name"] !== repository
  ) {
    throw new PublishPreflightError("preflight_repository_ineligible");
  }
}

export async function publishPreflight(
  input: PublishPreflightInput,
): Promise<PublishPreflightResult> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const now = input.now ?? (() => new Date());
  const owner = input.repository.split("/")[0];
  const binding = owner === undefined ? undefined : ownerBindings[owner];
  if (binding === undefined) throw new PublishPreflightError("preflight_owner_unbound");

  const run = await runPreflight(
    {
      schemaVersion: 1,
      repository: input.repository,
      headSha: input.headSha,
      baseSha: input.baseSha,
      releaseImpact: input.releaseImpact,
    },
    input.checkoutDirectory,
  );

  if (run.status !== "passed") {
    // Left unpublished on purpose: the gate stays red, which is the honest
    // outcome for a head whose own delivery commands did not pass.
    const failed = run.commands.find((command) => command.status !== "passed");
    return { status: "preflight_failed", failedCommand: failed?.command ?? null };
  }

  const evidence = certifyPreflight({
    run,
    controller: binding.controller,
    appSlug: binding.appSlug,
    runnerId: input.runnerId,
    signedAt: now().toISOString(),
  });

  const token = await mintInstallationToken({
    repository: input.repository,
    environment: input.environment,
    fetchImplementation,
    now,
  });

  await assertRepositoryEligible(input.repository, token.reveal(), fetchImplementation);

  const check = await publishCheck(
    {
      schemaVersion: 1,
      repository: {
        nameWithOwner: input.repository,
        disposition: "in_scope",
        mutationAllowed: true,
        isFork: false,
        isArchived: false,
      },
      publisher: {
        controller: binding.controller,
        appSlug: binding.appSlug,
        tokenScope: "single-repository-checks-write",
        apiVersion: githubApiVersion,
      },
      evidence,
    },
    new GitHubRestCheckClient(
      { FLAMA_GITHUB_APP_INSTALLATION_TOKEN: token.reveal() },
      fetchImplementation,
    ),
  );

  return { status: "published", check };
}
