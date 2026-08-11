import { discoverOpenPullRequests, mintInstallationToken } from "./github-app-token.js";
import { prepareCheckout } from "./repository-checkout.js";
import { publishPreflight } from "./publish-preflight.js";

/**
 * One pass of preflight publication across everything an owner's App can see.
 *
 * This is the caller the chain never had. Discovery reports every open head in
 * the platform-managed repositories; anything already carrying a valid
 * app-authored preflight is skipped before the expensive work, which is what
 * lets the pass run on a timer and settle to near-idle instead of rebuilding
 * every open head forever.
 *
 * A head is processed independently: one repository failing to fetch, or one
 * preflight failing, must not stop the rest. Failures are recorded and
 * returned, never thrown, because a sweep that aborts halfway leaves the
 * remaining heads indistinguishable from heads that were never reached.
 */

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = typeof fetch;

/**
 * Bounds one pass. Preflight clones a head and runs the repository's own
 * delivery commands, so an unbounded pass over a large backlog would run for
 * hours and hold the controller. The remainder is simply picked up next pass.
 */
const defaultMaximumPublications = 10;

/**
 * The other half of the bound, and the one that actually binds. A head's cost
 * is the repository's own delivery commands, which the sweep neither knows nor
 * controls: ten cheap heads finish in a minute and ten expensive ones do not
 * finish at all. Counting heads therefore bounds nothing in wall-clock, which
 * is the dimension the caller's run window is measured in — the first pass
 * whose checkouts genuinely succeeded ran past the controller's timeout and
 * was killed, losing the work it had already done.
 *
 * A head already in flight is never interrupted: cutting one off mid-preflight
 * would waste the whole clone and could leave a check half-published. The
 * budget decides whether to start another, so a pass overruns by at most one
 * head and the rest are reported as deferred.
 */
const defaultBudgetMilliseconds = 180_000;

export interface SweepPreflightsInput {
  readonly owner: string;
  readonly appSlug: string;
  readonly environment: Environment;
  readonly cacheRoot: string;
  readonly runnerId: string;
  readonly maximumPublications?: number;
  /** Wall-clock the pass may spend starting heads. */
  readonly budgetMilliseconds?: number;
  readonly fetchImplementation?: FetchImplementation;
  readonly now?: () => Date;
}

export interface SweepOutcome {
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly status:
    | "published"
    | "preflight_failed"
    | "skipped_fork"
    | "already_published"
    | "failed"
    /** Eligible, not reached within this pass's bounds; the next pass takes it. */
    | "deferred";
  /** An error code for a failure, never a message: messages carry context. */
  readonly code?: string;
}

export async function sweepPreflights(
  input: SweepPreflightsInput,
): Promise<readonly SweepOutcome[]> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const now = input.now ?? (() => new Date());
  const limit = input.maximumPublications ?? defaultMaximumPublications;
  const deadline = now().getTime() + (input.budgetMilliseconds ?? defaultBudgetMilliseconds);

  const heads = await discoverOpenPullRequests(
    input.owner,
    input.appSlug,
    input.environment,
    fetchImplementation,
    now,
  );

  const outcomes: SweepOutcome[] = [];
  let published = 0;

  for (const head of heads) {
    const identity = { repository: head.repository, number: head.number, headSha: head.headSha };

    if (head.hasPreflight) {
      outcomes.push({ ...identity, status: "already_published" });
      continue;
    }
    if (head.isFork) {
      // Publication would refuse it anyway; skipping here keeps the reason
      // legible rather than surfacing as a repository-eligibility failure.
      outcomes.push({ ...identity, status: "skipped_fork" });
      continue;
    }
    // Both bounds report what they left behind. A head dropped silently is
    // indistinguishable from a head that was never eligible, which would read
    // as full coverage the pass did not have.
    if (published >= limit || now().getTime() >= deadline) {
      outcomes.push({ ...identity, status: "deferred" });
      continue;
    }
    published += 1;

    let checkout: Awaited<ReturnType<typeof prepareCheckout>> | undefined;
    try {
      const fetchToken = await mintInstallationToken({
        repository: head.repository,
        environment: input.environment,
        permissions: { contents: "read" },
        fetchImplementation,
        now,
      });
      checkout = await prepareCheckout({
        repository: head.repository,
        headSha: head.headSha,
        cacheRoot: input.cacheRoot,
        token: fetchToken.reveal(),
      });

      const result = await publishPreflight({
        repository: head.repository,
        headSha: head.headSha,
        baseSha: head.baseSha,
        // The sweep does not infer a version bump; release impact belongs to
        // the change, and claiming one here would put it in signed evidence.
        releaseImpact: "none",
        checkoutDirectory: checkout.path,
        environment: input.environment,
        runnerId: input.runnerId,
        fetchImplementation,
        now,
      });

      outcomes.push({
        ...identity,
        status: result.status === "published" ? "published" : "preflight_failed",
      });
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "sweep_failed";
      outcomes.push({ ...identity, status: "failed", code });
    } finally {
      await checkout?.release().catch(() => undefined);
    }
  }

  return outcomes;
}
