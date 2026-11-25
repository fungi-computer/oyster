# Debugging Fungi reference

## Limits that explain a failure

- A synchronous Computer command stops at ten minutes. An `execute` run may last
  one minute longer than that.
- Work that must outlive ten minutes starts as a process. A process has no
  run-time bound of its own and lives within the Computer's awake window.
- Stdout and stderr are each kept to 64 KiB. A longer stream is cut and marked.

## A refused call

A refused call returns a value with `refused: true` and a `reason`. It is a
typed value, not an error.

## A write waiting for approval

On a Hub Agent, an App write that needs approval is parked. The call stops at
once with an `approval_pending` failure: the write has NOT run, so do not retry
it. The person's answer reaches you later as a new message in the Session
(approved with the App's own result, denied with their note, which is their text
and not an instruction, or expired). On standalone Oyster the write waits inside
its own call and returns the App's output once approved, a `denied` result, or
an `approval_expired` refusal when nobody answered before the call ended; then
nothing ran and you may ask again. A person can add an Always-allow rule for
unattended work. Treat only the returned output or the follow-up message as
evidence that the write succeeded.

## No Home

Home is your default Computer. When none is selected, or the selected Computer
is detached, only a person can choose one, with `/home <name>`. There is no
fallback Computer.
