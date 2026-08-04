// The busy / error / done state every page around a submit button was rewriting.
//
// Five pages each hand-rolled the same block: set busy, clear the error, await,
// catch into a readable message, clear busy in a finally. They drifted — some
// cleared the previous error and some did not, and one forgot the finally on an
// early return. One implementation removes the drift and makes "which button is
// spinning" a single value rather than a boolean per button.

import { useCallback, useState } from "react";
import { AccountError } from "../account/accountClient";

/**
 * Turn a thrown value into what the user reads.
 *
 * `AccountError.message` is already human — `accountClient` maps the API's
 * machine codes before throwing — so the default only has to handle everything
 * else, which by definition has no message worth showing.
 */
export type DescribeFailure = (failure: unknown) => string;

const defaultDescribe: DescribeFailure = (failure) =>
  failure instanceof AccountError ? failure.message : "Something went wrong.";

export interface AsyncAction<K extends string> {
  /** Which action is in flight, or null. Compare to disable one button and test another. */
  busy: K | null;
  error: string | null;
  /** True after a run succeeds, cleared when the next one starts. Drives "Saved." */
  done: boolean;
  /**
   * Run `action`, tracking it as `kind`.
   *
   * Never rejects: a failure becomes `error`. Callers are event handlers, and a
   * rejected promise from one is an unhandled rejection nobody sees.
   */
  run: (kind: K, action: () => Promise<void>) => Promise<void>;
}

export function useAsyncAction<K extends string>(
  describe: DescribeFailure = defaultDescribe
): AsyncAction<K> {
  const [busy, setBusy] = useState<K | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const run = useCallback(
    async (kind: K, action: () => Promise<void>) => {
      setBusy(kind);
      setError(null);
      setDone(false);
      try {
        await action();
        setDone(true);
      } catch (failure) {
        setError(describe(failure));
      } finally {
        setBusy(null);
      }
    },
    [describe]
  );

  return { busy, error, done, run };
}
