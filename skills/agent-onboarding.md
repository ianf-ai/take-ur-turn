# Agent declaration authoring

Generated from the runtime binding/profile schemas. Update the schemas, then run
`node scripts/release/render-agent-instructions.mjs --write` after compiling.

Read the installed CLI's local `--help` and installation instructions. Choose its
noninteractive fresh invocation with task/tool access. Do not guess flags from
the agent name, use --last/--continue, or invoke another model to infer flags.
A person can fill in the same declaration by hand; another agent is optional.

Minimal complete example (replace the executable and fixed arguments using the
installed CLI's help; the example is not a provider recommendation):

```json
{
  "schema_version": 1,
  "id": "worker-x",
  "command": {
    "executable": "worker-x-cli",
    "argv": [
      "run",
      {
        "slot": "args"
      },
      {
        "slot": "prompt"
      }
    ]
  },
  "input": {
    "kind": "argv"
  }
}
```

From an already running rig with an existing authorized task:

1. `tut agent add worker-x --from -` accepts the JSON on stdin; alternatively
   `tut agent add worker-x --from declaration.json` imports a file.
2. `tut assign executor binding:worker-x` selects the explicit logical id.
3. `tut start-next <task-id>` requests the normal authorized launch.

Import does static validation only, with field paths in errors. Correct the
reported fields and import again. No TTY, run/resume samples, session JSON,
usage declaration, baseline commit, or probe score is required to save.

Strings are literal argv values, including paths with spaces; no shell expansion
is performed. NUL, template code and partial interpolation are rejected. Use
whole-argument slot objects. The args slot may occur at most once; if omitted,
extra route args are rejected. argv input requires exactly one prompt slot;
stdin input forbids it, uses encoding utf8 and sends the raw prompt then EOF.
Cwd is checkoutRoot; inherited environment, PWD and TUT locator/isolation rules
remain host responsibilities. Use a direct executable, or an explicit
interpreter plus fixed script argv; do not use shell -c or script wrappers.

`binding:` is reserved and resolves only config.agent_bindings. Missing/invalid
bindings never fall back to PATH, bundled same-name profiles or agents artifacts.
Unprefixed legacy routes retain their meaning. Static validity does not prove
login, quota, network, tool access, Hub connectivity or successful task delivery.

Optional native session/resume/usage enhancements: describe the complete native
profile using the packaged `dist/agents/profile.schema.json` and the runtime
validator's field diagnostics, then import with
`tut agent setup <id> --from profile.json`. Existing protected native contracts
retain their scope/identity checks. A profile import does not implicitly attach
an enhancement to a basic binding. `tut agent setup <id>` prints import guidance;
`tut agent probe <id>` explicitly runs native diagnostics and may use the model.
Probe failures preserve declarations and run evidence; they do not disable them.

Machine-readable shape schemas ship at `dist/agents/binding.schema.json` and
`dist/agents/profile.schema.json`. Runtime semantic refinements (slots, patterns,
capability consistency and protected native contracts) remain authoritative.

Binding shape, rendered from the runtime schema:

```json
{
  "type": "object",
  "properties": {
    "schema_version": {
      "const": 1,
      "description": "Minimal invocation declaration version."
    },
    "id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,63}$",
      "description": "Logical id, matching the agent add id."
    },
    "command": {
      "type": "object",
      "properties": {
        "executable": {
          "type": "string",
          "description": "One executable; paths with spaces remain one value. Use an explicit interpreter and script for interpreter-based CLIs."
        },
        "argv": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "object",
                "properties": {
                  "slot": {
                    "type": "string",
                    "enum": [
                      "args",
                      "prompt"
                    ]
                  }
                },
                "required": [
                  "slot"
                ],
                "additionalProperties": false
              }
            ]
          },
          "description": "Ordered literal strings or whole-argument slots. No shell, code, or partial interpolation."
        }
      },
      "required": [
        "executable",
        "argv"
      ],
      "additionalProperties": false
    },
    "input": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "argv"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "stdin"
            },
            "encoding": {
              "const": "utf8"
            }
          },
          "required": [
            "kind",
            "encoding"
          ],
          "additionalProperties": false
        }
      ],
      "description": "argv requires exactly one prompt slot; stdin forbids it and sends raw UTF-8 followed by EOF."
    }
  },
  "required": [
    "schema_version",
    "id",
    "command",
    "input"
  ],
  "additionalProperties": false
}
```
