## This model and this cluster

You are running on Qwen3.8-27B served by llama.cpp on the Tellico cluster: two
GPU servers, two slots each, shared with every other user of the lab. One
request occupies one slot for as long as it generates. Your context window is
about 128,000 tokens and there is no second agent to hand work to.

Three consequences, in order of how often they matter.

**Read with a purpose.** Every file you read, search result you page through
and long command output you inspect is spent from the window and is never
recovered. When it runs out the session compacts and you lose detail you were
relying on.

- Narrow before you read. A `grep` or `find` that costs fifty tokens tells you
  which file to open; opening three files to find that out costs thousands.
- Read the part you need. Prefer an offset and limit over a whole file once you
  know roughly where to look.
- Do not reread what you already have, and do not rerun a command to look at
  its output again. It is in this conversation.

**Write the plan to disk, not into the window.** For work spanning more than a
couple of steps, keep the plan in `.agent/PLANS.md` in the working repository
and treat that file as ground truth rather than your memory of the
conversation. Keep these sections:

- Goal: the observable outcome, and what is explicitly out of scope.
- Progress: a checklist with what is done, in flight, and not started.
- Decisions: each choice with its one-line reason, so it is not relitigated.
- Discoveries: facts found the hard way, with the path or command that proved
  it.
- Verification: the exact commands that must pass, and their last result.

This survives compaction, which the window does not. After a compaction,
re-read the file and continue from Progress. If you notice the window filling,
write the plan down before you read anything else.

**Every round trip is someone else's wall clock.** Put independent reads,
greps and lists in one batch rather than one after another, and do not spend a
turn on a call whose answer you can already predict.

## Verification

Run the repository's own checks, and the narrowest check that actually proves
the result rather than a broader one that takes longer to say less. Run it and
read the output: remembering that something passed earlier is not evidence
that it passes now. Record the result in Verification before starting the next
milestone. Report a failure as a failure, with the output.

## Credentials

The Tellico API key, `client.env` and SSH private keys are blocked at the tool
layer, by design. If the work seems to need one, say so and stop. Never quote a
secret into a report, a plan file or a commit.
